import { PROTOCOL_VERSION } from '../packages/protocol/src/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bootstrap, Message, RoomEvent, RoomSnapshot } from '../packages/protocol/src/index.ts'
import { BotsClientModel, mergeMessages, messageParts, type BotsRemoteAdapter, type UiCommand } from '../packages/desktop-ui/src/model.ts'
import { BrowserPersistence, type StorageLike } from '../packages/desktop-ui/src/persistence.ts'
import { questionAnswer } from '../packages/desktop-ui/src/interactions.ts'

class MemoryStorage implements StorageLike {
  values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}
const bootstrap = (): Bootstrap => ({
  version: PROTOCOL_VERSION, hostId: 'host-a', hostName: 'My DSH', storeEpoch: 'epoch-1', person: { id: 'owner', displayName: 'Me', hostRole: 'owner' }, device: { id: 'desktop', personId: 'owner', name: 'Desktop', createdAt: '', lastSeenAt: '' }, rooms: [{ id: 'room-a', kind: 'group', title: 'Team', ownerPersonId: 'owner', historyVisibility: 'full', seq: 0, revision: 1, createdAt: '2026-10-21T00:00:00Z' }], bots: [{ id: 'bot-a', name: 'Whale', avatar: 'blue', instructions: '', instructionsVersion: 1, defaultWorkspaceId: 'ws', defaultPresetId: '', enabled: true }], bindings: [], people: [], devices: [], workspaces: [], presets: [], sessions: [], capabilities: { contextInjection: true, runningContextInjection: true, interactions: true }, schedulerPaused: false
})
const snapshot = (): RoomSnapshot => ({ room: bootstrap().rooms[0]!, members: [], bindings: [], grants: [], bots: bootstrap().bots, messages: [], invocations: [], interactions: [], streams: [], contexts: [], cutoff: 0, readSeq: 0, syncSeq: 0 })
function remote(options: Partial<BotsRemoteAdapter> = {}): BotsRemoteAdapter {
  return { bootstrap: async () => bootstrap(), snapshot: async () => snapshot(), history: async () => [], command: async () => ({}), stream: async function* (_request, signal) { await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) }); }, ...options }
}
const models: BotsClientModel[] = []
afterEach(() => { models.splice(0).forEach(model => model.dispose()); vi.useRealTimers() })
function model(adapter: BotsRemoteAdapter, storage = new MemoryStorage()): BotsClientModel { const value = new BotsClientModel(adapter, storage, 'profile-1'); models.push(value); return value }

describe('durable desktop outbox', () => {
  it('drains messages added while an earlier send is awaiting acknowledgement', async () => {
    let acknowledge: (() => void) | undefined
    const received: string[] = []
    const client = model(remote({ command: async command => {
      if (command.type !== 'message.send') return {}
      received.push(command.payload.clientMessageId)
      if (received.length === 1) await new Promise<void>(resolve => { acknowledge = resolve })
      return {}
    } }))
    await client.start()
    const first = client.send('room-a', { text: 'first', mentions: [] })
    await client.send('room-a', { text: 'second', mentions: [] })
    expect(client.getSnapshot().local.outbox).toHaveLength(2)
    acknowledge?.(); await first
    expect(received).toHaveLength(2); expect(client.getSnapshot().local.outbox).toHaveLength(0)
  })
  it('persists the same client/request identity before sending and replays it after uncertain network delivery', async () => {
    const storage = new MemoryStorage(); const received: UiCommand[] = []; let first = true
    const adapter = remote({ command: async command => { received.push(command); if (command.type === 'message.send' && first) { first = false; throw Object.assign(new Error('Network disconnected after acceptance'), { code: 'gateway/disconnected' }) } return {} } })
    const client = model(adapter, storage); await client.start()
    client.setDraft('room-a', { text: 'Run this', mentions: ['bot-a'] })
    await client.send('room-a', { text: 'Run this', mentions: ['bot-a'] })
    expect(client.getSnapshot().connection).toBe('offline')
    const queued = client.getSnapshot().local.outbox[0]!
    expect(queued.text).toBe('Run this'); expect(client.getSnapshot().local.drafts['room-a']?.text).toBe('')
    const persisted = new BrowserPersistence(storage, 'profile-1:host-a:epoch-1').load()
    expect(persisted.outbox[0]?.id).toBe(queued.id)
    client.dispose()
    const resumed = model(adapter, storage); await resumed.start()
    const sends = received.filter(c => c.type === 'message.send')
    expect(sends).toHaveLength(2); expect(sends[0]!.id).toBe(sends[1]!.id)
    expect(sends[1]?.type === 'message.send' && sends[1].payload.parts).toEqual([{ type: 'mention', botId: 'bot-a', label: 'Whale' }, { type: 'text', text: 'Run this' }])
    expect(resumed.getSnapshot().local.outbox).toEqual([])
  })

  it('does not acknowledge or send when durable local storage is full', async () => {
    const storage = new MemoryStorage(); const command = vi.fn(async () => ({})); const client = model(remote({ command }), storage)
    await client.start(); client.setDraft('room-a', { text: 'keep this', mentions: [] })
    storage.setItem = () => { throw new Error('quota exceeded') }
    await expect(client.send('room-a', { text: 'keep this', mentions: [] })).rejects.toThrow('quota exceeded')
    expect(client.getSnapshot().local.drafts['room-a']?.text).toBe('keep this'); expect(command).not.toHaveBeenCalled()
  })

  it('keeps business failures visible and requires an explicit retry', async () => {
    let denied = true; const command = vi.fn(async (input: UiCommand) => { if (input.type === 'message.send' && denied) throw Object.assign(new Error('No invocation grant'), { code: 'FORBIDDEN' }); return {} })
    const client = model(remote({ command })); await client.start(); await client.send('room-a', { text: 'task', mentions: ['bot-a'] })
    expect(client.getSnapshot().connection).toBe('online'); const queued = client.getSnapshot().local.outbox[0]!
    expect(queued.error).toBe('No invocation grant'); await client.reconnect(); expect(command).toHaveBeenCalledTimes(1)
    denied = false; await client.retryMessage(queued.id); expect(command).toHaveBeenCalledTimes(2); expect(client.getSnapshot().local.outbox).toHaveLength(0)
  })

  it('keeps original mention labels during replay even if the assistant was renamed', async () => {
    let renamed = false; const sent: UiCommand[] = []; let failOnce = true
    const adapter = remote({ bootstrap: async () => { const value = bootstrap(); if (renamed) value.bots[0]!.name = 'New name'; return value }, command: async command => { sent.push(command); if (failOnce) { failOnce = false; throw new Error('Network disconnected') } return {} } })
    const client = model(adapter); await client.start(); await client.send('room-a', { text: 'Task', mentions: ['bot-a'] })
    renamed = true; await client.reconnect(); expect(sent).toHaveLength(2); expect(sent[0]).toEqual(sent[1])
  })

  it('does not replay another host or database epoch’s messages', async () => {
    const storage = new MemoryStorage()
    new BrowserPersistence(storage, 'profile-1:host-a:old-epoch').save({ version: 1, drafts: {}, pinned: [], outbox: [{ id: 'stale', roomId: 'room-a', text: 'private', mentions: [], createdAt: 1 }] })
    const command = vi.fn(async () => ({})); const client = model(remote({ command }), storage); await client.start()
    expect(command).not.toHaveBeenCalled(); expect(client.getSnapshot().local.outbox).toHaveLength(0)
  })
})

