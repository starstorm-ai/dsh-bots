import SwiftUI
import DSHBotsCore

struct BotList: View {
    @Bindable var repository: ChatRepository
    @State private var edit: JSON?
    @State private var creating = false
    var body: some View {
        List {
            ForEach(repository.bootstrap["bots"].array) { bot in
                Button { edit = bot } label: { HStack(spacing: 12) { WhaleAvatar(color: bot["avatar"].string, size: 48); VStack(alignment: .leading, spacing: 6) { Text(bot["name"].string).font(.headline); Text(bot["instructions"].string).font(.caption).foregroundStyle(DSHTheme.secondary).lineLimit(2) }; Spacer(); if !bot["enabled"].bool { Text("已停用").font(.caption).foregroundStyle(DSHTheme.secondary) } } }.foregroundStyle(DSHTheme.text)
            }
            if repository.isOwner { Button(repository.bootstrap["schedulerPaused"].bool ? "恢复任务调度" : "暂停任务调度") { Task { do { try await repository.command("scheduler.update", .object(["paused": .bool(!repository.bootstrap["schedulerPaused"].bool)])) } catch { repository.error = error.localizedDescription } } } }
            if repository.bootstrap["bots"].array.isEmpty { VStack(spacing: 16) { WhaleAvatar(size: 100); Text("助理连接电脑上的 DSH 会话。加入聊天后，在这里查看可用助理。").foregroundStyle(DSHTheme.secondary) }.frame(maxWidth: .infinity).padding(24) }
        }.listStyle(.plain).navigationTitle("助理").toolbar { if repository.isOwner { Button("创建助理", systemImage: "plus") { creating = true } } }
            .sheet(isPresented: $creating) { EntityEditor(repository: repository, kind: .bot) }
            .sheet(item: $edit) { bot in EntityEditor(repository: repository, kind: .bot, entity: bot) }
    }
}
enum EntityKind { case bot, room }
struct EntityEditor: View {
    @Bindable var repository: ChatRepository
    let kind: EntityKind
    var entity: JSON = .null
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var instructions = ""
    @State private var session = ""
    @State private var bot = ""
    @State private var avatar = "charcoal"
    @State private var enabled = true
    @State private var group = false
    @State private var shared = false
    @State private var importHistory = true
    @State private var busy = false
    @State private var error: String?
    @State private var deleting = false
    var body: some View {
        NavigationStack {
            Form {
                Section { TextField(kind == .bot ? "助理名称" : "聊天名称", text: $name) }
                if kind == .bot {
                    Section("头像") { HStack { ForEach(DSHTheme.colors, id: \.self) { color in Button { avatar = color } label: { WhaleAvatar(color: color, size: 40).overlay(Circle().stroke(color == avatar ? DSHTheme.accent : .clear, lineWidth: 2)) }.buttonStyle(.plain).accessibilityLabel(color) } } }
                    Section("职责") { TextField("助理职责", text: $instructions, axis: .vertical).lineLimit(3...10) }
                    Section("DSH 会话") {
                        Picker("绑定会话", selection: $session) { Text("选择电脑上的会话").tag(""); ForEach(repository.bootstrap["sessions"].array) { s in Text(s["title"].string).tag(s.id) } }
                        Text("复用该会话的工作目录、Preset 和 Runtime。新会话需先在电脑 DSH 中创建。").font(.caption).foregroundStyle(DSHTheme.secondary)
                    }
                    Toggle("启用助理", isOn: $enabled)
                } else {
                    Toggle("群聊", isOn: $group)
                    Picker("助理", selection: $bot) { Text("选择助理").tag(""); ForEach(repository.bootstrap["bots"].array.filter { $0["enabled"].bool }) { b in Text(b["name"].string).tag(b.id) } }
                    Toggle("导入已有聊天记录", isOn: $importHistory)
                    if group { Toggle("我确认向群成员共享所选 Session 的已有上下文", isOn: $shared) }
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                if entity != .null && repository.isOwner { Button("删除助理", role: .destructive) { deleting = true } }
            }.disabled(!repository.isOwner || busy)
            .navigationTitle(kind == .bot ? (entity == .null ? "创建助理" : "助理信息") : "新建聊天").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { save() }.disabled(!repository.isOwner || busy || name.trimmingCharacters(in: .whitespaces).isEmpty || (kind == .bot ? session.isEmpty : bot.isEmpty || group && !shared)) }
            }.onAppear { name = entity["name"].string; instructions = entity["instructions"].string; session = entity["sessionId"].string; avatar = entity["avatar"].string.isEmpty ? "charcoal" : entity["avatar"].string; enabled = entity == .null || entity["enabled"].bool }
            .confirmationDialog("删除该助理？", isPresented: $deleting, titleVisibility: .visible) { Button("删除助理", role: .destructive) { Task { do { try await repository.command("bot.delete", .object(["botId": .string(entity.id)])); dismiss() } catch { self.error = error.localizedDescription } } } }
        }
    }
    private func save() {
        busy = true; error = nil
        Task { do {
            if kind == .bot {
                var payload: JSON = .object(["name": .string(name), "instructions": .string(instructions), "sessionId": .string(session), "avatar": .string(avatar)])
                if entity != .null { payload["botId"] = .string(entity.id); payload["enabled"] = .bool(enabled) }
                try await repository.command(entity == .null ? "bot.create" : "bot.update", payload)
            } else { try await repository.command("room.create", .object(["title": .string(name), "kind": .string(group ? "group" : "direct"), "botId": .string(bot), "importHistory": .bool(importHistory), "acknowledgeSharedContext": .bool(shared)])) }
            dismiss()
        } catch { self.error = error.localizedDescription }; busy = false }
    }
}
struct RoomDetailsView: View {
    @Bindable var repository: ChatRepository
    let roomId: String
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var invite: JSON?
    @State private var pendingAction: (String, JSON, String)?
    @State private var addBot = ""
    @State private var shared = false
    var room: JSON { repository.rooms[roomId] ?? .null }
    var canManage: Bool { repository.isOwner || room["room"]["ownerPersonId"].string == repository.bootstrap["person"].id }
    var body: some View {
        NavigationStack { Form {
            Section("聊天") {
                TextField("聊天名称", text: $title).disabled(!canManage)
                if canManage { Button("保存名称") { act("room.update", .object(["roomId": .string(roomId), "title": .string(title)])) } }
                Text("所属电脑：" + (repository.host?.name ?? "DSH")); Text("新成员加入后可查看完整历史。").font(.caption).foregroundStyle(DSHTheme.secondary)
                if canManage { Button("邀请成员", systemImage: "qrcode") { Task { do { invite = try await repository.command("room.invite.create", .object(["roomId": .string(roomId)])) } catch { repository.error = error.localizedDescription } } } }
            }
            Section("成员") {
                ForEach(room["members"].array.filter { $0["leftAtRoomSeq"] == .null }, id: \.["personId"].string) { member in
                    HStack { VStack(alignment: .leading) { Text(member["displayName"].string); if member["role"].string == "owner" { Text("群主").font(.caption).foregroundStyle(DSHTheme.secondary) } }; Spacer()
                        if canManage && member["personId"].string != repository.bootstrap["person"].id { Menu("管理") {
                            Button("移除成员", role: .destructive) { confirm("room.member.remove", .object(["roomId": .string(roomId), "personId": member["personId"]]), "移除该成员？其设备将无法继续访问本群。") }
                            Button("转让群主") { confirm("room.owner.transfer", .object(["roomId": .string(roomId), "personId": member["personId"]]), "将群主转让给该成员？") }
                        } }
                    }
                }
            }
            Section("助理") {
                ForEach(room["bindings"].array.filter { $0["active"].bool }) { binding in
                    let bot = room["bots"].array.first { $0.id == binding["botId"].string }
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { WhaleAvatar(color: bot?["avatar"].string ?? "charcoal", size: 32); Text(bot?["name"].string ?? "助理") }
                        if repository.isOwner {
                            ForEach(room["members"].array.filter { $0["leftAtRoomSeq"] == .null }, id: \.["personId"].string) { member in
                                Toggle("允许 \(member["displayName"].string) 调用", isOn: Binding(get: { room["grants"].array.contains { $0["bindingId"].string == binding.id && $0["personId"] == member["personId"] && $0["canInvoke"].bool } }, set: { act("binding.grant.update", .object(["bindingId": .string(binding.id), "personId": member["personId"], "canInvoke": .bool($0)])) }))
                            }
                            Button("移除助理", role: .destructive) { confirm("binding.remove", .object(["bindingId": .string(binding.id)]), "从聊天移除该助理？") }
                        }
                    }
                }
                if repository.isOwner {
                    Picker("添加助理", selection: $addBot) { Text("选择助理").tag(""); ForEach(repository.bootstrap["bots"].array.filter { bot in bot["enabled"].bool && !room["bindings"].array.contains { $0["active"].bool && $0["botId"].string == bot.id } }) { bot in Text(bot["name"].string).tag(bot.id) } }
                    Toggle("确认共享此 Session 的已有上下文", isOn: $shared)
                    Button("添加") { act("binding.create", .object(["roomId": .string(roomId), "botId": .string(addBot), "acknowledgeSharedContext": .bool(shared), "importHistory": .bool(true)])) }.disabled(addBot.isEmpty || !shared)
                }
            }
            Section {
                Button("退出聊天", role: .destructive) { confirm("room.leave", .object(["roomId": .string(roomId)]), "退出聊天？群主需先转让群主或删除聊天。") }
                if canManage { Button("删除聊天", role: .destructive) { confirm("room.delete", .object(["roomId": .string(roomId)]), "删除此聊天？此操作会影响所有成员。") } }
            }
        }.disabled(!repository.online).navigationTitle("聊天信息").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }.onAppear { title = room["room"]["title"].string }
            .sheet(item: $invite) { InviteView(ticket: $0) }
            .confirmationDialog(pendingAction?.2 ?? "确认操作", isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } }), titleVisibility: .visible) { Button("确认", role: .destructive) { if let action = pendingAction { act(action.0, action.1) } }; Button("取消", role: .cancel) {} }
        }
    }
    private func confirm(_ type: String, _ payload: JSON, _ title: String) { pendingAction = (type, payload, title) }
    private func act(_ type: String, _ payload: JSON) { Task { do { try await repository.command(type, payload); if ["room.leave", "room.delete"].contains(type) { dismiss() } } catch { repository.error = error.localizedDescription } } }
}
