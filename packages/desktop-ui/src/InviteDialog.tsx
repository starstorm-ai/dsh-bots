import { useEffect, useRef, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'
import type { Room, InviteTicket } from '../../protocol/src/index.ts'
import { ErrorNotice, Modal } from './components.tsx'
import { errorText, type BotsClientModel } from './model.ts'
import type { Translate } from './locales.ts'

/** The URI is consumed by the native iOS client. It is never stored in browser persistence. */
export function InviteDialog({ room, roomId, model, close, t }: { room?: Room; roomId: string; model: BotsClientModel; close(): void; t: Translate }): ReactNode {
  const [ticket, setTicket] = useState<InviteTicket>()
  const [image, setImage] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(true)
  const [copied, setCopied] = useState(false)
  const [time, setTime] = useState(Date.now)
  const alive = useRef(false)
  const pending = useRef<Promise<InviteTicket>>()
  const request = (): Promise<InviteTicket> => {
    if (!pending.current) pending.current = model.command({ type: 'room.invite.create', payload: { roomId } }) as Promise<InviteTicket>
    return pending.current
  }
  const show = async (): Promise<void> => {
    setBusy(true); setCopied(false); setError(undefined); setImage(undefined); setTicket(undefined)
    try {
      const value = await request()
      const qr = await QRCode.toDataURL(value.uri, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
      if (alive.current) { setTicket(value); setImage(qr); setTime(Date.now()) }
    } catch (error) {
      if (alive.current) { setError(error && typeof error === 'object' && 'code' in error && error.code === 'NO_LAN_INTERFACE' ? t('inviteNoNetwork') : errorText(error)); pending.current = undefined }
    } finally { if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true; void show()
    const timer = setInterval(() => setTime(Date.now()), 1000)
    return () => { alive.current = false; clearInterval(timer) }
  }, [])
  const expired = !!ticket && new Date(ticket.expiresAt).getTime() <= time
  const copy = async (): Promise<void> => {
    if (!ticket || expired) return
    try { await navigator.clipboard.writeText(ticket.uri); if (alive.current) setCopied(true) }
    catch (error) { if (alive.current) setError(errorText(error)) }
  }
  const revoke = async (): Promise<void> => {
    if (!ticket || busy) return
    setBusy(true)
    try { await model.command({ type: 'room.invite.revoke', payload: { inviteId: ticket.id } }); if (alive.current) close() }
    catch (error) { if (alive.current) { setError(errorText(error)); setBusy(false) } }
  }
  return <Modal title={t('invite')} close={close}><div className="bots-ticket">
    <h3>{room?.title}</h3><p className="bots-hint">{t('inviteClientHint')}</p>
    <div className="bots-qr-frame" aria-busy={busy}>{image && !expired ? <img src={image} width="320" height="320" alt={t('inviteCode')} /> : <span role="status">{busy ? t('loading') : expired ? t('inviteExpired') : t('unavailable')}</span>}</div>
    <p className="bots-hint">{room?.kind === 'direct' ? t('directInviteHint') : t('inviteAccessHint')}</p>
    {ticket && !expired && <small>{t('expires')} {new Date(ticket.expiresAt).toLocaleTimeString()}</small>}
    <ErrorNotice error={error} />
    <footer><button type="button" disabled={busy || !ticket || expired} onClick={() => { void copy() }}>{copied ? t('copied') : t('copyInvite')}</button><button type="button" disabled={busy} onClick={() => { pending.current = undefined; void show() }}>{t('refreshInvite')}</button>{ticket && <button type="button" disabled={busy} onClick={() => { void revoke() }}>{t('revokeInvite')}</button>}</footer>
  </div></Modal>
}
