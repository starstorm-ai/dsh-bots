import { describe, expect, it } from 'vitest'
import { conversationEntries, turnContent, type AssistantTurn } from '../packages/desktop-ui/src/transcript.ts'
import type { Message, RoomSnapshot, TranscriptTurn } from '../packages/protocol/src/index.ts'

const turn: TranscriptTurn = { id: 'turn-10', number: 1, status: 'completed', startedAt: '2026-10-22T01:00:00Z', endedAt: '2026-10-22T01:00:12Z', finalMessageId: 'answer' }
function message(id: string, seq: number, extra: Partial<Message> = {}): Message {
  return { id, seq, roomId: 'room', authorKind: 'bot', authorId: 'bot', authorName: 'Whale', parts: [{ type: 'text', text: id }], text: id, createdAt: '2026-10-22T01:00:00Z', bindingId: 'binding', sessionMessageId: id, source: 'assistant', turn, ...extra }
}
function room(messages: Message[], extra: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return { room: { id: 'room', kind: 'group', title: 'Room', ownerPersonId: 'owner', historyVisibility: 'full', seq: 50, revision: 1, createdAt: '' }, members: [], bindings: [], grants: [], bots: [], messages, invocations: [], interactions: [], streams: [], contexts: [], cutoff: 50, readSeq: 0, syncSeq: 0, ...extra }
}
describe('native conversation grouping', () => {
  it('keeps interleaved people and assistants distinct while grouping every process row in its native turn', () => {
    const entries = conversationEntries(room([
      message('commentary', 1), message('other bot', 2, { bindingId: 'other', turn: { ...turn, finalMessageId: 'other bot' } }),
      message('human', 3, { authorKind: 'person', bindingId: undefined, turn: undefined }),
      message('tool', 4, { source: 'tool' }), message('answer', 5),
      message('next answer', 6, { turn: { ...turn, id: 'turn-20', number: 2, finalMessageId: 'next answer' } }),
    ]))
    expect(entries.map(entry => entry.kind)).toEqual(['turn', 'turn', 'message', 'turn'])
    const first = entries[0] as AssistantTurn
    expect(first.messages.map(message => message.id)).toEqual(['commentary', 'tool', 'answer'])
    expect(turnContent(first).process.map(message => message.id)).toEqual(['commentary', 'tool'])
    expect(turnContent(first).answer?.id).toBe('answer')
  })
  it('upgrades old chat presentation without rewriting history and respects native human turn boundaries', () => {
    const entries = conversationEntries(room([
      message('u1', 1, { authorKind: 'person', source: 'desktop', turn: undefined }),
      message('tool', 2, { source: 'tool', turn: undefined }), message('old answer', 3, { turn: undefined }),
      message('u2', 4, { authorKind: 'person', source: 'desktop', turn: undefined }), message('second answer', 5, { turn: undefined }),
    ]))
    const groups = entries.filter((entry): entry is AssistantTurn => entry.kind === 'turn')
    expect(groups).toHaveLength(2)
    expect(turnContent(groups[0]!).answer?.id).toBe('old answer')
    expect(turnContent(groups[1]!).answer?.id).toBe('second answer')
  })
  it('does not split an invocation when its first output is streamed and keeps failed output in the process', () => {
    const snapshot = room([], {
      invocations: [{ id: 'task', bindingId: 'binding', roomId: 'room', messageId: 'human', bindingGeneration: 1, initiatedByPersonId: 'owner', initiatedByDeviceId: 'desktop', requestId: 'rpc', triggerRoomSeq: 1, createdAt: '', updatedAt: '', status: 'running' }],
      streams: [{ roomId: 'room', bindingId: 'binding', invocationId: 'task', messageId: 'stream', attemptId: 'a', streamRevision: 1, index: 0, text: 'Working', turn: { ...turn, status: 'running', endedAt: undefined } }],
    })
    const entries = conversationEntries(snapshot)
    expect(entries).toHaveLength(1)
    expect((entries[0] as AssistantTurn).streams).toHaveLength(1)
    snapshot.invocations[0]!.status = 'recovery_required'
    snapshot.streams = []
    snapshot.messages = [message('partial', 2, { invocationId: 'task', turn: { ...turn, status: 'running', endedAt: undefined } })]
    expect(conversationEntries(snapshot)[0]).toMatchObject({ kind: 'turn', status: 'recovery_required' })
    const failed = { ...entries[0] as AssistantTurn, status: 'failed' as const, messages: [message('partial', 2)] }
    expect(turnContent(failed).answer).toBeUndefined()
    expect(turnContent(failed).process).toHaveLength(1)
  })
  it('drops a persisted stream only in its own binding and retains tasks before their first message', () => {
    const snapshot = room([message('saved', 3, { sessionMessageId: 'shared-id' })], {
      invocations: ['queued', 'completed'].map((status, index) => ({ id: `task-${index}`, bindingId: `task-binding-${index}`, roomId: 'room', messageId: 'not-loaded', bindingGeneration: 1, initiatedByPersonId: 'owner', initiatedByDeviceId: 'desktop', requestId: `request-${index}`, triggerRoomSeq: 1, createdAt: '', updatedAt: '', status: status as 'queued' | 'completed' })),
      streams: ['binding', 'other'].map(bindingId => ({ roomId: 'room', bindingId, messageId: 'shared-id', attemptId: 'attempt', streamRevision: 1, index: 0, text: 'Still streaming' })),
    })
    const groups = conversationEntries(snapshot).filter((entry): entry is AssistantTurn => entry.kind === 'turn')
    expect(groups.find(group => group.bindingId === 'binding')?.streams).toEqual([])
    expect(groups.find(group => group.bindingId === 'other')?.streams).toHaveLength(1)
    expect(groups.find(group => group.task?.id === 'task-0')).toMatchObject({ status: 'queued' })
    expect(groups.some(group => group.task?.id === 'task-1')).toBe(false)
  })
  it('keeps chronological order and only marks the latest unfinished native turn active per binding', () => {
    const snapshot = room([
      message('latest', 4, { turn: undefined }),
      message('finished', 3, { bindingId: 'other' }),
      message('older', 1, { turn: { ...turn, endedAt: undefined } }),
      message('human', 2, { authorKind: 'person', source: 'desktop', turn: undefined }),
    ])
    const entries = conversationEntries(snapshot, new Set(['binding', 'other', 'not-loaded']))
    expect(entries.map(entry => entry.seq)).toEqual([1, 2, 3, 4])
    expect(entries.filter((entry): entry is AssistantTurn => entry.kind === 'turn').map(group => group.status)).toEqual(['completed', 'completed', 'running'])
    expect(snapshot.messages.map(message => message.id)).toEqual(['latest', 'finished', 'older', 'human'])
  })
})
