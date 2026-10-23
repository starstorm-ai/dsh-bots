import Foundation
import Testing
@testable import DSHBotsCore

func json(_ text: String) throws -> JSON { try JSON.decode(Data(text.utf8)) }
struct CoreTests {
    @Test func protocolPreservesUnknownFieldsAndUnicode() throws {
        let value = try json(#"{"id":"one","text":"中文 👋","future":{"v":[true,null,42]},"parts":[{"type":"mention","botId":"b","label":"鲸鱼"},{"type":"text","text":"你好"}]}"#)
        #expect(try JSON.decode(value.data()) == value)
        #expect(displayedText(value) == "@鲸鱼 你好")
    }
    @Test func validatesInvitationsAndTrustBoundary() throws {
        var value: JSON = .object(["protocol": .number(1), "kind": .string("invite"), "hostId": .string("host"), "storeEpoch": .string("epoch"), "addresses": .strings(["https://192.168.1.10:49210", "https://[::1]:49210"]), "fingerprint": .string(String(repeating: "a", count: 64)), "token": .string("test"), "expiresAt": .string("2099-01-01T00:00:00Z"), "roomId": .string("room"), "historyVisibility": .string("full")])
        func encoded(_ v: JSON) throws -> String { String(decoding: try v.data(), as: UTF8.self) }
        let invite = try Invitation.parse(encoded(value)); #expect(invite.hostId == "host")
        var url = URLComponents(); url.scheme = "dshbots"; url.host = "invite"; url.queryItems = [URLQueryItem(name: "data", value: try encoded(value))]
        #expect(try Invitation.parse(url.string!).fingerprint == invite.fingerprint)
        for address in ["http://192.168.1.2", "https://user:pass@host", "https://host/path", "https://host?token=secret", "https://host#fragment", "https://host:99999"] { var bad = value; bad["addresses"] = .strings([address]); #expect(throws: (any Error).self) { try Invitation.parse(encoded(bad)) } }
        value["protocol"] = .number(2); #expect(throws: (any Error).self) { try Invitation.parse(encoded(value)) }
        value["protocol"] = .number(1); value["expiresAt"] = .string("2000-01-01T00:00:00Z"); #expect(throws: (any Error).self) { try Invitation.parse(encoded(value)) }
    }
    @Test @MainActor func durableOutboxDraftAndAcknowledgementSurviveRestart() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url); try? FileManager.default.removeItem(atPath: url.path + "-wal"); try? FileManager.default.removeItem(atPath: url.path + "-shm") }
        let draft = try json(#"{"text":"offline message","parts":[{"type":"text","text":"offline message"}],"mentions":[]}"#)
        var store: LocalStore? = try LocalStore(path: url.path)
        try store!.put("host:person:epoch", "draft", "room", draft)
        let pending = try store!.enqueue("host:person:epoch", roomId: "room", draft: draft)
        #expect(try store!.get("host:person:epoch", "draft", "room") == nil)
        store = nil
        let reopened = try LocalStore(path: url.path)
        #expect(try reopened.list("host:person:epoch", "outbox").first?.id == pending.id)
        #expect(try reopened.list("host:other:epoch", "outbox").isEmpty)
        var snapshot = try json(#"{"room":{"id":"room"},"messages":[],"cutoff":7}"#)
        snapshot["messages"] = .array([.object(["id": .string("server-message"), "clientMessageId": .string(pending.id)])])
        try reopened.commitSnapshot("host:person:epoch", snapshot)
        #expect(try reopened.list("host:person:epoch", "outbox").isEmpty)
        #expect(try reopened.get("host:person:epoch", "room", "room")?["cutoff"].int == 7)
    }
    @Test @MainActor func transactionRollbackAndRevocation() throws {
        let store = try LocalStore(path: ":memory:")
        let draft = try json(#"{"text":"test","parts":[{"type":"text","text":"test"}]}"#)
        #expect(throws: (any Error).self) { try store.transaction { try store.put("scope", "draft", "room", draft); throw HostError("TEST", "rollback") } }
        #expect(try store.get("scope", "draft", "room") == nil)
        _ = try store.enqueue("scope", roomId: "room", draft: draft)
        _ = try store.enqueue("scope", roomId: "another", draft: draft)
        try store.put("scope", "draft", "room", draft)
        try store.put("scope", "room", "room", draft)
        try store.purgeRoom("scope", "room")
        #expect(try store.list("scope", "outbox").count == 1)
        #expect(try store.get("scope", "draft", "room") == nil)
        #expect(try store.get("scope", "room", "room") == nil)
        try store.purgeScope("scope"); #expect(try store.list("scope", "outbox").isEmpty)
    }
    @Test func desktopTranscriptParity() throws {
        let url = Bundle.module.url(forResource: "transcript", withExtension: "json", subdirectory: "Fixtures")!
        let cases = try JSON.decode(Data(contentsOf: url)).array
        for test in cases {
            let output: [JSON] = conversationEntries(test["room"]).map { entry in
                if let message = entry.message { return .object(["id": .string(entry.id), "kind": .string("message"), "text": .string(displayedText(message))]) }
                return .object(["id": .string(entry.id), "kind": .string("turn"), "status": .string(entry.status), "process": .strings(entry.process.map(\.id)), "answer": entry.answer.map { .string($0.id) } ?? .null, "streams": .strings(entry.streams.map { $0["messageId"].string })])
            }
            #expect(JSON.array(output) == test["expected"], "Parity case: \(test["name"].string)")
        }
    }
    @Test func actualHostTLSWebSocketAndAuthorization() async throws {
        guard let raw = ProcessInfo.processInfo.environment["DSH_BOTS_IOS_TEST_INVITE"] else { return } // pnpm test:ios supplies isolated real Host
        let invite = try Invitation.parse(raw), address = invite.addresses[0]
        let wrong = try HostConnection(address: address, fingerprint: String(repeating: "0", count: 64))
        do { _ = try await wrong.request("v1/health", authenticated: false); Issue.record("An incorrect certificate fingerprint was accepted") } catch {}
        await wrong.close()
        let c = try HostConnection(address: address, fingerprint: invite.fingerprint)
        #expect(try await c.request("v1/health")["protocol"].int == 1)
        let body: JSON = .object(["token": .string(invite.token), "displayName": .string("Swift"), "deviceName": .string("Test"), "requestId": .string(UUID().uuidString), "deviceChallenge": .string(UUID().uuidString)])
        let creds = try await c.request("v1/invite", body: body)
        let retry = try await c.request("v1/invite", body: body); #expect(creds == retry)
        await c.setToken(creds["accessToken"].string)
        let boot = try await c.request("v1/bootstrap")
        #expect(boot["person"]["hostRole"].string == "member"); #expect(boot["sessions"].array.isEmpty)
        if let privateRoom = ProcessInfo.processInfo.environment["DSH_BOTS_IOS_PRIVATE_ROOM"] {
            do { _ = try await c.request("v1/snapshot", query: ["roomId": privateRoom]); Issue.record("Unauthorized history exposed") } catch let e as HostError { #expect(!e.code.isEmpty) }
        }
        try await c.openSocket(hostId: invite.hostId, epoch: invite.storeEpoch)
        try await c.subscribe(invite.roomId, after: 0, epoch: invite.storeEpoch)
        while try await c.receive()["kind"].string != "subscribed" {}
        let id = UUID().uuidString
        let payload: JSON = .object(["roomId": .string(invite.roomId), "clientMessageId": .string(id), "parts": .array([.object(["type": .string("text"), "text": .string("Swift 中文 **Markdown**\n```swift\nprint(1)\n```")])])])
        let first = try await c.command("message.send", payload)
        for _ in 0..<9 { #expect(try await c.command("message.send", payload)["messageId"] == first["messageId"]) }
        var event: JSON = .null
        repeat { event = try await c.receive() } while event["type"].string != "message.created"
        #expect(event["payload"]["clientMessageId"].string == id)
        let snapshot = try await c.request("v1/snapshot", query: ["roomId": invite.roomId])
        #expect(snapshot["messages"].array.filter { $0["clientMessageId"].string == id }.count == 1)
        #expect(snapshot["invocations"].array.isEmpty) // background chat never wakes a model
        await c.close()
        let restored = try HostConnection(address: address, fingerprint: invite.fingerprint, token: creds["accessToken"].string)
        try await restored.openSocket(hostId: invite.hostId, epoch: invite.storeEpoch)
        try await restored.subscribe(invite.roomId, after: event["seq"].int, epoch: invite.storeEpoch)
        #expect(try await restored.receive()["kind"].string == "subscribed")
        let newCreds = try await restored.request("v1/refresh", body: .object(["refreshToken": creds["refreshToken"]]), authenticated: false)
        await restored.setToken(newCreds["accessToken"].string)
        #expect(try await restored.request("v1/bootstrap")["person"].id == boot["person"].id)
        await restored.close()
    }
}
