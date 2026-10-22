import type { ReactNode } from 'react'
import { IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import toolbar from '@deepseek-ai/dsh-client-ui-trajectory/src/client/TrajectoryToolbar.module.css'
import type { Room } from '../../protocol/src/index.ts'
import { AVATAR_PALETTE, WhaleAvatar } from './Avatar.tsx'
import type { Translate } from './locales.ts'
import type { ClientBootstrap, ClientState } from './model.ts'

export function RoomAvatar({ room, bootstrap }: { room: Room; bootstrap: ClientBootstrap }): ReactNode {
  const bots = bootstrap.bindings.filter(binding => binding.active && binding.roomId === room.id).flatMap(binding => { const bot = bootstrap.bots.find(bot => bot.id === binding.botId); return bot ? [bot] : [] })
  if (room.kind === 'direct') return <WhaleAvatar size={16} color={AVATAR_PALETTE[bots[0]?.avatar ?? 'charcoal']} />
  const people = (room.memberIds ?? [room.ownerPersonId]).flatMap(id => { const person = bootstrap.people.find(person => person.id === id); return person ? [person] : [] })
  const faces = [...people.map(person => <span key={person.id} className="bots-person-avatar" title={person.displayName}>{Array.from(person.displayName)[0]}</span>), ...bots.map(bot => <WhaleAvatar key={bot.id} size={12} color={AVATAR_PALETTE[bot.avatar]} />)].slice(0, 3)
  return <span className="bots-room-avatar-stack" data-count={faces.length} aria-hidden>{faces.map((face, index) => <span key={index} className="bots-stack-face">{face}</span>)}</span>
}

export function ChatSwitcher({ state, bootstrap, select, create, t, searchOpen, toggleSearch }: { state: ClientState; bootstrap: ClientBootstrap; select(id: string): void; create(): void; t: Translate; searchOpen: boolean; toggleSearch(): void }): ReactNode {
  const rooms = [...bootstrap.rooms].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return <div className={`${toolbar.root} bots-switcher`} data-native-dsh><div className={toolbar.inner}><div className={`${toolbar.actions} bots-room-strip`} role="tablist" aria-label={t('chats')} onWheel={event => { const strip = event.currentTarget; if (strip.scrollWidth > strip.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) strip.scrollLeft += event.deltaY }}>
    {rooms.map(room => <button role="tab" aria-label={room.title} aria-selected={state.selectedRoomId === room.id} aria-pressed={state.selectedRoomId === room.id} aria-controls="bots-chat-panel" key={room.id} title={room.title} className={`${toolbar.toggle} bots-room-chip`} onClick={() => select(room.id)}><RoomAvatar room={room} bootstrap={bootstrap} /><span className="bots-room-chip-name">{room.title}</span>{state.local.drafts[room.id]?.text && <span className="bots-draft-dot" title={t('draft')} />}{(room.running || bootstrap.bindings.some(binding => binding.roomId === room.id && binding.active && bootstrap.sessions.some(session => session.id === binding.sessionId && session.active))) && <span className="bots-dot bots-dot-active" title={t('running')} />}{!!room.unreadCount && <span className="bots-unread" aria-label={`${room.unreadCount} ${t('newMessage')}`}>{room.unreadCount > 99 ? '99+' : room.unreadCount}</span>}</button>)}
  </div><button className={toolbar.action} aria-label={t('searchMessages')} aria-expanded={searchOpen} onClick={toggleSearch}><IconSearchOutlineRegular size={12} /></button><button className={`${toolbar.action} bots-new-chat`} aria-label={t('newChat')} title={t('newChat')} onClick={create}>＋</button></div></div>
}