describe('chat projections and lifecycle', () => {
  it('starts without selecting a chat and restores only an explicit selection', async () => {
    const storage = new MemoryStorage(); const client = model(remote(), storage); await client.start()
    expect(client.getSnapshot().selectedRoomId).toBeUndefined()
    await client.selectRoom('room-a'); client.setDraft('room-a', { text: 'Keep my draft', mentions: ['bot-a'] })
    client.dispose(); const resumed = model(remote(), storage); await resumed.start()
    expect(resumed.getSnapshot().selectedRoomId).toBe('room-a')
    expect(resumed.getSnapshot().local.drafts['room-a']).toEqual({ text: 'Keep my draft', mentions: ['bot-a'] })
  })
  it('preselects an authorized direct assistant but preserves removing it for context-only sends', async () => {
    const snap = snapshot(); snap.room.kind = 'direct'; snap.bindings = [{ id: 'binding-a', roomId: 'room-a', botId: 'bot-a', sessionId: 's', workspaceId: 'ws', generation: 1, active: true, publishFromSessionSeq: 0, projectionSeq: 0 }]
    const sent: UiCommand[] = []
    const client = model(remote({ snapshot: async () => snap, command: async command => { sent.push(command); return {} } })); await client.start(); await client.selectRoom('room-a')
    expect(client.defaultDraft('room-a').mentions).toEqual(['bot-a'])
    client.setDraft('room-a', { text: 'Only context', mentions: [] }); await client.selectRoom('room-a')
    expect(client.getSnapshot().local.drafts['room-a']?.mentions).toEqual([])
    await client.send('room-a', client.getSnapshot().local.drafts['room-a']!)
    expect(sent.find(command => command.type === 'message.send')).toMatchObject({ payload: { parts: [{ type: 'text', text: 'Only context' }] } })
    expect(client.getSnapshot().local.drafts['room-a']?.mentions).toEqual(['bot-a'])
    client.saveScroll('room-a', { top: 40, bottom: false }); expect(client.readScroll('room-a')).toEqual({ top: 40, bottom: false })
  })
  it('serializes mixed multi-select and custom question answers separately', () => {
    expect(questionAnswer([{ id: 'choice', question: 'Choose', options: ['A', 'B'], multiple: true }], { choice: ['A', 'Custom value'] })).toEqual({ answers: { choice: ['A'] }, custom: { choice: 'Custom value' } })
    expect(questionAnswer([{ id: 'single', question: 'Choose', options: ['A'] }, { id: 'free', question: 'Explain' }], { single: ['Other'], free: ['Free-form text'] })).toEqual({ answers: { single: [], free: [] }, custom: { single: 'Other', free: 'Free-form text' } })
  })
  it('uses structured mentions rather than parsing message text as authority', () => {
    expect(messageParts({ text: '@Whale this is plain context', mentions: [] }, bootstrap().bots)).toEqual([{ type: 'text', text: '@Whale this is plain context' }])
  })
  it('replaces stream checkpoints and rejects reordered chunks', async () => {
    const client = model(remote()); await client.start()
    await client.selectRoom('room-a')
    const event = (index: number, text: string): RoomEvent => ({ version: 1, kind: 'event', roomId: 'room-a', type: 'stream.updated', payload: { roomId: 'room-a', bindingId: 'b', messageId: 'm', attemptId: 'a', streamRevision: 1, index, text } })
    client.onEvent(event(2, 'hello')); client.onEvent(event(1, 'he')); client.onEvent(event(3, 'hello world'))
    expect(client.getSnapshot().rooms['room-a']?.streams[0]?.text).toBe('hello world')
    expect(client.getSnapshot().rooms['room-a']?.streams).toHaveLength(1)
    client.onEvent(event(3, ''))
    expect(client.getSnapshot().rooms['room-a']?.streams).toHaveLength(0)
  })
  it('merges history without duplicates and keeps newest persisted content', () => {
    const message = { id: 'm', seq: 2, text: 'before' } as Message
    expect(mergeMessages([message], [{ ...message, text: 'after' }, { ...message, id: 'first', seq: 1 }])).toMatchObject([{ id: 'first' }, { id: 'm', text: 'after' }])
  })
  it('fills pages missed during disconnect before joining cached and new history', async () => {
    const message = (seq: number): Message => ({ id: `m-${seq}`, roomId: 'room-a', seq, authorKind: 'person', authorId: 'owner', authorName: 'Me', parts: [{ type: 'text', text: String(seq) }], text: String(seq), createdAt: '' })
    let disconnectedGap = false
    const history = vi.fn(async ({ beforeSeq }: { beforeSeq?: number }) => ({ messages: beforeSeq === 201 ? [message(101), message(200)] : [message(1), message(100)], hasMore: true }))
    const client = model(remote({ snapshot: async () => ({ ...snapshot(), messages: disconnectedGap ? [message(201)] : [message(1)] }), history }))
    await client.start(); await client.selectRoom('room-a'); disconnectedGap = true; await client.reconnect()
    expect(client.getSnapshot().rooms['room-a']?.messages.map(m => m.seq)).toEqual([1, 100, 101, 200, 201])
    expect(history).toHaveBeenCalledTimes(2)
  })
  it('projects native session activity without fabricating a chat invocation', async () => {
    const client = model(remote()); await client.start()
    await client.selectRoom('room-a')
    client.onEvent({ version: 1, kind: 'event', roomId: 'room-a', type: 'session.activity', payload: { bindingId: 'binding-a', status: 'running', source: 'desktop' } })
    expect(client.getSnapshot().nativeActivities['binding-a']).toEqual({ status: 'running' })
    expect(client.getSnapshot().rooms['room-a']?.invocations).toEqual([])
  })
  it('does not resurrect a finished stream from a snapshot already in flight', async () => {
    const live = { roomId: 'room-a', bindingId: 'b', messageId: 'm', attemptId: 'a', streamRevision: 1, index: 3, text: 'hello' }
    let finishSnapshot: ((value: RoomSnapshot) => void) | undefined; let delayed = false
    const adapter = remote({ snapshot: async () => delayed ? new Promise<RoomSnapshot>(resolve => { finishSnapshot = resolve }) : snapshot() })
    const client = model(adapter); await client.start(); delayed = true
    const loading = client.selectRoom('room-a')
    client.onEvent({ version: 1, kind: 'event', type: 'stream.updated', payload: { ...live, text: '' } })
    finishSnapshot?.({ ...snapshot(), streams: [live] }); await loading
    expect(client.getSnapshot().rooms['room-a']?.streams).toEqual([])
  })
  it('cancels the live event stream when disposed and never updates subscribers afterwards', async () => {
    let streamSignal: AbortSignal | undefined
    const client = model(remote({ stream: async function* (_request, signal) { streamSignal = signal; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) } }))
    await client.start(); const notify = vi.fn(); client.subscribe(notify); client.dispose()
    expect(streamSignal?.aborted).toBe(true); client.onEvent({ version: 1, kind: 'event', type: 'message.created', payload: {} }); expect(notify).not.toHaveBeenCalled()
  })
  it('recovers malformed local cache without modifying unrelated host entries', () => {
    const storage = new MemoryStorage(); storage.setItem('dsh-bots:v1:host-a', '{broken'); storage.setItem('unrelated', 'keep')
    expect(new BrowserPersistence(storage, 'host-a').load().outbox).toEqual([]); expect(storage.getItem('unrelated')).toBe('keep')
  })
})
