import Foundation

public struct TranscriptEntry: Identifiable, Sendable {
    public var id: String
    public var seq: Double
    public var bindingId: String = ""
    public var message: JSON?
    public var messages: [JSON] = []
    public var streams: [JSON] = []
    public var task: JSON = .null
    public var turn: JSON = .null
    public var status = "completed"
    public var answer: JSON? {
        guard status == "completed" else { return nil }
        let final = turn["finalMessageId"].string
        return final.isEmpty ? messages.last(where: { $0["source"].string != "tool" && !$0["text"].string.isEmpty }) : messages.first(where: { $0["sessionMessageId"].string == final })
    }
    public var process: [JSON] { messages.filter { $0.id != answer?.id } }
}
/// Kept in lockstep with packages/desktop-ui/src/transcript.ts; parity fixtures cover interleaving and recovery.
public func conversationEntries(_ room: JSON, nativeActive: Set<String> = []) -> [TranscriptEntry] {
    let messages = room["messages"].array.sorted { $0["seq"].int < $1["seq"].int }
    let tasks = room["invocations"].array
    let streams = room["streams"].array
    var entries: [TranscriptEntry] = [], groups: [String: Int] = [:], legacy: [String: String] = [:], taskKeys: [String: String] = [:], groupedTasks = Set<String>()
    let saved = Set(messages.filter { !$0["bindingId"].string.isEmpty && !$0["sessionMessageId"].string.isEmpty }.map { $0["bindingId"].string + "/" + $0["sessionMessageId"].string })
    for m in messages + streams where !m["turn"].id.isEmpty && !m["invocationId"].string.isEmpty && !m["bindingId"].string.isEmpty { taskKeys[m["invocationId"].string] = m["bindingId"].string + "/" + m["turn"].id }
    func ensure(_ id: String, _ binding: String, _ seq: Double, _ task: JSON) -> Int {
        if let index = groups[id] { return index }
        let index = entries.count; groups[id] = index
        entries.append(TranscriptEntry(id: id, seq: seq, bindingId: binding, task: task, status: task == .null ? "completed" : task["status"].string))
        if task != .null { groupedTasks.insert(task.id) }; return index
    }
    for m in messages {
        let binding = m["bindingId"].string
        if m["authorKind"].string != "bot" || binding.isEmpty {
            entries.append(TranscriptEntry(id: m.id, seq: Double(m["seq"].int), message: m))
            if !binding.isEmpty && m["source"].string == "desktop" { legacy[binding] = binding + "/input-" + m.id }; continue
        }
        let invocation = m["invocationId"].string
        let task = tasks.first { $0.id == invocation } ?? .null
        let key = !m["turn"].id.isEmpty ? binding + "/" + m["turn"].id : !invocation.isEmpty ? taskKeys[invocation] ?? binding + "/task-" + invocation : legacy[binding] ?? binding + "/legacy-" + m.id
        legacy[binding] = key
        let i = ensure(key, binding, Double(m["seq"].int), task); entries[i].messages.append(m)
        if m["turn"] != .null { entries[i].turn = m["turn"]; entries[i].status = m["turn"]["status"].string }
    }
    for task in tasks where !groupedTasks.contains(task.id) {
        let trigger = messages.first { $0.id == task["messageId"].string }
        if trigger != nil || activeStatuses.contains(task["status"].string) {
            _ = ensure(taskKeys[task.id] ?? task["bindingId"].string + "/task-" + task.id, task["bindingId"].string, Double(trigger?["seq"].int ?? room["room"]["seq"].int) + 0.1, task)
        }
    }
    for s in streams where !s["text"].string.isEmpty && !saved.contains(s["bindingId"].string + "/" + s["messageId"].string) {
        let b = s["bindingId"].string, inv = s["invocationId"].string
        let key = !s["turn"].id.isEmpty ? b + "/" + s["turn"].id : !inv.isEmpty ? taskKeys[inv] ?? b + "/task-" + inv : legacy[b] ?? b + "/stream-" + s["attemptId"].string
        let i = ensure(key, b, Double(room["room"]["seq"].int) + 0.2, tasks.first { $0.id == inv } ?? .null)
        entries[i].streams.append(s); if s["turn"] != .null { entries[i].turn = s["turn"] }; entries[i].status = "running"
    }
    for i in entries.indices where entries[i].task != .null && !activeStatuses.contains(entries[i].task["status"].string) && activeStatuses.contains(entries[i].status) { entries[i].status = entries[i].task["status"].string }
    for binding in nativeActive {
        if let i = entries.lastIndex(where: { $0.message == nil && $0.bindingId == binding }), entries[i].turn["endedAt"] == .null && entries[i].task == .null { entries[i].status = "running" }
    }
    return entries.sorted { $0.seq < $1.seq }
}
