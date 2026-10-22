import type { Invocation, InvocationStatus, Message, RoomSnapshot, StreamSnapshot, TranscriptTurn } from '../../protocol/src/index.ts'

export const activeStatuses = new Set<InvocationStatus>(['queued', 'dispatching', 'accepted', 'running', 'waiting_user'])
export interface AssistantTurn {
  kind: 'turn'; id: string; bindingId: string; seq: number; messages: Message[]; streams: StreamSnapshot[];
  task?: Invocation; turn?: TranscriptTurn; status: InvocationStatus
}
export type TranscriptEntry = { kind: 'message'; id: string; seq: number; message: Message } | AssistantTurn

/** Group by DSH Turn, never by contiguous bubbles: people/bots may interleave. */
export function conversationEntries(room: RoomSnapshot, nativeActive: ReadonlySet<string> = new Set()): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const groups = new Map<string, AssistantTurn>()
  const tasks = new Map(room.invocations.map(task => [task.id, task]))
  const messages = new Map(room.messages.map(message => [message.id, message]))
  const groupedTasks = new Set<string>()
  const latestByBinding = new Map<string, AssistantTurn>()
  const savedStreams = new Map<string, Set<string>>()
  for (const message of room.messages) if (message.bindingId && message.sessionMessageId) {
    let saved = savedStreams.get(message.bindingId)
    if (!saved) { saved = new Set(); savedStreams.set(message.bindingId, saved) }
    saved.add(message.sessionMessageId)
  }
  const legacy = new Map<string, string>()
  const taskKeys = new Map<string, string>()
  for (const message of room.messages) if (message.turn && message.invocationId && message.bindingId) taskKeys.set(message.invocationId, `${message.bindingId}/${message.turn.id}`)
  for (const stream of room.streams) if (stream.turn && stream.invocationId) taskKeys.set(stream.invocationId, `${stream.bindingId}/${stream.turn.id}`)
  const ensure = (id: string, bindingId: string, seq: number, task?: Invocation): AssistantTurn => {
    let group = groups.get(id)
    if (!group) {
      group = { kind: 'turn', id, bindingId, seq, messages: [], streams: [], task, status: task?.status ?? 'completed' }
      groups.set(id, group); entries.push(group); latestByBinding.set(bindingId, group)
      if (task) groupedTasks.add(task.id)
    }
    return group
  }
  for (const message of [...room.messages].sort((a, b) => a.seq - b.seq)) {
    if (message.authorKind !== 'bot' || !message.bindingId) {
      entries.push({ kind: 'message', id: message.id, seq: message.seq, message })
      if (message.bindingId && message.source === 'desktop') legacy.set(message.bindingId, `${message.bindingId}/input-${message.id}`)
      continue
    }
    const bindingId = message.bindingId
    const task = message.invocationId ? tasks.get(message.invocationId) : undefined
    const id = message.turn ? `${bindingId}/${message.turn.id}` : message.invocationId ? taskKeys.get(message.invocationId) ?? `${bindingId}/task-${message.invocationId}` : legacy.get(bindingId) ?? `${bindingId}/legacy-${message.id}`
    legacy.set(bindingId, id)
    const group = ensure(id, bindingId, message.seq, task)
    group.messages.push(message)
    if (message.turn) { group.turn = message.turn; group.status = message.turn.status }
  }
  // Keep a task visible before the first token, including queued/error-only tasks.
  for (const task of room.invocations) {
    if (groupedTasks.has(task.id)) continue
    const trigger = messages.get(task.messageId)
    if (trigger || activeStatuses.has(task.status)) ensure(taskKeys.get(task.id) ?? `${task.bindingId}/task-${task.id}`, task.bindingId, (trigger?.seq ?? room.room.seq) + 0.1, task)
  }
  for (const stream of room.streams) {
    if (!stream.text || savedStreams.get(stream.bindingId)?.has(stream.messageId)) continue
    const task = stream.invocationId ? tasks.get(stream.invocationId) : undefined
    const id = stream.turn ? `${stream.bindingId}/${stream.turn.id}` : stream.invocationId ? taskKeys.get(stream.invocationId) ?? `${stream.bindingId}/task-${stream.invocationId}` : legacy.get(stream.bindingId) ?? `${stream.bindingId}/stream-${stream.attemptId}`
    const group = ensure(id, stream.bindingId, room.room.seq + 0.2, task)
    group.streams.push(stream); group.turn = stream.turn ?? group.turn; group.status = 'running'
  }
  // Recovery/cancellation can settle a Bots task before a missing native end
  // event is repaired. Do not leave its old process snapshot running forever.
  for (const group of groups.values()) if (group.task && !activeStatuses.has(group.task.status) && activeStatuses.has(group.status)) group.status = group.task.status
  for (const bindingId of nativeActive) {
    const latest = latestByBinding.get(bindingId)
    if (latest && !latest.turn?.endedAt && !latest.task) latest.status = 'running'
  }
  return entries.sort((a, b) => a.seq - b.seq)
}

export function turnContent(group: AssistantTurn): { process: Message[]; answer?: Message } {
  if (group.status !== 'completed') return { process: group.messages }
  const answer = group.turn?.finalMessageId
    ? group.messages.find(message => message.sessionMessageId === group.turn!.finalMessageId)
    : group.messages.findLast(message => message.source !== 'tool' && !!message.text)
  return { process: group.messages.filter(message => message !== answer), answer }
}
