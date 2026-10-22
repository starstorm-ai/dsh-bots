import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LIMITS } from '../../protocol/src/index.ts'
import type { Interaction, Invocation, JsonValue, Message, RoomSnapshot } from '../../protocol/src/index.ts'
import { AVATAR_PALETTE, WhaleAvatar } from './Avatar.tsx'
import { ErrorNotice } from './components.tsx'
import type { TextKey, Translate } from './locales.ts'
import { Markdown } from './markdown.tsx'
import { errorText, type BotsClientModel, type ClientState } from './model.ts'
import { RoomComposer } from './RoomComposer.tsx'
import { NativeAssistantTurn, NativeUserMessage, NativeMarkdown, type NativeTranslate } from './NativeTranscript.tsx'
import { activeStatuses, conversationEntries } from './transcript.ts'
import flowCss from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/ChatView.module.css'
import conversationCss from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.module.css'
import { questionAnswer } from './interactions.ts'

const retryStatuses = new Set(['failed', 'cancelled', 'interrupted', 'recovery_required'])
export function TaskCard({ task, room, model, openSession, t }: { task: Invocation; room: RoomSnapshot; model: BotsClientModel; openSession: (sessionId: string) => void; t: Translate }): ReactNode {
  const binding = room.bindings.find(b => b.id === task.bindingId)
  const [error, setError] = useState<string>()
  const act = (type: 'invocation.cancel' | 'invocation.retry'): void => { void model.command({ type, payload: { invocationId: task.id } }).catch(e => setError(errorText(e))) }
  if (task.status === 'completed') return null
  return <div className={`bots-task bots-task-${task.status}`} data-bots-task-controls>{['queued', 'dispatching', 'accepted', 'waiting_user', 'recovery_required'].includes(task.status) && <span className="bots-tag">{t(task.status as TextKey)}</span>}{task.error && <p className="bots-error">{task.error}</p>}<div className="bots-actions">{binding && <button onClick={() => openSession(binding.sessionId)}>{t('openSession')}</button>}{binding?.active && activeStatuses.has(task.status) && <button onClick={() => act('invocation.cancel')}>{t('stop')}</button>}{binding?.active && retryStatuses.has(task.status) && <button title={t('retryHelp')} onClick={() => { if (window.confirm(t('retryHelp'))) act('invocation.retry') }}>{t('retry')}</button>}</div><ErrorNotice error={error} /></div>
}

