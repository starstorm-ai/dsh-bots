import { useState, type ReactNode } from 'react'
import type { AvatarColor, Bot, RoomSnapshot } from '../../protocol/src/index.ts'
import { AVATAR_PALETTE, WhaleAvatar } from './Avatar.tsx'
import { AsyncForm, Field, Modal } from './components.tsx'
import { NativeSessionPicker, type SessionPickerLocale } from './NativeSessionPicker.tsx'
import type { Translate } from './locales.ts'
import type { BotsClientModel, ClientBootstrap } from './model.ts'

/** Session ownership is enforced again by the Host when the form is saved. */
export function selectableSessions(bootstrap: ClientBootstrap, bot?: Bot): ClientBootstrap['sessions'] {
  const reserved = new Set(bootstrap.bots.filter(other => other.id !== bot?.id).map(other => other.sessionId))
  for (const binding of bootstrap.bindings) if (binding.active && binding.botId !== bot?.id) reserved.add(binding.sessionId)
  return bootstrap.sessions.filter(session => !reserved.has(session.id))
}

/** Each selected Session belongs to one active chat, including direct chats. */
export function selectableBots(bootstrap: ClientBootstrap): Bot[] {
  const activeBindings = bootstrap.bindings.filter(binding => binding.active)
  const boundBots = new Set(activeBindings.map(binding => binding.botId))
  const boundSessions = new Set(activeBindings.map(binding => binding.sessionId))
  return bootstrap.bots.filter(bot => bot.enabled && bot.sessionId && !boundBots.has(bot.id) && !boundSessions.has(bot.sessionId))
}

export function BotForm({ bot, bootstrap, model, close, t, native }: { bot?: Bot; bootstrap: ClientBootstrap; model: BotsClientModel; close: () => void; t: Translate; native: SessionPickerLocale }): ReactNode {
  const [name, setName] = useState(bot?.name ?? '')
  const [avatar, setAvatar] = useState<AvatarColor>(bot?.avatar ?? 'charcoal')
  const bindings = bootstrap.bindings.filter(binding => binding.active && binding.botId === bot?.id)
  const currentSessionId = bot?.sessionId ?? (bindings.length === 1 ? bindings[0]?.sessionId : undefined) ?? ''
  const [sessionId, setSessionId] = useState(currentSessionId)
  const sessions = selectableSessions(bootstrap, bot)
  const currentSession = bootstrap.sessions.find(session => session.id === currentSessionId)
  const sessionLocked = bindings.length > 0
  return <Modal title={bot ? t('edit') : t('newAssistant')} close={close}><AsyncForm close={close} label={t('save')} t={t} submit={async () => {
    if (!name.trim() || (!sessionLocked && !sessionId)) throw new Error(t('assistantSelectionRequired'))
    const values = { name: name.trim(), avatar }
    // Cosmetic edits stay possible if a legacy/current Session is no longer
    // in the live catalog. Only a changed selection asks the Host to rebind.
    await model.command(bot
      ? { type: 'bot.update', payload: { botId: bot.id, ...values, ...(sessionId !== currentSessionId ? { sessionId } : {}) } }
      : { type: 'bot.create', payload: { ...values, sessionId } })
  }}>
    <div className="bots-avatar-editor"><WhaleAvatar size={88} color={AVATAR_PALETTE[avatar]} /><div role="radiogroup" aria-label={t('color')}>{(Object.keys(AVATAR_PALETTE) as AvatarColor[]).map(color => <button type="button" role="radio" aria-checked={color === avatar} aria-label={color} title={color} key={color} className="bots-color" style={{ backgroundColor: AVATAR_PALETTE[color] }} onClick={() => setAvatar(color)}>{color === avatar ? '✓' : ''}</button>)}</div></div>
    <Field label={t('name')}><input required maxLength={80} value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
    <Field label={t('session')}><NativeSessionPicker sessions={currentSession && !sessions.some(session => session.id === currentSession.id) ? [currentSession, ...sessions] : sessions} workspaces={bootstrap.workspaces} value={sessionId} onChange={setSessionId} disabled={sessionLocked} t={t} native={native} /></Field>
    {!sessions.length && !currentSessionId && !sessionLocked && <><p className="bots-hint">{t('noAvailableSessions')}</p><p className="bots-hint">{t('sessionUnavailableHint')}</p></>}
  </AsyncForm></Modal>
}

export function ChatForm({ bootstrap, model, close, t, room }: { bootstrap: ClientBootstrap; model: BotsClientModel; close: () => void; t: Translate; room?: RoomSnapshot }): ReactNode {
  const [kind, setKind] = useState<'direct' | 'group'>('direct')
  const available = selectableBots(bootstrap)
  const [botId, setBotId] = useState(available[0]?.id ?? '')
  const bot = available.find(item => item.id === botId)
  const [title, setTitle] = useState('')
  const [ack, setAck] = useState(false)
  const [importHistory, setImportHistory] = useState(false)
  const shared = room ? room.room.kind === 'group' : kind === 'group'
  return <Modal title={room ? t('addAssistant') : t('newChat')} close={close}><AsyncForm close={close} label={room ? t('addAssistant') : t('create')} t={t} submit={async () => {
    if (((room || kind === 'direct') && !bot) || (botId && !bot)) throw new Error(t('chooseAssistant'))
    if (bot && shared && !ack) throw new Error(t('confirmBind'))
    const bind = { ...(bot ? { botId: bot.id } : {}), ...(bot && shared ? { acknowledgeSharedContext: ack, importHistory } : {}) }
    const result = await model.command(room ? { type: 'binding.create', payload: { ...bind, roomId: room.room.id, botId } } : { type: 'room.create', payload: { ...bind, kind, title: title.trim() || bot?.name || t('group') } })
    if (!room && result && typeof result === 'object' && 'id' in result) await model.selectRoom(String(result.id))
  }}>
    {!room && <><Field label={t('newChat')}><select value={kind} onChange={e => { setKind(e.target.value as 'direct' | 'group'); setAck(false) }}><option value="direct">{t('direct')}</option><option value="group">{t('group')}</option></select></Field><Field label={t('roomName')}><input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} placeholder={bot?.name ?? t('group')} /></Field></>}
    <Field label={t('assistants')}><select value={botId} required={!!room || kind === 'direct'} onChange={e => { setBotId(e.target.value); setAck(false) }}><option value="">{t('choose')}</option>{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    {!available.length && <p className="bots-hint">{t('noAvailableAssistants')}</p>}
    {bot && shared && <label className="bots-check"><input type="checkbox" checked={ack} required onChange={e => setAck(e.target.checked)} />{t('confirmBind')}</label>}
    {bot && shared && <label className="bots-check"><input type="checkbox" checked={importHistory} onChange={e => setImportHistory(e.target.checked)} />{t('importHistory')}</label>}
    {shared && <p className="bots-hint">{t('historyNotice')}</p>}
  </AsyncForm></Modal>
}

export function DeleteBotForm({ bot, model, close, t }: { bot: Bot; model: BotsClientModel; close: () => void; t: Translate }): ReactNode {
  return <Modal title={t('deleteAssistant')} close={close}><AsyncForm close={close} label={t('deleteAssistant')} danger t={t} submit={async () => {
    try { await model.command({ type: 'bot.delete', payload: { botId: bot.id } }) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'BINDING_BUSY') { model.clearError(); throw new Error(t('assistantBusy')) }
      throw error
    }
  }}><p><strong>{bot.name}</strong></p><p className="bots-hint">{t('deleteAssistantHint')}</p></AsyncForm></Modal>
}
