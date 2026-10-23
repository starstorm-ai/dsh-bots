import SwiftUI
import DSHBotsCore

struct ChatView: View {
    @Bindable var repository: ChatRepository
    let roomId: String
    @State private var text = ""
    @State private var mentions: Set<String> = []
    @State private var replyId: String?
    @State private var details = false
    @State private var search = ""
    @State private var results: [JSON]?
    @State private var nearBottom = true
    @State private var olderExhausted = false
    @State private var loading = false
    @State private var submitting = false
    @State private var initializedDraft = false
    @Environment(\.scenePhase) private var scenePhase
    var room: JSON { repository.rooms[roomId] ?? .null }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if room == .null { ContentUnavailableView("正在同步聊天", systemImage: "bubble.left", description: Text(statusLabel(repository.phase))) }
                    else if let results {
                        Button("返回聊天") { self.results = nil }
                        if results.isEmpty { Text("没有匹配的消息").foregroundStyle(DSHTheme.secondary) }
                        ForEach(results) { message in VStack(alignment: .leading) { Text(message["authorName"].string).font(.caption).foregroundStyle(DSHTheme.secondary); MarkdownView(text: displayedText(message)) } }
                    } else {
                        ForEach(room["bindings"].array.filter { b in
                            !room["invocations"].array.contains { $0["bindingId"].string == b.id && activeStatuses.contains($0["status"].string) } && (activeStatuses.contains(repository.nativeActivities[b.id]?["status"].string ?? "") || !(repository.nativeActivities[b.id]?["error"].string ?? "").isEmpty)
                        }) { binding in
                            let activity = repository.nativeActivities[binding.id] ?? .null
                            let name = room["bots"].array.first { $0.id == binding["botId"].string }?["name"].string ?? "DSH"
                            VStack(alignment: .leading) { Text(name + " · 原生会话 · " + statusLabel(activity["status"].string)); if !activity["error"].string.isEmpty { Text(activity["error"].string).foregroundStyle(.red) } }.font(.caption).foregroundStyle(DSHTheme.secondary)
                        }
                        if !olderExhausted { Button(loading ? "加载中…" : "加载更早消息") { loadOlder() }.frame(maxWidth: .infinity).disabled(loading) }
                        ForEach(conversationEntries(room, nativeActive: Set(repository.nativeActivities.filter { activeStatuses.contains($0.value["status"].string) }.keys))) { entry in
                            if let message = entry.message { human(message) }
                            else { AssistantTurnView(entry: entry, room: room, repository: repository) }
                        }
                        ForEach(room["interactions"].array) { interaction in
                            let task = room["invocations"].array.first { $0.id == interaction["invocationId"].string }
                            InteractionView(interaction: interaction, repository: repository, canAnswer: repository.isOwner || interaction["kind"].string == "question" && task?["initiatedByPersonId"].string == repository.bootstrap["person"].id).id(interaction.id + String(interaction["revision"].int))
                        }
                        ForEach(repository.outbox.filter { $0["roomId"].string == roomId }) { item in
                            VStack(alignment: .trailing, spacing: 6) {
                                Text(item["text"].string).padding(12).background(DSHTheme.bubble, in: RoundedRectangle(cornerRadius: 20))
                                HStack { Text(item["error"] == .null ? "待发送" : item["error"].string).font(.caption).foregroundStyle(DSHTheme.secondary); Button("重试") { Task { await repository.retryPending(item.id) } }; Button("撤销") { do { try repository.discardPending(item.id) } catch { repository.error = error.localizedDescription } } }.font(.caption)
                            }.frame(maxWidth: .infinity, alignment: .trailing)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom").onAppear { nearBottom = true; markRead() }.onDisappear { nearBottom = false }
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }.defaultScrollAnchor(.bottom).scrollDismissesKeyboard(.interactively)
                .onChange(of: room) { _, _ in if !initializedDraft && room != .null { setDefaultMention(); initializedDraft = true }; if nearBottom && results == nil { proxy.scrollTo("bottom", anchor: .bottom); markRead() } }
                .onChange(of: repository.outbox.count) { _, _ in if nearBottom { proxy.scrollTo("bottom", anchor: .bottom) } }
        }.background(DSHTheme.background)
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle(room["room"]["title"].string).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("聊天信息", systemImage: "ellipsis") { details = true } } }
        .searchable(text: $search, prompt: "搜索聊天记录").onSubmit(of: .search) { let query = search; Task { do { let value = try await repository.history(roomId, search: query); if query == search { results = value } } catch { repository.error = error.localizedDescription } } }
        .sheet(isPresented: $details) { RoomDetailsView(repository: repository, roomId: roomId) }
        .onAppear {
            repository.selectedRoomId = roomId; let draft = repository.draft(roomId); text = draft["text"].string; mentions = Set(draft["mentions"].array.map(\.string)); replyId = draft["replyToMessageId"].string.isEmpty ? nil : draft["replyToMessageId"].string
            initializedDraft = draft != .null || room != .null
            if draft == .null && room != .null { setDefaultMention() }; markRead()
        }
        .onChange(of: text) { _, _ in saveDraft() }.onChange(of: mentions) { _, _ in saveDraft() }.onChange(of: replyId) { _, _ in saveDraft() }
        .onDisappear { if repository.selectedRoomId == roomId { repository.selectedRoomId = nil } }
    }
    @ViewBuilder private func human(_ message: JSON) -> some View {
        if message["authorKind"].string == "system" { Text(message["text"].string).font(.caption).foregroundStyle(DSHTheme.secondary).frame(maxWidth: .infinity) }
        else {
            VStack(alignment: .trailing, spacing: 8) {
                if room["room"]["kind"].string == "group" { Text(message["authorName"].string).font(.caption).foregroundStyle(DSHTheme.secondary) }
                if let quoted = room["messages"].array.first(where: { $0.id == message["replyToMessageId"].string }) { Text("\(quoted["authorName"].string)  \(quoted["text"].string.prefix(180))").font(.caption).foregroundStyle(DSHTheme.secondary).padding(10).background(DSHTheme.surface, in: RoundedRectangle(cornerRadius: 8)) }
                Text(displayedText(message)).textSelection(.enabled).padding(.vertical, 10).padding(.horizontal, 16).background(DSHTheme.bubble, in: RoundedRectangle(cornerRadius: 20))
                HStack(spacing: 18) { Text(wireDate(message["createdAt"].string) ?? .now, style: .time); Button("回复") { replyId = message.id }; Button { UIPasteboard.general.string = displayedText(message) } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("复制消息") }.font(.caption2).foregroundStyle(DSHTheme.secondary)
            }.frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 36)
        }
    }
    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !repository.online { Text(statusLabel(repository.phase) + " · 消息保存在本机，连接后发送").font(.caption).foregroundStyle(DSHTheme.secondary) }
            if let replyId { HStack { Text("回复：" + (room["messages"].array.first { $0.id == replyId }?["text"].string ?? replyId)).lineLimit(1); Spacer(); Button("取消回复", systemImage: "xmark") { self.replyId = nil }.labelStyle(.iconOnly) }.font(.caption).foregroundStyle(DSHTheme.secondary) }
            if !mentions.isEmpty { ScrollView(.horizontal) { HStack { ForEach(room["bots"].array.filter { mentions.contains($0.id) }) { bot in Button("@" + bot["name"].string + " ×") { mentions.remove(bot.id) }.font(.caption).buttonStyle(.bordered) } } } }
            TextField("发送消息，@助理执行任务", text: $text, axis: .vertical).lineLimit(1...7).padding(.horizontal, 4).accessibilityIdentifier("messageInput")
            HStack {
                Menu { ForEach(room["bots"].array.filter(canInvoke)) { bot in Button { if mentions.contains(bot.id) { mentions.remove(bot.id) } else { mentions.insert(bot.id) } } label: { Label(bot["name"].string, systemImage: mentions.contains(bot.id) ? "checkmark.circle.fill" : "circle") } } } label: { Text("@").font(.title3).frame(width: 44, height: 36) }.accessibilityLabel("选择助理")
                Spacer()
                if room["room"]["kind"].string == "group" && mentions.isEmpty { Text("仅作为群聊背景").font(.caption2).foregroundStyle(DSHTheme.secondary) }
                Button { submit() } label: { Image(systemName: repository.online ? "arrow.up" : "tray.and.arrow.up").font(.headline).foregroundStyle(.white).frame(width: 38, height: 38).background(DSHTheme.accent, in: Circle()) }.disabled(submitting || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || room == .null).accessibilityLabel("发送消息")
            }
        }.padding(14).background(DSHTheme.background, in: RoundedRectangle(cornerRadius: 20)).overlay(RoundedRectangle(cornerRadius: 20).stroke(DSHTheme.border)).padding(.horizontal, 12).padding(.bottom, 8).background(DSHTheme.background)
    }
    private func canInvoke(_ bot: JSON) -> Bool {
        bot["enabled"].bool && room["bindings"].array.contains { b in b["botId"].string == bot.id && b["active"].bool && (repository.isOwner || room["grants"].array.contains { $0["bindingId"].string == b.id && $0["personId"].string == repository.bootstrap["person"].id && $0["canInvoke"].bool }) }
    }
    private func setDefaultMention() { if room["room"]["kind"].string == "direct", let bot = room["bots"].array.first(where: canInvoke) { mentions = [bot.id] } }
    private var draft: JSON {
        var value: JSON = .object(["text": .string(text), "mentions": .strings(Array(mentions).sorted()), "parts": .array(room["bots"].array.filter { mentions.contains($0.id) }.map { .object(["type": .string("mention"), "botId": .string($0.id), "label": $0["name"]]) } + [.object(["type": .string("text"), "text": .string(text)])])])
        if let replyId { value["replyToMessageId"] = .string(replyId) }; return value
    }
    private func saveDraft() { if initializedDraft && !submitting { repository.saveDraft(roomId, draft) } }
    private func submit() {
        let saved = draft; submitting = true
        Task { do {
            // Repository persists before returning; the composer only clears after that succeeds.
            try await repository.send(roomId, draft: saved)
            text = ""; mentions = []; replyId = nil; setDefaultMention()
        } catch { repository.error = error.localizedDescription }; submitting = false; saveDraft() }
    }
    private func loadOlder() { loading = true; Task { do { olderExhausted = try await repository.history(roomId).isEmpty } catch { repository.error = error.localizedDescription }; loading = false } }
    private func markRead() { guard nearBottom, scenePhase == .active, repository.online, room["room"]["seq"].int > room["readSeq"].int else { return }; Task { do { try await repository.command("read.update", .object(["roomId": .string(roomId), "seq": room["room"]["seq"]])) } catch { repository.error = error.localizedDescription } } }
}
struct AssistantTurnView: View {
    let entry: TranscriptEntry
    let room: JSON
    @Bindable var repository: ChatRepository
    @State private var expanded = false
    var active: Bool { activeStatuses.contains(entry.status) }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            let binding = room["bindings"].array.first { $0.id == entry.bindingId }
            let bot = room["bots"].array.first { $0.id == binding?["botId"].string }
            if room["room"]["kind"].string == "group" { HStack(spacing: 6) { WhaleAvatar(color: bot?["avatar"].string ?? "charcoal", size: 24); Text(bot?["name"].string ?? entry.messages.first?["authorName"].string ?? "助理").font(.caption).foregroundStyle(DSHTheme.secondary) } }
            if !active { Button { expanded.toggle() } label: { HStack(spacing: 6) { Text(processLabel); if !entry.process.isEmpty && entry.status == "completed" { Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2) } } }.font(.caption).foregroundStyle(DSHTheme.secondary).disabled(entry.process.isEmpty) }
            if active || expanded || entry.status != "completed" {
                ForEach(entry.process) { message in MessageBody(message: message) }
            }
            if let answer = entry.answer { MessageBody(message: answer); HStack { Button { UIPasteboard.general.string = answer["text"].string } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("复制回复"); Text(wireDate(answer["createdAt"].string) ?? .now, style: .time) }.font(.caption2).foregroundStyle(DSHTheme.secondary) }
            ForEach(entry.streams, id: \.["messageId"].string) { stream in MarkdownView(text: stream["text"].string) }
            if active { HStack(spacing: 8) { ProgressView().controlSize(.small); Text(statusLabel(entry.status)).font(.caption).foregroundStyle(DSHTheme.secondary); Spacer(); if canControl { Button("停止") { taskCommand("invocation.cancel") }.font(.caption) } } }
            if !entry.task["error"].string.isEmpty { Text(entry.task["error"].string).font(.caption).foregroundStyle(.red) }
            if ["failed", "cancelled", "interrupted", "recovery_required"].contains(entry.status) && canControl { Button("重试任务") { taskCommand("invocation.retry") }.font(.caption) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    var canControl: Bool { !entry.task.id.isEmpty && (repository.isOwner || entry.task["initiatedByPersonId"].string == repository.bootstrap["person"].id) }
    var processLabel: String {
        if ["cancelled", "interrupted"].contains(entry.status) { return "已停止" }
        if ["failed", "recovery_required"].contains(entry.status) { return "执行失败" }
        let start = wireDate(entry.turn["startedAt"].string) ?? wireDate(entry.task["createdAt"].string)
        let end = wireDate(entry.turn["endedAt"].string) ?? wireDate(entry.task["updatedAt"].string)
        if let start, let end { return "用时 \(max(1, Int(end.timeIntervalSince(start)))) 秒" }; return "已完成"
    }
    private func taskCommand(_ type: String) { Task { do { try await repository.command(type, .object(["invocationId": .string(entry.task.id)])) } catch { repository.error = error.localizedDescription } } }
}
struct MessageBody: View {
    let message: JSON
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if message["source"].string == "tool" {
                let tool = message["blocks"].array.first { $0["type"].string == "tool" }
                DisclosureGroup { MarkdownView(text: tool?["summary"].string.isEmpty == false ? tool!["summary"].string : message["text"].string) } label: { HStack { Image(systemName: "diamond"); Text(message["toolName"].string.isEmpty ? tool?["name"].string ?? "Tool" : message["toolName"].string); if tool?["status"].string == "running" { ProgressView().controlSize(.mini) } } }.font(.subheadline).tint(DSHTheme.secondary)
            } else { MarkdownView(text: message["text"].string) }
            ForEach(Array(message["blocks"].array.filter { $0["type"].string == "attachment" }.enumerated()), id: \.offset) { _, attachment in Label(attachment["name"].string, systemImage: "paperclip").font(.caption).padding(8).background(DSHTheme.surface, in: RoundedRectangle(cornerRadius: 8)) }
        }
    }
}
struct InteractionView: View {
    let interaction: JSON
    @Bindable var repository: ChatRepository
    let canAnswer: Bool
    @State private var choices: [String: Set<String>] = [:]
    @State private var custom: [String: String] = [:]
    @State private var freeText = ""
    @State private var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(interaction["title"].string).font(.headline)
            if !interaction["description"].string.isEmpty { MarkdownView(text: interaction["description"].string) }
            if interaction["status"].string != "pending" { Text(interaction["status"].string == "answered" ? "已处理" : "已过期").font(.caption).foregroundStyle(DSHTheme.secondary) }
            else if !canAnswer { Text("等待有权限的成员处理").font(.caption).foregroundStyle(DSHTheme.secondary) }
            else if interaction["kind"].string == "approval" { HStack { Button("批准") { submit(.object(["approved": .bool(true)])) }.buttonStyle(.borderedProminent); Button("拒绝", role: .destructive) { submit(.object(["approved": .bool(false)])) }.buttonStyle(.bordered) } }
            else {
                ForEach(interaction["questions"].array) { question in
                    Text(question["question"].string)
                    ForEach(question["options"].array.map(\.string), id: \.self) { option in Button { var selected = choices[question.id] ?? []; if selected.contains(option) { selected.remove(option) } else if question["multiple"].bool { selected.insert(option) } else { selected = [option]; custom[question.id] = "" }; choices[question.id] = selected } label: { Label(option, systemImage: choices[question.id]?.contains(option) == true ? "checkmark.circle.fill" : "circle") } }
                    TextField("其他回答", text: Binding(get: { custom[question.id] ?? "" }, set: { custom[question.id] = $0; if !question["multiple"].bool && !$0.isEmpty { choices[question.id] = [] } })).textFieldStyle(.roundedBorder)
                }
                if interaction["questions"].array.isEmpty { TextField("输入回答", text: $freeText, axis: .vertical).textFieldStyle(.roundedBorder) }
                Button("提交回答") {
                    let answer: JSON = interaction["questions"].array.isEmpty ? .object(["text": .string(freeText)]) : .object(["answers": .object(choices.mapValues { .strings(Array($0).sorted()) }), "custom": .object(custom.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.mapValues(JSON.string))])
                    submit(answer)
                }.buttonStyle(.borderedProminent)
            }
        }.dshCard().disabled(busy || !repository.online)
    }
    private func submit(_ answer: JSON) { busy = true; Task { do { try await repository.command("interaction.answer", .object(["interactionId": .string(interaction.id), "revision": interaction["revision"], "answer": answer])) } catch { repository.error = error.localizedDescription }; busy = false } }
}
