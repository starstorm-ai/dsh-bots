import SwiftUI
import DSHBotsCore

@main struct DSHBotsApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var repository: ChatRepository?
    @State private var startupError: String?
    var body: some Scene {
        WindowGroup {
            Group {
                if let repository { RootView(repository: repository) }
                else if let startupError { ContentUnavailableView("无法打开本地数据", systemImage: "exclamationmark.triangle", description: Text(startupError)) }
                else { ProgressView().task { initialize() } }
            }.tint(DSHTheme.accent).foregroundStyle(DSHTheme.text)
        }.onChange(of: scenePhase) { _, phase in
            guard let repository else { return }
            if phase == .active { repository.resume() }
            else if phase == .background { Task { await repository.suspend() } }
        }
    }
    private func initialize() {
        do {
            let directory = URL.applicationSupportDirectory.appendingPathComponent("DSHBots", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            var excluded = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true; try excluded.setResourceValues(values)
            let store = try LocalStore(path: directory.appendingPathComponent("chat.sqlite").path)
            let model = try ChatRepository(store: store); repository = model
            if let id = model.hosts.first?.id { Task { await model.select(id) } }
        } catch { startupError = error.localizedDescription }
    }
}
struct RootView: View {
    @Bindable var repository: ChatRepository
    @State private var pairing = false
    @State private var invitation = ""
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { ChatList(repository: repository, pairing: $pairing) }.tabItem { Label("聊天", systemImage: "bubble.left.and.bubble.right") }.tag(0)
            NavigationStack { BotList(repository: repository) }.tabItem { Label("助理", systemImage: "sparkles") }.tag(1)
            NavigationStack { DeviceList(repository: repository, pairing: $pairing) }.tabItem { Label("设备", systemImage: "desktopcomputer") }.tag(2)
        }.background(DSHTheme.background)
        .sheet(isPresented: $pairing) { PairingView(repository: repository, input: invitation) }
        .onOpenURL { url in invitation = url.absoluteString; pairing = true }
        .alert("DSH Bots", isPresented: Binding(get: { repository.error != nil }, set: { if !$0 { repository.error = nil } })) { Button("好") { repository.error = nil } } message: { Text(repository.error ?? "") }
    }
}
struct ChatList: View {
    @Bindable var repository: ChatRepository
    @Binding var pairing: Bool
    @State private var search = ""
    @State private var creating = false
    var filtered: [JSON] { repository.bootstrap["rooms"].array.filter { search.isEmpty || $0["title"].string.localizedCaseInsensitiveContains(search) || $0["lastMessage"].string.localizedCaseInsensitiveContains(search) }.sorted { $0["pinned"].bool && !$1["pinned"].bool } }
    var body: some View {
        List {
            if !repository.online { Text(statusLabel(repository.phase)).font(.caption).foregroundStyle(DSHTheme.secondary) }
            ForEach(filtered) { room in
                NavigationLink(value: room.id) {
                    HStack(spacing: 12) {
                        if room["kind"].string == "group" { Image(systemName: "person.2").frame(width: 44, height: 44).background(DSHTheme.surface, in: RoundedRectangle(cornerRadius: 12)) } else { WhaleAvatar(color: repository.rooms[room.id]?["bots"].array.first?["avatar"].string ?? "charcoal", size: 44) }
                        VStack(alignment: .leading, spacing: 6) {
                            HStack { Text(room["title"].string).font(.headline).lineLimit(1); if room["pinned"].bool { Image(systemName: "pin.fill").font(.caption2) }; Spacer(); if room["running"].bool { ProgressView().controlSize(.mini) } }
                            Text(room["lastMessage"].string).font(.subheadline).foregroundStyle(DSHTheme.secondary).lineLimit(2)
                        }
                        if room["unreadCount"].int > 0 { Text(String(room["unreadCount"].int)).font(.caption).padding(6).background(DSHTheme.accent, in: Capsule()).foregroundStyle(.white) }
                    }.padding(.vertical, 6)
                }.swipeActions(edge: .leading) { Button("置顶") { act("room.update", .object(["roomId": .string(room.id), "pinned": .bool(!room["pinned"].bool)])) }.tint(DSHTheme.accent) }
            }
        }.listStyle(.plain).scrollContentBackground(.hidden).background(DSHTheme.background)
        .overlay { if filtered.isEmpty { VStack(spacing: 20) { WhaleAvatar(size: 100); Text(repository.host == nil ? "在电脑 Bots 聊天中打开邀请，扫码加入。" : "暂无聊天").foregroundStyle(DSHTheme.secondary); Button("扫描邀请", systemImage: "qrcode.viewfinder") { pairing = true }.buttonStyle(.borderedProminent) }.padding(32) } }
        .navigationTitle("聊天").searchable(text: $search, prompt: "搜索聊天")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Menu { Button("扫描邀请", systemImage: "qrcode.viewfinder") { pairing = true }; if repository.isOwner { Button("新建聊天", systemImage: "square.and.pencil") { creating = true } } } label: { Image(systemName: "plus") } } }
        .navigationDestination(for: String.self) { id in ChatView(repository: repository, roomId: id) }
        .sheet(isPresented: $creating) { EntityEditor(repository: repository, kind: .room) }
    }
    private func act(_ type: String, _ payload: JSON) { Task { do { try await repository.command(type, payload) } catch { repository.error = error.localizedDescription } } }
}
struct DeviceList: View {
    @Bindable var repository: ChatRepository
    @Binding var pairing: Bool
    @State private var forgetting: TrustedHost?
    @State private var displayName = ""
    @State private var revokeDevice: JSON?
    var body: some View {
        List {
            Section("已信任的电脑") {
                ForEach(repository.hosts) { host in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Label(host.name, systemImage: "desktopcomputer"); Spacer(); if repository.selectedHostId == host.id { Text(statusLabel(repository.phase)).font(.caption).foregroundStyle(DSHTheme.secondary) } }
                        ForEach(host.addresses, id: \.self) { Text($0).font(.caption).textSelection(.enabled) }
                        HStack { Button("连接") { Task { await repository.select(host.id) } }; Spacer(); Button("移除信任", role: .destructive) { forgetting = host } }.buttonStyle(.borderless)
                    }.padding(.vertical, 6)
                }
                Button("扫描聊天邀请", systemImage: "qrcode.viewfinder") { pairing = true }
            }
            if repository.host != nil {
                Section("个人资料") { TextField("显示名称", text: $displayName); Button("保存名称") { Task { do { try await repository.command("person.update", .object(["displayName": .string(displayName)])) } catch { repository.error = error.localizedDescription } } }.disabled(!repository.online || displayName.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
            if repository.isOwner {
                Section("已配对设备") {
                    ForEach(repository.bootstrap["devices"].array.filter { $0["revokedAt"] == .null }) { device in
                        HStack { Text(device["name"].string); Spacer(); if device.id != repository.bootstrap["device"].id { Button("撤销", role: .destructive) { revokeDevice = device } } }
                    }
                }
            }
            Section { Text("手机与电脑需处于可互通的局域网。锁屏或退出后，电脑继续执行；回到 App 后自动补齐消息。地址变化时，请重新扫描同一电脑的新邀请。").font(.footnote).foregroundStyle(DSHTheme.secondary) }
        }.navigationTitle("设备").onAppear { displayName = repository.bootstrap["person"]["displayName"].string }
        .confirmationDialog("撤销此设备？它将无法继续收发消息。", isPresented: Binding(get: { revokeDevice != nil }, set: { if !$0 { revokeDevice = nil } }), titleVisibility: .visible) {
            Button("撤销设备", role: .destructive) { if let device = revokeDevice { Task { do { try await repository.command("device.revoke", .object(["deviceId": .string(device.id)])) } catch { repository.error = error.localizedDescription } } } }
        }
        .confirmationDialog("移除这台电脑的信任，并清除其本地缓存和待发消息？", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible) { Button("移除信任", role: .destructive) { if let host = forgetting { Task { do { try await repository.forget(host.id) } catch { repository.error = error.localizedDescription } } } }; Button("取消", role: .cancel) {} }
    }
}
