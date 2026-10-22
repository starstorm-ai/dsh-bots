/** Browser state is Host-scoped. Never persist invitation tokens or device secrets. */
import type { MessagePart } from '../../protocol/src/index.ts'
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface PendingMessage { id: string; roomId: string; text: string; mentions: string[]; parts?: MessagePart[]; replyTo?: string; createdAt: number; error?: string }
export interface Draft { text: string; mentions: string[]; replyTo?: string }
export interface LocalState { version: 1; drafts: Record<string, Draft>; outbox: PendingMessage[]; pinned: string[]; selectedRoomId?: string }

export class BrowserPersistence {
  readonly key: string
  constructor(private readonly storage: StorageLike | undefined, hostId: string) { this.key = `dsh-bots:v1:${hostId}` }
  load(): LocalState {
    const empty: LocalState = { version: 1, drafts: {}, outbox: [], pinned: [] }
    try {
      const raw: unknown = JSON.parse(this.storage?.getItem(this.key) ?? 'null')
      if (!raw || typeof raw !== 'object') return empty
      const data = raw as Partial<LocalState>
      if (data.version !== 1) return empty
      const drafts: Record<string, Draft> = {}
      for (const [roomId, value] of Object.entries(data.drafts ?? {})) if (value && typeof value.text === 'string' && Array.isArray(value.mentions)) drafts[roomId] = { text: value.text, mentions: value.mentions.filter(v => typeof v === 'string'), ...(typeof value.replyTo === 'string' ? { replyTo: value.replyTo } : {}) }
      return { version: 1, drafts, outbox: (Array.isArray(data.outbox) ? data.outbox : []).filter(v => v && typeof v.id === 'string' && typeof v.roomId === 'string' && typeof v.text === 'string' && Array.isArray(v.mentions) && v.mentions.every(m => typeof m === 'string') && typeof v.createdAt === 'number'), pinned: (Array.isArray(data.pinned) ? data.pinned : []).filter(v => typeof v === 'string'), ...(typeof data.selectedRoomId === 'string' ? { selectedRoomId: data.selectedRoomId } : {}) }
    } catch { return empty }
  }
  save(state: LocalState): void {
    if (!this.storage) throw new Error('Local storage is unavailable; the message has not been sent')
    // Propagate quota/privacy failures: silently losing a pending message is unacceptable.
    this.storage.setItem(this.key, JSON.stringify(state))
  }
}
