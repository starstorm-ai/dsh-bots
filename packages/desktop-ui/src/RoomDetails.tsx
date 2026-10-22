import { useState, type ReactNode } from 'react'
import type { RoomSnapshot } from '../../protocol/src/index.ts'
import { AVATAR_PALETTE, WhaleAvatar } from './Avatar.tsx'
import { ErrorNotice, Field, Modal } from './components.tsx'
import type { Translate } from './locales.ts'
import { errorText, type BotsClientModel, type ClientBootstrap, type UiCommand } from './model.ts'

export function RoomDetails({ room, bootstrap, model, close, addAssistant, invite, openSession, t }: { room: RoomSnapshot; bootstrap: ClientBootstrap; model: BotsClientModel; close: () => void; addAssistant: () => void; invite: () => void; openSession: (id: string) => void; t: Translate }): ReactNode {
  const [title, setTitle] = useState(room.room.title)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const owner = room.room.ownerPersonId === bootstrap.person.id
  const hostOwner = bootstrap.person.hostRole === 'owner'
  const manage = owner || hostOwner
  const command = async (value: UiCommand): Promise<unknown> => { setBusy(true); setError(undefined); try { return await model.command(value) } catch (e) { setError(errorText(e)); return undefined } finally { setBusy(false) } }
  return <Modal title={t('settings')} close={close}><div className="bots-details"><fieldset disabled={busy}>
    <form onSubmit={e => { e.preventDefault(); void command({ type: 'room.update', payload: { roomId: room.room.id, title } }) }}><Field label={t('roomName')}><input value={title} required maxLength={120} disabled={!manage} onChange={e => setTitle(e.target.value)} /></Field>{manage && <button>{t('save')}</button>}</form>
    <button onClick={() => { void command({ type: 'room.update', payload: { roomId: room.room.id, pinned: !room.room.pinned } }) }}>{room.room.pinned ? t('unpin') : t('pin')}</button>
    <h3>{t('members')}</h3><p className="bots-hint">{t('historyNotice')}</p>
    {room.members.filter(m => m.leftAtRoomSeq === undefined).map(member => <div className="bots-member" key={member.personId}><span><strong>{member.displayName}</strong>{member.role === 'owner' && <span className="bots-tag">{t('owner')}</span>}</span><span className="bots-actions">{manage && member.personId !== room.room.ownerPersonId && <><button onClick={() => { if (window.confirm(t('confirmTransfer'))) void command({ type: 'room.owner.transfer', payload: { roomId: room.room.id, personId: member.personId } }) }}>{t('transfer')}</button><button className="bots-danger" onClick={() => { if (window.confirm(t('confirmRemove'))) void command({ type: 'room.member.remove', payload: { roomId: room.room.id, personId: member.personId } }) }}>{t('remove')}</button></>}</span></div>)}
    {manage && <button className="bots-primary" onClick={invite}>{t('invite')}</button>}
    <h3>{t('assistants')}</h3>
    {room.bindings.filter(b => b.active).map(binding => { const bot = room.bots.find(b => b.id === binding.botId); return <div className="bots-binding" key={binding.id}><div className="bots-inline"><WhaleAvatar color={AVATAR_PALETTE[bot?.avatar ?? 'charcoal']} size={42} /><strong>{bot?.name}</strong></div><small>{bootstrap.workspaces.find(w => w.id === binding.workspaceId)?.name ?? binding.workspaceId}</small><div className="bots-actions"><button onClick={() => openSession(binding.sessionId)}>{t('openSession')}</button>{hostOwner && <><button className="bots-danger" onClick={() => { if (window.confirm(t('confirmAction'))) void command({ type: 'binding.remove', payload: { bindingId: binding.id } }) }}>{t('remove')}</button></>}</div>
      {room.room.kind === 'group' && <fieldset className="bots-grants"><legend>{t('roles')}</legend>{room.members.filter(m => m.leftAtRoomSeq === undefined).map(member => { const implicit = bootstrap.people.find(p => p.id === member.personId)?.hostRole === 'owner'; return <label key={member.personId} className="bots-check"><input type="checkbox" checked={implicit || room.grants.some(g => g.bindingId === binding.id && g.personId === member.personId && g.canInvoke)} disabled={!hostOwner || implicit} onChange={e => { void command({ type: 'binding.grant.update', payload: { bindingId: binding.id, personId: member.personId, canInvoke: e.target.checked } }) }} />{member.displayName}</label> })}</fieldset>}
    </div> })}
    {hostOwner && (room.room.kind === 'group' || !room.bindings.some(b => b.active)) && <button onClick={addAssistant}>{t('addAssistant')}</button>}
    {room.contexts.length > 0 && <details><summary>{t('contextStatus')}</summary>{room.contexts.slice(-20).map(context => <p className="bots-context-status" key={context.id}><span>{room.bots.find(bot => bot.id === room.bindings.find(b => b.id === context.bindingId)?.botId)?.name}: #{context.roomSeq}</span><span>{context.status}</span>{context.error && <span className="bots-error">{context.error}</span>}</p>)}</details>}
    <div className="bots-actions bots-danger-zone">{!owner && room.room.kind === 'group' && <button className="bots-danger" onClick={() => { if (window.confirm(t('confirmLeave'))) void command({ type: 'room.leave', payload: { roomId: room.room.id } }).then(value => { if (value !== undefined) close() }) }}>{t('leave')}</button>}{manage && <button className="bots-danger" onClick={() => { if (window.confirm(t('confirmDelete'))) void command({ type: 'room.delete', payload: { roomId: room.room.id } }).then(() => { if (!model.getSnapshot().bootstrap?.rooms.some(r => r.id === room.room.id)) close() }) }}>{t('deleteChat')}</button>}</div><ErrorNotice error={error} />
  </fieldset></div></Modal>
}

