import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Bot } from '../../protocol/src/index.ts'
import { AVATAR_PALETTE, WhaleAvatar } from './Avatar.tsx'
import { Chat } from './Chat.tsx'
import { ChatSwitcher } from './ChatSwitcher.tsx'
import { NativeHeader, type BotsTab } from './NativeHeader.tsx'
import type { NativeTranslate } from './NativeTranscript.tsx'
import { ErrorNotice } from './components.tsx'
import { InviteDialog } from './InviteDialog.tsx'
import type { SessionPickerLocale } from './NativeSessionPicker.tsx'
import { BotForm, ChatForm, DeleteBotForm } from './forms.tsx'
import { translate } from './locales.ts'
import { errorText, type BotsClientModel } from './model.ts'
import { RoomDetails } from './RoomDetails.tsx'

export interface AppProps { model: BotsClientModel; locale: { getSnapshot(): string; subscribe(listener: () => void): () => void }; openSession(id: string): void; nativeChatT: NativeTranslate; nativeConversationT: NativeTranslate; nativeSessionT: SessionPickerLocale }
type DialogState = { kind: 'bot'; bot?: Bot } | { kind: 'delete-bot'; bot: Bot } | { kind: 'chat' } | { kind: 'details' } | { kind: 'binding' } | { kind: 'invite'; roomId: string }
type Tab = BotsTab
const tabs: Tab[] = ['chats', 'assistants']

