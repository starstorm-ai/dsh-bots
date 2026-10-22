import { LIMITS, type Bootstrap, type Command, type InvocationStatus, type Message, type MessagePart, type RoomEvent, type RoomSnapshot, type StreamSnapshot } from '../../protocol/src/index.ts'
import { BrowserPersistence, type Draft, type LocalState, type PendingMessage, type StorageLike } from './persistence.ts'

export type ClientBootstrap = Bootstrap
export type UiCommand = Command
export type RemoteResponse<T> = T | { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }
export interface BotsRemoteAdapter {
  bootstrap(request: Record<string, never>, signal: AbortSignal): Promise<RemoteResponse<ClientBootstrap>>
  command(command: UiCommand, signal: AbortSignal): Promise<RemoteResponse<unknown>>
  snapshot(request: { roomId: string }, signal: AbortSignal): Promise<RemoteResponse<RoomSnapshot>>
  history(request: { roomId: string; beforeSeq?: number; limit?: number; search?: string }, signal: AbortSignal): Promise<RemoteResponse<Message[] | { messages: Message[] }>>
  stream(request: { roomId?: string; afterSeq?: number }, signal: AbortSignal): AsyncIterable<RoomEvent>
}
export interface ClientState {
  connection: 'loading' | 'online' | 'offline' | 'reconnecting'
  bootstrap?: ClientBootstrap
  rooms: Record<string, RoomSnapshot>
  selectedRoomId?: string
  loadingRoom: boolean
  local: LocalState
  error?: string
  pending: number
  nativeActivities: Record<string, { status: InvocationStatus; error?: string }>
}
const emptyLocal = (): LocalState => ({ version: 1, drafts: {}, outbox: [], pinned: [] })
const textEncoder = new TextEncoder()