function InteractionCard({ interaction, model, t }: { interaction: Interaction; model: BotsClientModel; t: Translate }): ReactNode {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [freeText, setFreeText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (answer: JsonValue): Promise<void> => { setBusy(true); setError(undefined); try { await model.command({ type: 'interaction.answer', payload: { interactionId: interaction.id, revision: interaction.revision, answer } }) } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  const pending = interaction.status === 'pending'
  return <section className="bots-interaction" aria-label={t('approvals')}><strong>{interaction.title}</strong>{interaction.description && <Markdown t={t} text={interaction.description} />}{!pending ? <p>{interaction.status === 'answered' ? t('answered') : t('decisionExpired')}</p> : <fieldset disabled={busy}>
    {interaction.kind === 'approval' ? <div className="bots-actions"><button className="bots-primary" onClick={() => { void submit({ approved: true }) }}>{t('approve')}</button><button onClick={() => { void submit({ approved: false }) }}>{t('deny')}</button></div> : <form onSubmit={e => { e.preventDefault(); void submit(interaction.questions?.length ? questionAnswer(interaction.questions, answers) : { text: freeText }) }}>
      {interaction.questions?.map(question => <fieldset key={question.id} className="bots-question"><legend>{question.question}</legend>{question.options?.map(option => <label key={option} className="bots-check"><input type={question.multiple ? 'checkbox' : 'radio'} name={`${interaction.id}-${question.id}`} checked={answers[question.id]?.includes(option) ?? false} onChange={e => setAnswers({ ...answers, [question.id]: question.multiple ? e.target.checked ? [...(answers[question.id] ?? []), option] : (answers[question.id] ?? []).filter(a => a !== option) : [option] })} />{option}</label>)}<input aria-label={`${question.question}: ${t('other')}`} placeholder={t('other')} value={(answers[question.id] ?? []).filter(a => !question.options?.includes(a)).join('\n')} onChange={e => setAnswers({ ...answers, [question.id]: [...(question.multiple ? (answers[question.id] ?? []).filter(a => question.options?.includes(a)) : []), ...(e.target.value ? [e.target.value] : [])] })} /></fieldset>)}
      {!interaction.questions?.length && <textarea required value={freeText} onChange={e => setFreeText(e.target.value)} aria-label={interaction.title} rows={3} />}
      <button className="bots-primary" type="submit">{t('answer')}</button>
    </form>}
  </fieldset>}<ErrorNotice error={error} /></section>
}

function MessageBubble({ message, group, quoted, onReply, t, nativeT }: { message: Message; group: boolean; quoted?: Message; onReply: () => void; t: Translate; nativeT: NativeTranslate }): ReactNode {
  return <article className="bots-human-message" data-native-dsh data-message-id={message.id}>
    {group && <div className="bots-author-name">{message.authorName}</div>}
    {quoted && <blockquote className="bots-quote"><strong>{quoted.authorName}</strong> {quoted.text.slice(0, 180)}</blockquote>}
    <NativeUserMessage message={message} t={nativeT} />
    <button className="bots-reply-action" onClick={onReply}>{t('reply')}</button>
  </article>
}

export function Chat({ room, state, model, openSession, t, nativeT, searchOpen, invite }: { room: RoomSnapshot; state: ClientState; model: BotsClientModel; openSession: (id: string) => void; t: Translate; nativeT: NativeTranslate; searchOpen: boolean; invite(): void }): ReactNode {
  const [error, setError] = useState<string>()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Message[]>()
  const [searching, setSearching] = useState(false)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [olderExhausted, setOlderExhausted] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const searchGeneration = useRef(0)
  const roomId = room.room.id
  const reply = (message: Message): void => { try { model.setDraft(roomId, { ...(state.local.drafts[roomId] ?? model.defaultDraft(roomId)), replyTo: message.id }) } catch (e) { setError(errorText(e)) } }
  useLayoutEffect(() => {
    const node = scroller.current; const saved = model.readScroll(roomId)
    if (node && saved) { nearBottom.current = saved.bottom; node.scrollTop = saved.bottom ? node.scrollHeight : saved.top }
    return () => { if (node) model.saveScroll(roomId, { top: node.scrollTop, bottom: nearBottom.current }) }
  }, [model, roomId])
  useEffect(() => {
    const node = scroller.current
    if (node && nearBottom.current && !results) node.scrollTop = node.scrollHeight
  }, [room.messages, room.streams, state.local.outbox, results])
  useEffect(() => {
    const mark = (): void => { if (document.visibilityState === 'visible' && nearBottom.current) void model.markRead(roomId, room.room.seq).catch(e => setError(errorText(e))) }
    mark(); document.addEventListener('visibilitychange', mark); return () => document.removeEventListener('visibilitychange', mark)
  }, [model, roomId, room.room.seq])
  const searchHistory = async (): Promise<void> => { const generation = ++searchGeneration.current; setSearching(true); try { const found = await model.history(roomId, { search }); if (generation === searchGeneration.current) { setResults(found); setError(undefined) } } catch (e) { if (generation === searchGeneration.current) setError(errorText(e)) } finally { if (generation === searchGeneration.current) setSearching(false) } }
  const loadOlder = async (): Promise<void> => {
    const node = scroller.current; const previousHeight = node?.scrollHeight ?? 0
    setHistoryBusy(true)
    try { const messages = await model.history(roomId, { beforeSeq: room.messages[0]?.seq }); setOlderExhausted(messages.length < LIMITS.historyPage); requestAnimationFrame(() => { if (node) node.scrollTop = node.scrollHeight - previousHeight }) } catch (e) { setError(errorText(e)) } finally { setHistoryBusy(false) }
  }
  const messages = results ?? room.messages
  const nativeActive = useMemo(() => {
    const activeSessions = new Set(state.bootstrap?.sessions.filter(session => session.active).map(session => session.id))
    return new Set(room.bindings.filter(binding => activeStatuses.has(state.nativeActivities[binding.id]?.status as Invocation['status']) || activeSessions.has(binding.sessionId)).map(binding => binding.id))
  }, [room.bindings, state.nativeActivities, state.bootstrap?.sessions])
  const entries = useMemo(() => conversationEntries(room, nativeActive), [room, nativeActive])
  const messageById = useMemo(() => new Map(room.messages.map(message => [message.id, message])), [room.messages])
  const botByBinding = useMemo(() => {
    const bots = new Map(room.bots.map(bot => [bot.id, bot]))
    return new Map(room.bindings.map(binding => [binding.id, bots.get(binding.botId)]))
  }, [room.bots, room.bindings])
  const bubble = (message: Message): ReactNode => <MessageBubble key={message.id} message={message} group={room.room.kind === 'group'} quoted={message.replyToMessageId ? messageById.get(message.replyToMessageId) : undefined} onReply={() => reply(message)} t={t} nativeT={nativeT} />
  const nativeActivities = room.bindings.filter(binding => binding.active && !room.invocations.some(task => task.bindingId === binding.id && activeStatuses.has(task.status))).flatMap(binding => {
    const activity = state.nativeActivities[binding.id]
    const session = state.bootstrap?.sessions.find(s => s.id === binding.sessionId)
    if (activity ? !activeStatuses.has(activity.status) && !activity.error : !session?.active) return []
    return [{ binding, activity, name: room.bots.find(bot => bot.id === binding.botId)?.name ?? session?.title ?? 'DSH' }]
  })
  return <section className={`${conversationCss.body} bots-chat`} aria-label={room.room.title}>
    {nativeActivities.length > 0 && <div className="bots-native-activities" aria-label={t('nativeActivity')} role="status">{nativeActivities.map(({ binding, activity, name }) => <div key={binding.id}><span><span className="bots-dot bots-dot-active" /> {name} · {t('nativeActivity')} · {t(activity?.status ?? 'running')}</span><button onClick={() => openSession(binding.sessionId)}>{t('openSession')}</button>{activity?.error && <ErrorNotice error={activity.error} />}</div>)}</div>}
    {searchOpen && <form className="bots-history-search" onSubmit={e => { e.preventDefault(); void searchHistory() }}><input aria-label={t('searchMessages')} placeholder={t('searchMessages')} value={search} onChange={e => setSearch(e.target.value)} /><button disabled={!search.trim() || searching}>{searching ? t('loading') : t('searchMessages')}</button>{results && <button type="button" onClick={() => { setResults(undefined); setSearch('') }}>{t('resetSearch')}</button>}</form>}
    <div ref={scroller} className={`${flowCss.scroll} bots-timeline`} role="log" aria-live="off" onScroll={e => { const node = e.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; if (nearBottom.current) void model.markRead(roomId, room.room.seq).catch(() => {}) }}>
      <div className={flowCss.column} data-chat-flow>
      {!results && !olderExhausted && room.messages.length >= LIMITS.historyPage && <button className="bots-load-older" disabled={historyBusy} onClick={() => { void loadOlder() }}>{historyBusy ? t('loadingHistory') : t('showOlder')}</button>}
      {messages.length === 0 && <p className="bots-empty-message">{results ? t('noResults') : t('noMessages')}</p>}
      {results ? messages.map(message => message.authorKind === 'bot' ? <div key={message.id} data-native-dsh><NativeMarkdown text={message.text} t={nativeT} /></div> : bubble(message)) : entries.map(entry => entry.kind === 'message'
        ? bubble(entry.message)
        : <article key={entry.id} className={`bots-message bots-assistant-turn bots-task-${entry.status}`} data-native-dsh>
          {room.room.kind === 'group' && <div className="bots-turn-author"><WhaleAvatar size={20} color={AVATAR_PALETTE[botByBinding.get(entry.bindingId)?.avatar ?? 'charcoal']} /><span>{botByBinding.get(entry.bindingId)?.name ?? entry.messages.find(message => message.authorKind === 'bot')?.authorName ?? t('unavailable')}</span></div>}
          <NativeAssistantTurn group={entry} t={nativeT}>{entry.task && <TaskCard task={entry.task} room={room} model={model} openSession={openSession} t={t} />}</NativeAssistantTurn>
        </article>)}
      {!results && <>
        {room.interactions.map(interaction => <InteractionCard key={`${interaction.id}:${interaction.revision}`} interaction={interaction} model={model} t={t} />)}
        {state.local.outbox.filter(m => m.roomId === roomId).map(message => <article className="bots-outbox" key={message.id}><Markdown t={t} text={message.text} /><span className="bots-tag">{message.error ?? t('queued')}</span><div className="bots-actions">{message.error && <button onClick={() => { void model.retryMessage(message.id).catch(e => setError(errorText(e))) }}>{t('retry')}</button>}<button onClick={() => { try { model.discardMessage(message.id) } catch (e) { setError(errorText(e)) } }}>{t('discard')}</button></div></article>)}</>}
      <ErrorNotice error={error} /></div>
    </div>
    <RoomComposer invite={invite} room={room} state={state} model={model} t={t} onSent={() => { nearBottom.current = true; const node = scroller.current; if (node) node.scrollTop = node.scrollHeight }} />
  </section>
}