export function BotsApp({ model, locale, openSession, nativeChatT, nativeConversationT, nativeSessionT }: AppProps): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const update = (): void => { element.style.setProperty('--dsh-conversation-column-width', `${element.clientWidth}px`) }
    const observer = new ResizeObserver(update); observer.observe(element); update()
    return () => observer.disconnect()
  }, [])
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
  const language = useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot)
  const t = translate(language)
  const chatT = useMemo<NativeTranslate>(() => (key, params) => nativeChatT(key, params), [nativeChatT, language])
  const [searchOpen, setSearchOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('chats')
  const [dialog, setDialog] = useState<DialogState>()
  const [localError, setLocalError] = useState<string>()
  useEffect(() => { void model.start() }, [model])
  const bootstrap = state.bootstrap
  const room = state.selectedRoomId ? state.rooms[state.selectedRoomId] : undefined
  const activeRoom = bootstrap?.rooms.find(room => room.id === state.selectedRoomId)
  const title = tab === 'chats' ? activeRoom?.title ?? '' : ''
  const act = (operation: Promise<unknown>): void => { void operation.catch(error => setLocalError(errorText(error))) }
  const close = (): void => setDialog(undefined)
  const invite = (): void => { if (room) setDialog({ kind: 'invite', roomId: room.room.id }) }
  return <div ref={root} className="dsh-bots-app" data-connection={state.connection}>
    <NativeHeader title={title} tabs={tabs.map(id => ({ id, label: t(id) }))} selected={tab} select={setTab} t={nativeConversationT} corner={<div className="bots-native-header-actions">{state.connection !== 'online' && <button className="bots-text-button" onClick={() => { void model.reconnect() }}>{t(state.connection === 'offline' ? 'retryConnection' : 'reconnecting')}</button>}{tab === 'chats' && room && <button className="bots-native-menu" aria-label={t('settings')} onClick={() => setDialog({ kind: 'details' })}>{'\u00b7\u00b7\u00b7'}</button>}</div>} />
    {(state.error || localError) && <div className="bots-global-error"><ErrorNotice error={localError ?? state.error} /><button aria-label={t('close')} onClick={() => { model.clearError(); setLocalError(undefined) }}>×</button></div>}
    {bootstrap?.schedulerPaused && <div className="bots-paused" role="status">{t('paused')}<button onClick={() => act(model.command({ type: 'scheduler.update', payload: { paused: false } }))}>{t('resume')}</button></div>}
    {!bootstrap ? <div className="bots-welcome"><p>{state.connection === 'loading' ? t('loading') : t('connectionError')}</p></div> : <>
      {tab === 'chats' && <div className="bots-chat-layout" id="bots-panel-chats" role="tabpanel" aria-label={t('chats')}>
        <ChatSwitcher state={state} bootstrap={bootstrap} t={t} searchOpen={searchOpen} toggleSearch={() => setSearchOpen(!searchOpen)} select={id => act(model.selectRoom(id))} create={() => setDialog(bootstrap.bots.length ? { kind: 'chat' } : { kind: 'bot' })} />
        <div id="bots-chat-panel" className="bots-chat-panel">{room ? <Chat key={room.room.id} room={room} state={state} model={model} openSession={openSession} t={t} nativeT={chatT} searchOpen={searchOpen} invite={invite} /> : <div className="bots-welcome"><WhaleAvatar size={96} /><h2>{state.loadingRoom ? t('loadingRoom') : t('selectChat')}</h2><p>{bootstrap.rooms.length ? t('selectChatHint') : t('noRoomsHint')}</p><div className="bots-actions"><button onClick={() => { setTab('assistants'); setDialog({ kind: 'bot' }) }}>{t('newAssistant')}</button>{bootstrap.bots.length > 0 && <button className="bots-primary" onClick={() => setDialog({ kind: 'chat' })}>{t('newChat')}</button>}</div></div>}</div>
      </div>}
      {tab === 'assistants' && <section className="bots-management" id="bots-panel-assistants" role="tabpanel" aria-label={t('assistants')}><header><div><h2>{t('assistants')}</h2><p>{t('assistantPageHint')}</p></div><button className="bots-primary" onClick={() => setDialog({ kind: 'bot' })}>{t('newAssistant')}</button></header>{bootstrap.bots.length === 0 && <div className="bots-management-empty"><WhaleAvatar size={96} /><p>{t('emptyAssistants')}</p></div>}<div className="bots-bot-grid">{bootstrap.bots.map(bot => {
        const binding = bootstrap.bindings.find(binding => binding.active && binding.botId === bot.id)
        const unavailable = !bot.sessionId || !bootstrap.sessions.some(session => session.id === bot.sessionId)
        return <article className="bots-bot-card" key={bot.id}><WhaleAvatar color={AVATAR_PALETTE[bot.avatar]} size={64} /><div className="bots-bot-info"><h3>{bot.name}</h3><small>{unavailable ? t('unavailable') : binding ? t('assistantBound') : t('assistantReady')}</small></div><label className="bots-check" title={bot.enabled ? t('active') : t('disabled')}><input type="checkbox" aria-label={`${bot.name} ${t('active')}`} checked={bot.enabled} onChange={event => act(model.command({ type: 'bot.update', payload: { botId: bot.id, enabled: event.target.checked } }))} />{bot.enabled ? t('active') : t('disabled')}</label><button onClick={() => setDialog({ kind: 'bot', bot })}>{t('edit')}</button><button className="bots-danger" onClick={() => setDialog({ kind: 'delete-bot', bot })}>{t('deleteAssistant')}</button></article>
      })}</div><footer className="bots-actions"><button onClick={() => act(model.command({ type: 'scheduler.update', payload: { paused: !bootstrap.schedulerPaused } }))}>{bootstrap.schedulerPaused ? t('resume') : t('pause')}</button></footer></section>}
      {dialog?.kind === 'bot' && <BotForm native={nativeSessionT} bot={dialog.bot} bootstrap={bootstrap} model={model} close={close} t={t} />}
      {dialog?.kind === 'delete-bot' && <DeleteBotForm bot={dialog.bot} model={model} close={close} t={t} />}
      {dialog?.kind === 'chat' && <ChatForm bootstrap={bootstrap} model={model} close={() => { close(); setTab('chats') }} t={t} />}
      {dialog?.kind === 'binding' && room && <ChatForm bootstrap={bootstrap} model={model} close={close} t={t} room={room} />}
      {dialog?.kind === 'details' && room && <RoomDetails room={room} bootstrap={bootstrap} model={model} close={close} addAssistant={() => setDialog({ kind: 'binding' })} invite={invite} openSession={openSession} t={t} />}
      {dialog?.kind === 'invite' && <InviteDialog room={bootstrap.rooms.find(item => item.id === dialog.roomId)} roomId={dialog.roomId} model={model} close={close} t={t} />}
    </>}
  </div>
}