export function unwrap<T>(result: RemoteResponse<T>): T {
  if (result && typeof result === 'object' && 'ok' in result) {
    const response = result as { ok: boolean; value?: T; error?: { code?: string; message?: string } }
    if (!response.ok) throw Object.assign(new Error(response.error?.message ?? 'Request failed'), { code: response.error?.code })
    return response.value as T
  }
  return result as T
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error) }
export function isTransportError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return /gateway\/(?:disconnected|cancelled|unavailable|transport)|CONNECTION|OFFLINE/.test(code) || error instanceof TypeError || /disconnect|network|connection|transport|fetch failed|socket/i.test(errorText(error))
}
export function messageParts(draft: Pick<Draft, 'text' | 'mentions'>, bots: Bootstrap['bots']): MessagePart[] {
  return [...draft.mentions.flatMap(botId => { const bot = bots.find(b => b.id === botId); return bot ? [{ type: 'mention' as const, botId, label: bot.name }] : [] }), { type: 'text', text: draft.text }]
}
export function mergeMessages(current: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map(current.map(m => [m.id, m]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
}

/** Owns a Host-scoped durable outbox, reconnect backoff, cancellation and observable projections. */
export class BotsClientModel {
  private state: ClientState = { connection: 'loading', rooms: {}, loadingRoom: false, local: emptyLocal(), pending: 0, nativeActivities: {} }
  private listeners = new Set<() => void>()
  private lifetime = new AbortController()
  private live = true
  private connecting: Promise<void> | undefined
  private generation = 0
  private streamAbort: AbortController | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  private flushing = false
  private persistence: BrowserPersistence | undefined
  private roomGeneration = 0
  private refreshRunning = false
  private refreshAgain = false
  private eventRevision = 0
  private streamMutations = new Map<string, { revision: number; stream: StreamSnapshot }>()

  constructor(private readonly remote: BotsRemoteAdapter, private readonly storage?: StorageLike, private readonly scope = 'desktop') {
    try {
      const cached = JSON.parse(storage?.getItem(`dsh-bots:cache:${scope}`) ?? 'null') as { bootstrap?: ClientBootstrap; rooms?: Record<string, RoomSnapshot> } | null
      if (cached?.bootstrap?.hostId && Array.isArray(cached.bootstrap.rooms)) {
        this.persistence = new BrowserPersistence(storage, `${scope}:${cached.bootstrap.hostId}:${cached.bootstrap.storeEpoch}`)
        const local = this.persistence.load()
        this.state = { ...this.state, bootstrap: cached.bootstrap, rooms: cached.rooms ?? {}, local, ...(local.selectedRoomId ? { selectedRoomId: local.selectedRoomId } : {}), connection: 'offline' }
      }
    } catch { /* Invalid display cache is disposable; the separately stored outbox is not touched. */ }
  }
  getSnapshot = (): ClientState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<ClientState>): void {
    if (!this.live) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private persistLocal(local: LocalState): void { this.persistence?.save(local); this.publish({ local }) }
  private cache(): void {
    try { this.storage?.setItem(`dsh-bots:cache:${this.scope}`, JSON.stringify({ bootstrap: this.state.bootstrap, rooms: this.state.rooms })) } catch { /* Cache is optional; drafts/outbox writes still fail visibly. */ }
  }
  clearError(): void { this.publish({ error: undefined }) }
  start(): Promise<void> { return this.reconnect() }
  reconnect(): Promise<void> {
    if (!this.live) return Promise.resolve()
    if (this.connecting) return this.connecting
    clearTimeout(this.reconnectTimer)
    this.streamAbort?.abort()
    const generation = ++this.generation
    this.publish({ connection: this.state.bootstrap ? 'reconnecting' : 'loading' })
    this.connecting = (async () => {
      try {
        const bootstrap = unwrap(await this.remote.bootstrap({}, this.lifetime.signal))
        if (!this.live || generation !== this.generation) return
        const changedHost = this.state.bootstrap?.hostId !== bootstrap.hostId || this.state.bootstrap?.storeEpoch !== bootstrap.storeEpoch
        if (changedHost || !this.persistence) {
          this.persistence = new BrowserPersistence(this.storage, `${this.scope}:${bootstrap.hostId}:${bootstrap.storeEpoch}`)
          this.publish({ local: this.persistence.load(), rooms: {}, nativeActivities: {} })
        }
        const local = this.state.local
        const selectedRoomId = bootstrap.rooms.some(r => r.id === local.selectedRoomId) ? local.selectedRoomId : undefined
        this.publish({ bootstrap, connection: 'online', selectedRoomId, error: undefined })
        this.failures = 0
        this.cache()
        // Subscribe before loading snapshots. Events racing the initial snapshot trigger a refresh.
        this.watch(generation)
        if (selectedRoomId) await this.selectRoom(selectedRoomId)
        await this.flush()
      } catch (error) {
        if (this.live && generation === this.generation) this.disconnected(error)
      } finally { this.connecting = undefined }
    })()
    return this.connecting
  }
  private disconnected(error: unknown): void {
    if (!this.live) return
    this.streamAbort?.abort()
    this.publish({ connection: 'offline', loadingRoom: false, error: errorText(error) })
    clearTimeout(this.reconnectTimer)
    const delay = Math.min(30_000, 800 * 2 ** Math.min(this.failures++, 6))
    this.reconnectTimer = setTimeout(() => { void this.reconnect() }, delay)
  }
  private watch(generation: number): void {
    const controller = new AbortController()
    this.streamAbort = controller
    void (async () => {
      try {
        for await (const event of this.remote.stream({}, controller.signal)) {
          if (!this.live || generation !== this.generation || controller.signal.aborted) return
          this.onEvent(event)
        }
        if (!controller.signal.aborted && this.live && generation === this.generation) this.disconnected(new Error('Host event stream disconnected'))
      } catch (error) {
        if (!controller.signal.aborted && this.live && generation === this.generation) this.disconnected(error)
      }
    })()
  }
  onEvent(event: RoomEvent): void {
    if (!this.live) return
    if (event.type === 'heartbeat') return
    if (event.type === 'session.activity' && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && typeof event.payload.bindingId === 'string' && typeof event.payload.status === 'string') {
      const activity = event.payload
      this.publish({ nativeActivities: { ...this.state.nativeActivities, [activity.bindingId as string]: { status: activity.status as InvocationStatus, ...(typeof activity.error === 'string' ? { error: activity.error } : {}) } } })
    }
    if (event.type === 'stream.updated' && event.payload && typeof event.payload === 'object') {
      const stream = event.payload as unknown as StreamSnapshot
      const last = this.streamMutations.get(`${stream.roomId}:${stream.messageId}`)?.stream
      if (last?.attemptId === stream.attemptId && (stream.streamRevision < last.streamRevision || (stream.streamRevision === last.streamRevision && (stream.index < last.index || (stream.index === last.index && stream.text !== ''))))) return
      this.streamMutations.set(`${stream.roomId}:${stream.messageId}`, { revision: ++this.eventRevision, stream })
      const room = this.state.rooms[stream.roomId]
      if (room) {
        if (!stream.text) { this.publish({ rooms: { ...this.state.rooms, [stream.roomId]: { ...room, streams: room.streams.filter(item => item.messageId !== stream.messageId) } } }); return }
        const previous = room.streams.find(item => item.messageId === stream.messageId)
        if (!previous || previous.attemptId !== stream.attemptId || previous.streamRevision < stream.streamRevision || (previous.streamRevision === stream.streamRevision && previous.index < stream.index)) {
          this.publish({ rooms: { ...this.state.rooms, [stream.roomId]: { ...room, streams: [...room.streams.filter(item => item.messageId !== stream.messageId), stream] } } })
        }
      }
      return
    }
    // Snapshot refresh coalesces durable events; stream checkpoints above stay responsive.
    if (this.refreshRunning) this.refreshAgain = true
    if (!this.refreshTimer) this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh() }, 90)
  }
  async refresh(): Promise<void> {
    if (!this.live || this.state.connection !== 'online') return
    if (this.refreshRunning) { this.refreshAgain = true; return }
    this.refreshRunning = true
    try {
      const bootstrap = unwrap(await this.remote.bootstrap({}, this.lifetime.signal))
      if (!this.live) return
      this.publish({ bootstrap })
      const roomId = this.state.selectedRoomId
      if (roomId && bootstrap.rooms.some(r => r.id === roomId)) await this.loadRoom(roomId)
      else if (roomId) this.publish({ selectedRoomId: undefined })
      this.cache()
    } catch (error) { if (isTransportError(error)) this.disconnected(error); else this.publish({ error: errorText(error) }) }
    finally {
      this.refreshRunning = false
      if (this.refreshAgain) { this.refreshAgain = false; this.onEvent({ version: 1, kind: 'event', type: 'refresh', payload: {} }) }
    }
  }
  async selectRoom(roomId: string): Promise<void> {
    const local = { ...this.state.local, selectedRoomId: roomId }
    try { this.persistLocal(local) } catch (error) { this.publish({ local, error: errorText(error) }) }
    this.publish({ selectedRoomId: roomId })
    if (this.state.connection !== 'online') return
    await this.loadRoom(roomId, true)
  }
  private async loadRoom(roomId: string, showLoading = false): Promise<void> {
    const generation = ++this.roomGeneration
    const streamCursor = this.eventRevision
    if (showLoading) this.publish({ loadingRoom: true })
    try {
      const snapshot = unwrap(await this.remote.snapshot({ roomId }, this.lifetime.signal))
      if (!this.live || generation !== this.roomGeneration) return
      const current = this.state.rooms[roomId]
      const previousLast = current?.messages.at(-1)?.seq
      let messages = snapshot.messages
      // A snapshot contains the latest page. Fill a disconnected gap before joining
      // it to an older local page, otherwise >100 missed messages would be hidden.
      const initialBefore = messages[0]?.seq
      if (previousLast !== undefined && initialBefore !== undefined && initialBefore > previousLast) {
        let beforeSeq: number = initialBefore
        while (beforeSeq > previousLast) {
          const page: Message[] | { messages: Message[] } = unwrap(await this.remote.history({ roomId, beforeSeq, limit: LIMITS.historyPage }, this.lifetime.signal))
          if (!this.live || generation !== this.roomGeneration) return
          const older: Message[] = Array.isArray(page) ? page : page.messages
          if (!older.length) break
          messages = mergeMessages(older, messages)
          const next: number = older[0]!.seq
          if (next >= beforeSeq) break
          beforeSeq = next
        }
      }
      const streams = new Map(snapshot.streams.map(stream => [stream.messageId, stream]))
      for (const { revision, stream } of this.streamMutations.values()) if (revision > streamCursor && stream.roomId === roomId) { if (stream.text) streams.set(stream.messageId, stream); else streams.delete(stream.messageId) }
      const merged = { ...snapshot, messages: mergeMessages(current?.messages ?? [], messages), streams: [...streams.values()] }
      this.publish({ rooms: { ...this.state.rooms, [roomId]: merged }, loadingRoom: false })
      this.cache()
    } catch (error) { if (generation === this.roomGeneration) { this.publish({ loadingRoom: false }); throw error } }
  }
  async markRead(roomId: string, seq: number): Promise<void> {
    const room = this.state.bootstrap?.rooms.find(r => r.id === roomId)
    if (!room || (room.readSeq ?? 0) >= seq || this.state.connection !== 'online') return
    unwrap(await this.remote.command({ type: 'read.update', payload: { roomId, seq } }, this.lifetime.signal))
    if (this.state.bootstrap) this.publish({ bootstrap: { ...this.state.bootstrap, rooms: this.state.bootstrap.rooms.map(r => r.id === roomId ? { ...r, readSeq: seq, unreadCount: 0 } : r) } })
  }
  setDraft(roomId: string, draft: Draft): void { this.persistLocal({ ...this.state.local, drafts: { ...this.state.local.drafts, [roomId]: draft } }) }
  private readonly scrollPositions = new Map<string, { top: number; bottom: boolean }>()
  saveScroll(roomId: string, position: { top: number; bottom: boolean }): void { this.scrollPositions.set(roomId, position) }
  readScroll(roomId: string): { top: number; bottom: boolean } | undefined { return this.scrollPositions.get(roomId) }
  defaultDraft(roomId: string): Draft {
    const room = this.state.rooms[roomId]
    const bot = room?.bots.find(bot => bot.enabled && room.bindings.some(b => b.active && b.botId === bot.id))
    const allowed = this.state.bootstrap?.person.hostRole === 'owner' || room?.grants.some(g => g.canInvoke && g.personId === this.state.bootstrap?.person.id && room.bindings.some(b => b.active && b.id === g.bindingId && b.botId === bot?.id))
    return { text: '', mentions: room?.room.kind === 'direct' && bot && allowed ? [bot.id] : [] }
  }
  async send(roomId: string, draft: Draft): Promise<void> {
    if (!draft.text.trim()) return
    if (textEncoder.encode(draft.text).length > LIMITS.messageBytes) throw new Error('Message exceeds 32 KiB')
    const parts = messageParts(draft, this.state.bootstrap?.bots ?? [])
    if (textEncoder.encode(JSON.stringify(parts)).length > LIMITS.messageBytes) throw new Error('Message exceeds 32 KiB')
    const pending: PendingMessage = { id: crypto.randomUUID(), roomId, text: draft.text, mentions: draft.mentions, parts, ...(draft.replyTo ? { replyTo: draft.replyTo } : {}), createdAt: Date.now() }
    // Persist before acknowledging the composer. A storage failure leaves its draft intact.
    this.persistLocal({ ...this.state.local, outbox: [...this.state.local.outbox, pending], drafts: { ...this.state.local.drafts, [roomId]: this.defaultDraft(roomId) } })
    await this.flush()
  }
  async retryMessage(id: string): Promise<void> { this.persistLocal({ ...this.state.local, outbox: this.state.local.outbox.map(m => m.id === id ? { ...m, error: undefined } : m) }); await this.flush() }
  discardMessage(id: string): void { this.persistLocal({ ...this.state.local, outbox: this.state.local.outbox.filter(m => m.id !== id) }) }
  private async flush(): Promise<void> {
    if (this.flushing || this.state.connection !== 'online' || !this.live) return
    this.flushing = true
    try {
      while (true) {
        if (!this.live || this.state.connection !== 'online') break
        // A second send can arrive while the previous command is in flight.
        // Read the live queue so it never waits for an unrelated reconnect.
        const item = this.state.local.outbox.find(message => !message.error)
        if (!item) break
        try {
          const parts = item.parts ?? messageParts(item, this.state.bootstrap?.bots ?? [])
          if (!item.parts) this.persistLocal({ ...this.state.local, outbox: this.state.local.outbox.map(message => message.id === item.id ? { ...message, parts } : message) })
          unwrap(await this.remote.command({ id: item.id, type: 'message.send', payload: { clientMessageId: item.id, roomId: item.roomId, parts, ...(item.replyTo ? { replyToMessageId: item.replyTo } : {}) } }, this.lifetime.signal))
          this.persistLocal({ ...this.state.local, outbox: this.state.local.outbox.filter(m => m.id !== item.id) })
        } catch (error) {
          if (isTransportError(error)) { this.disconnected(error); break }
          this.persistLocal({ ...this.state.local, outbox: this.state.local.outbox.map(m => m.id === item.id ? { ...m, error: errorText(error) } : m) })
        }
      }
    } finally { this.flushing = false }
    // Refresh must not hold the queue lock: the initial/reconnect refresh can
    // still be running when a user submits their first message.
    await this.refresh()
  }
  async command(command: UiCommand): Promise<unknown> {
    this.publish({ pending: this.state.pending + 1 })
    try {
      const value = unwrap(await this.remote.command({ ...command, id: command.id ?? crypto.randomUUID() }, this.lifetime.signal))
      await this.refresh()
      return value
    } catch (error) { this.publish({ error: errorText(error) }); throw error }
    finally { this.publish({ pending: Math.max(0, this.state.pending - 1) }) }
  }
  async history(roomId: string, options: { beforeSeq?: number; search?: string } = {}): Promise<Message[]> {
    const result = unwrap(await this.remote.history({ roomId, ...options, limit: LIMITS.historyPage }, this.lifetime.signal))
    const messages = Array.isArray(result) ? result : result.messages
    if (!options.search && this.state.rooms[roomId]) this.publish({ rooms: { ...this.state.rooms, [roomId]: { ...this.state.rooms[roomId]!, messages: mergeMessages(this.state.rooms[roomId]!.messages, messages) } } })
    return messages
  }
  dispose(): void {
    if (!this.live) return
    this.live = false; this.generation++; this.lifetime.abort(); this.streamAbort?.abort()
    clearTimeout(this.reconnectTimer); clearTimeout(this.refreshTimer); this.listeners.clear()
  }
}
