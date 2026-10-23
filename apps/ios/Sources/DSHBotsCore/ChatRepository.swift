import Foundation
import Observation

@MainActor @Observable public final class ChatRepository {
    public private(set) var hosts: [TrustedHost] = []
    public private(set) var selectedHostId: String?
    public private(set) var bootstrap: JSON = .null
    public private(set) var rooms: [String: JSON] = [:]
    public private(set) var outbox: [JSON] = []
    public private(set) var nativeActivities: [String: JSON] = [:]
    public private(set) var phase = "unpaired"
    public var error: String?
    public var selectedRoomId: String?
    public let store: LocalStore
    private var connection: HostConnection?
    private var lifetime: Task<Void, Never>?
    private var generation = UUID()
    private var flushing = false
    private var foreground = true
    private var eventRevision = 0
    private var streamMutations: [String: (revision: Int, stream: JSON)] = [:]
    public var host: TrustedHost? { hosts.first { $0.id == selectedHostId } }
    public var isOwner: Bool { bootstrap["person"]["hostRole"].string == "owner" }
    public var online: Bool { phase == "online" }
    public init(store: LocalStore, hosts: [TrustedHost]? = nil) throws { self.store = store; self.hosts = try hosts ?? KeychainVault.load() }
    private func saveHost(_ host: TrustedHost) throws {
        var next = hosts.filter { $0.id != host.id }; next.append(host); try KeychainVault.save(next); hosts = next
    }
    public func select(_ id: String) async {
        await suspend(); selectedHostId = id; nativeActivities = [:]; streamMutations = [:]; bootstrap = .null; rooms = [:]; outbox = []; selectedRoomId = nil
        guard let host else { phase = "unpaired"; return }
        do { bootstrap = try store.get(host.scope, "bootstrap", "current") ?? .null; for room in try store.list(host.scope, "room") { rooms[room["room"].id] = room }; outbox = try store.list(host.scope, "outbox") }
        catch { self.error = error.localizedDescription }
        foreground = true; resume()
    }
    public func suspend() async {
        foreground = false; generation = UUID(); lifetime?.cancel(); lifetime = nil
        let old = connection; connection = nil; await old?.close(); phase = host == nil ? "unpaired" : "offline"
    }
    public func resume() {
        foreground = true; guard lifetime == nil, host != nil else { return }
        let gen = UUID(); generation = gen
        lifetime = Task { [weak self] in
            guard let self else { return }
            var failures = 0
            while !Task.isCancelled && self.generation == gen && self.foreground {
                do { try await self.run(gen); failures = 0 }
                catch {
                    guard !Task.isCancelled, self.generation == gen else { return }
                    self.error = error.localizedDescription
                    if let e = error as? HostError, ["DEVICE_REVOKED", "PERSON_REVOKED", "UNAUTHORIZED", "TOKEN_EXPIRED", "PROTOCOL_UNSUPPORTED", "CERTIFICATE_MISMATCH", "CERTIFICATE_INVALID"].contains(e.code) {
                        self.phase = e.code.hasPrefix("CERTIFICATE") ? "untrusted" : e.code == "PROTOCOL_UNSUPPORTED" ? "incompatible" : "revoked"
                        await self.connection?.close(); self.connection = nil; self.lifetime = nil; return
                    }
                    self.phase = "offline"; failures += 1
                }
                await self.connection?.close(); self.connection = nil
                let seconds = min(30.0, pow(2, Double(min(failures, 5)))) * Double.random(in: 0.8...1.2)
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            }
        }
    }
    private func check(_ gen: UUID) throws { guard gen == generation && !Task.isCancelled else { throw CancellationError() } }
    private func run(_ gen: UUID) async throws {
        guard var host else { return }; phase = "connecting"
        var connected: HostConnection?, lastError: Error = HostError("OFFLINE", "无法连接电脑", retryable: true)
        for address in host.addresses {
            let c = try HostConnection(address: address, fingerprint: host.fingerprint, token: host.credentials["accessToken"].string)
            do {
                let health = try await c.request("v1/health", authenticated: false); try check(gen)
                guard health["protocol"].int == 1 else { throw HostError("PROTOCOL_UNSUPPORTED", "电脑协议不兼容") }
                connected = c; break
            } catch { await c.close(); lastError = error; try check(gen) }
        }
        guard let c = connected else { throw lastError }; connection = c; phase = "authenticating"
        if (wireDate(host.credentials["accessExpiresAt"].string) ?? .distantPast).timeIntervalSinceNow < 60 {
            let credentials = try await c.request("v1/refresh", body: .object(["refreshToken": host.credentials["refreshToken"]]), authenticated: false)
            try check(gen); guard credentials["hostId"].string == host.id, credentials["principal"]["personId"] == host.credentials["principal"]["personId"] else { throw HostError("UNAUTHORIZED", "电脑身份不匹配") }
            let oldScope = host.scope; host.credentials = credentials; try saveHost(host)
            if oldScope != host.scope { try store.purgeScope(oldScope); rooms = [:]; outbox = [] }
            await c.setToken(credentials["accessToken"].string)
        }
        phase = "syncing"
        try await refreshBootstrap(c, gen)
        guard let current = self.host else { throw CancellationError() }
        try await c.openSocket(hostId: current.id, epoch: current.credentials["storeEpoch"].string); try check(gen)
        for room in bootstrap["rooms"].array {
            try await syncRoom(room.id, c, gen)
            try await c.subscribe(room.id, after: rooms[room.id]?["cutoff"].int ?? 0, epoch: current.credentials["storeEpoch"].string)
        }
        try check(gen); phase = "online"; error = nil
        Task { await self.flush() }
        var subscribed = Set(bootstrap["rooms"].array.map(\.id))
        // Rotation reconnects before the short-lived access token expires.
        let expiry = wireDate(current.credentials["accessExpiresAt"].string) ?? Date().addingTimeInterval(600)
        let renewal = Task { try? await Task.sleep(for: .seconds(max(1, expiry.timeIntervalSinceNow - 45))); if !Task.isCancelled { await c.close() } }
        defer { renewal.cancel() }
        while true {
            let event = try await c.receive(); try check(gen)
            if event["kind"].string == "error" { let e = event["error"]; throw HostError(e["code"].string, e["message"].string) }
            if event["kind"].string != "event" { continue }
            let id = event["roomId"].string
            if event["type"].string == "room.access.revoked" {
                subscribed.remove(id); try purgeRoom(id); try await refreshBootstrap(c, gen); continue
            }
            if event["type"].string == "session.activity" { let activity = event["payload"]; nativeActivities[activity["bindingId"].string] = activity; continue }
            if event["type"].string == "stream.updated" { applyStream(event["payload"]); continue }
            if !id.isEmpty {
                if event["seq"].int > (rooms[id]?["cutoff"].int ?? 0) || event["seq"] == .null { try await syncRoom(id, c, gen) }
            } else {
                try await refreshBootstrap(c, gen)
                let allowed = Set(bootstrap["rooms"].array.map(\.id))
                for id in subscribed.subtracting(allowed) { try await c.send(.object(["kind": .string("unsubscribe"), "roomId": .string(id)])); subscribed.remove(id) }
                for room in bootstrap["rooms"].array where !subscribed.contains(room.id) {
                    try await syncRoom(room.id, c, gen); try await c.subscribe(room.id, after: rooms[room.id]?["cutoff"].int ?? 0, epoch: current.credentials["storeEpoch"].string); subscribed.insert(room.id)
                }
            }
        }
    }
    private func refreshBootstrap(_ c: HostConnection, _ gen: UUID) async throws {
        let value = try await c.request("v1/bootstrap"); try check(gen)
        guard var host, value["version"]["major"].int == 1, value["hostId"].string == host.id, value["person"].id == host.credentials["principal"]["personId"].string else { throw HostError("PROTOCOL_UNSUPPORTED", "电脑身份或协议不匹配") }
        if value["storeEpoch"] != host.credentials["storeEpoch"] {
            try store.purgeScope(host.scope); rooms = [:]; outbox = []; host.credentials["storeEpoch"] = value["storeEpoch"]
        }
        host.name = value["hostName"].string; try saveHost(host)
        let allowed = Set(value["rooms"].array.map(\.id))
        for id in Set(rooms.keys).union(outbox.map { $0["roomId"].string }) where !allowed.contains(id) { try purgeRoom(id) }
        try store.put(host.scope, "bootstrap", "current", value); bootstrap = value
    }
    private func syncRoom(_ id: String, _ c: HostConnection, _ gen: UUID) async throws {
        do {
            let streamRevision = eventRevision
            var snapshot = try await c.request("v1/snapshot", query: ["roomId": id]); try check(gen)
            guard let host else { return }
            // A concurrent UI refresh may already have committed a newer snapshot.
            if snapshot["cutoff"].int < (rooms[id]?["cutoff"].int ?? 0) { return }
            let old = rooms[id]?["messages"].array ?? []
            var incoming = snapshot["messages"].array
            if let last = old.last?["seq"].int, var before = incoming.first?["seq"].int {
                while before > last {
                    let page = try await c.request("v1/history", query: ["roomId": id, "beforeSeq": String(before), "limit": "100"]); try check(gen)
                    let older = page["messages"].array
                    guard let next = older.first?["seq"].int, next < before else { break }
                    incoming = mergeMessages(older, incoming); before = next
                }
            }
            try check(gen)
            snapshot["messages"] = .array(mergeMessages(rooms[id]?["messages"].array ?? old, incoming))
            var streams = snapshot["streams"].array
            for mutation in streamMutations.values where mutation.revision > streamRevision && mutation.stream["roomId"].string == id {
                streams.removeAll { $0["messageId"] == mutation.stream["messageId"] }
                if !mutation.stream["text"].string.isEmpty { streams.append(mutation.stream) }
            }
            snapshot["streams"] = .array(streams)
            if snapshot["cutoff"].int < (rooms[id]?["cutoff"].int ?? 0) { return }
            try store.commitSnapshot(host.scope, snapshot); rooms[id] = snapshot; outbox = try store.list(host.scope, "outbox")
            var list = bootstrap["rooms"].array
            if let i = list.firstIndex(where: { $0.id == id }) { list[i] = snapshot["room"]; bootstrap["rooms"] = .array(list); try store.put(host.scope, "bootstrap", "current", bootstrap) }
            _ = try await c.command("sync.ack", .object(["roomId": .string(id), "seq": snapshot["cutoff"]])); try check(gen)
        } catch let e as HostError where ["FORBIDDEN", "NOT_FOUND", "ROOM_ACCESS_DENIED", "NOT_MEMBER", "NOT_ROOM_MEMBER", "ROOM_NOT_FOUND"].contains(e.code) { try check(gen); try purgeRoom(id) }
    }
    private func applyStream(_ stream: JSON) {
        let id = stream["roomId"].string; guard var room = rooms[id] else { return }
        var list = room["streams"].array
        if let old = list.first(where: { $0["messageId"] == stream["messageId"] }), old["attemptId"] == stream["attemptId"],
           old["streamRevision"].int > stream["streamRevision"].int || (old["streamRevision"] == stream["streamRevision"] && old["index"].int > stream["index"].int) { return }
        eventRevision += 1; streamMutations[id + "/" + stream["messageId"].string] = (eventRevision, stream)
        if streamMutations.count > 512 { let cutoff = eventRevision - 256; streamMutations = streamMutations.filter { $0.value.revision >= cutoff } }
        list.removeAll { $0["messageId"] == stream["messageId"] }
        if !stream["text"].string.isEmpty { list.append(stream) }; room["streams"] = .array(list); rooms[id] = room
    }
    private func purgeRoom(_ id: String) throws {
        guard let host else { return }; try store.purgeRoom(host.scope, id); rooms[id] = nil; outbox = try store.list(host.scope, "outbox")
        bootstrap["rooms"] = .array(bootstrap["rooms"].array.filter { $0.id != id }); if selectedRoomId == id { selectedRoomId = nil }
    }
    public func draft(_ id: String) -> JSON { guard let host else { return .null }; return (try? store.get(host.scope, "draft", id)) ?? .null }
    public func saveDraft(_ id: String, _ draft: JSON) { guard let host else { return }; do { try store.put(host.scope, "draft", id, draft) } catch { self.error = error.localizedDescription } }
    public func send(_ room: String, draft: JSON) async throws {
        guard let host else { throw HostError("UNPAIRED", "请先连接电脑") }
        _ = try store.enqueue(host.scope, roomId: room, draft: draft); outbox = try store.list(host.scope, "outbox"); Task { await self.flush() }
    }
    public func retryPending(_ id: String) async {
        guard let host, var item = outbox.first(where: { $0.id == id }) else { return }
        do { item["error"] = .null; try store.put(host.scope, "outbox", id, item); outbox = try store.list(host.scope, "outbox"); await flush() } catch { self.error = error.localizedDescription }
    }
    public func discardPending(_ id: String) throws { guard let host else { return }; try store.remove(host.scope, "outbox", id); outbox = try store.list(host.scope, "outbox") }
    private func flush() async {
        guard !flushing, online, let c = connection, let host else { return }; flushing = true; defer { flushing = false }
        let gen = generation
        while online, gen == generation, let item = outbox.first(where: { $0["error"] == .null }) {
            do {
                var payload: JSON = .object(["clientMessageId": .string(item.id), "roomId": item["roomId"], "parts": item["parts"]]); if item["replyToMessageId"] != .null { payload["replyToMessageId"] = item["replyToMessageId"] }
                _ = try await c.command("message.send", payload, id: item.id); try check(gen)
                try store.remove(host.scope, "outbox", item.id); outbox = try store.list(host.scope, "outbox")
                try await syncRoom(item["roomId"].string, c, gen)
            } catch {
                guard gen == generation else { return }
                if let e = error as? HostError, !e.retryable {
                    var failed = item; failed["error"] = .string(e.message)
                    do { try store.put(host.scope, "outbox", item.id, failed); outbox = try store.list(host.scope, "outbox") } catch { self.error = error.localizedDescription; return }
                } else { self.error = error.localizedDescription; await c.close(); return }
            }
        }
    }
    @discardableResult public func command(_ type: String, _ payload: JSON) async throws -> JSON {
        guard online, let c = connection else { throw HostError("OFFLINE", "电脑离线，请连接后操作") }
        let gen = generation, result = try await c.command(type, payload); try check(gen)
        try await refreshBootstrap(c, gen)
        if let id = selectedRoomId { try await syncRoom(id, c, gen) }
        return result
    }
    public func history(_ id: String, search: String? = nil) async throws -> [JSON] {
        guard online, let c = connection else { return (rooms[id]?["messages"].array ?? []).filter { search == nil || $0["text"].string.localizedCaseInsensitiveContains(search!) } }
        let gen = generation
        var query = ["roomId": id, "limit": "100"]
        if let search { query["search"] = search } else if let seq = rooms[id]?["messages"].array.first?["seq"].int { query["beforeSeq"] = String(seq) }
        let result = try await c.request("v1/history", query: query); try check(gen)
        let messages = result["messages"].array
        if search == nil, var room = rooms[id], let host { room["messages"] = .array(mergeMessages(messages, room["messages"].array)); try store.commitSnapshot(host.scope, room); rooms[id] = room }
        return messages
    }
    public func forget(_ id: String) async throws {
        if selectedHostId == id { await suspend() }
        if let host = hosts.first(where: { $0.id == id }) { try store.purgeScope(host.scope) }
        let next = hosts.filter { $0.id != id }; try KeychainVault.save(next); hosts = next
        if selectedHostId == id { selectedHostId = nil; rooms = [:]; bootstrap = .null; outbox = []; phase = "unpaired" }
    }
    public func join(_ input: String, name: String, deviceName: String) async throws {
        let invite = try Invitation.parse(input)
        let request = try KeychainVault.attempt(for: input)
        let existing = hosts.first { $0.id == invite.hostId }
        // Stop streams before invitation rotates this device's credentials.
        if selectedHostId == invite.hostId { await suspend() }
        var lastError: Error = HostError("OFFLINE", "无法连接电脑")
        for address in invite.addresses {
            let c = try HostConnection(address: address, fingerprint: invite.fingerprint, token: existing?.credentials["accessToken"].string)
            do {
                let health = try await c.request("v1/health", authenticated: false)
                guard health["protocol"].int == 1, health["features"].array.contains(.string("receipt-only")) else { throw HostError("PROTOCOL_UNSUPPORTED", "请将电脑 DSH Bots 更新到支持 iOS 邀请恢复的版本") }
                let body: JSON = .object(["token": .string(invite.token), "displayName": .string(name), "deviceName": .string(deviceName), "requestId": .string(request.id), "deviceChallenge": .string(request.challenge)])
                let creds: JSON
                do {
                    // A successful join rotates credentials. Recover a lost response via the
                    // persisted challenge, without presenting the now-invalid old bearer.
                    var recovery = body; recovery["receiptOnly"] = .bool(true)
                    do { creds = try await c.request("v1/invite", body: recovery, authenticated: false) }
                    catch let e as HostError where e.code == "REQUEST_NOT_FOUND" {
                        if var value = existing, (wireDate(value.credentials["accessExpiresAt"].string) ?? .distantPast).timeIntervalSinceNow < 60 {
                            value.credentials = try await c.request("v1/refresh", body: .object(["refreshToken": value.credentials["refreshToken"]]), authenticated: false)
                            try saveHost(value); await c.setToken(value.credentials["accessToken"].string)
                        }
                        creds = try await c.request("v1/invite", body: body)
                    }
                }
                guard creds["hostId"].string == invite.hostId, creds["storeEpoch"].string == invite.storeEpoch,
                      existing == nil || creds["principal"]["personId"] == existing?.credentials["principal"]["personId"] else { throw HostError("UNAUTHORIZED", "邀请身份不匹配") }
                let host = TrustedHost(id: invite.hostId, name: existing?.name ?? "DSH", addresses: invite.addresses, fingerprint: invite.fingerprint, credentials: creds)
                if let existing, existing.scope != host.scope { try store.purgeScope(existing.scope) }
                try saveHost(host); try KeychainVault.clearAttempt(); await c.close(); await select(host.id); selectedRoomId = invite.roomId.isEmpty ? nil : invite.roomId; return
            } catch { lastError = error; await c.close(); if let e = error as? HostError, !e.retryable { throw e } }
        }
        throw lastError
    }
}
