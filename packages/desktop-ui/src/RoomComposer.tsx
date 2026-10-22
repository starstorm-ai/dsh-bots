import inputCss from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.module.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RoomSnapshot } from '../../protocol/src/index.ts'
import { AVATAR_PALETTE, WhaleAvatar } from './Avatar.tsx'
import { ErrorNotice } from './components.tsx'
import { NativeDraft, type DraftHandle } from './NativeDraft.tsx'
import type { Translate } from './locales.ts'
import { errorText, type BotsClientModel, type ClientState } from './model.ts'
import type { Draft } from './persistence.ts'

/** Find the @ token at the caret, including in the middle of an existing draft. */
export function mentionAt(text: string, caret: number): { start: number; end: number; query: string } | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  return match ? { start: caret - match[1]!.length - 1, end: caret, query: match[1]! } : undefined
}

export function RoomComposer({ room, state, model, t, onSent, invite }: { room: RoomSnapshot; state: ClientState; model: BotsClientModel; t: Translate; onSent(): void; invite(): void }): ReactNode {
  const roomId = room.room.id
  const draft = state.local.drafts[roomId] ?? model.defaultDraft(roomId)
  const [error, setError] = useState<string>()
  const [menu, setMenu] = useState<{ start: number; end: number; query: string } | null>()
  const [selected, setSelected] = useState(0)
  const [sending, setSending] = useState(false)
  const editor = useRef<DraftHandle>(null)
  const sendingRef = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const bindings = room.bindings.filter(b => b.active)
  const canInvoke = (botId: string): boolean => state.bootstrap?.person.hostRole === 'owner' || room.grants.some(g => g.canInvoke && g.personId === state.bootstrap?.person.id && bindings.some(b => b.id === g.bindingId && b.botId === botId))
  const bots = room.bots.filter(bot => bindings.some(b => b.botId === bot.id))
  const filtered = bots.filter(bot => bot.name.toLocaleLowerCase().includes((menu?.query ?? '').toLocaleLowerCase()))
  const choices = filtered.filter(bot => bot.enabled && canInvoke(bot.id) && !draft.mentions.includes(bot.id))
  const invalidMentions = draft.mentions.some(id => !bots.some(bot => bot.id === id && bot.enabled && canInvoke(id)))
  const setDraft = (next: Draft): void => { try { model.setDraft(roomId, next); setError(undefined) } catch (e) { setError(`${t('persistenceError')} ${errorText(e)}`) } }
  const choose = (botId: string): void => {
    const text = menu ? draft.text.slice(0, menu.start) + draft.text.slice(menu.end) : draft.text
    setDraft({ ...draft, text, mentions: [...new Set([...draft.mentions, botId])] }); setMenu(undefined); editor.current?.focus()
  }
  const send = async (): Promise<void> => {
    if (sendingRef.current || !draft.text.trim() || invalidMentions) return
    sendingRef.current = true; setSending(true); setMenu(undefined)
    try { await model.send(roomId, draft); setError(undefined); onSent(); editor.current?.focus() }
    catch (e) { setError(errorText(e)) }
    finally { sendingRef.current = false; setSending(false) }
  }
  useEffect(() => {
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setMenu(undefined) }
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside)
  }, [])
  useEffect(() => { if (draft.replyTo) editor.current?.focus() }, [draft.replyTo])
  const quote = room.messages.find(message => message.id === draft.replyTo)
  return <div className={`${inputCss.root} bots-composer`} ref={root}>
    <ErrorNotice error={error} />
    <div className={`${inputCss.card} bots-composer-card`} data-composer-card onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) {
        // Leave IME confirmation to the browser; the plain-text keymap must not
        // interpret the same Enter as a line break or a task submission.
        if (event.key === 'Enter') event.stopPropagation()
        return
      }
      if (menu !== undefined && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        if (event.key === 'Escape') setMenu(undefined)
        else if (event.key === 'Enter') { const bot = choices[selected % Math.max(choices.length, 1)]; if (bot) choose(bot.id) }
        else setSelected(index => choices.length ? (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length : 0)
      } else if (event.key === 'Enter' && !event.shiftKey && event.target instanceof HTMLElement && event.target.closest('[data-composer-input]')) {
        event.preventDefault(); event.stopPropagation(); void send()
      }
    }}>
      {quote && <div className="bots-reply-preview">{t('replying')} {quote.authorName}: {quote.text.slice(0, 100)}<button aria-label={t('clear')} onClick={() => { const { replyTo: _, ...rest } = draft; setDraft(rest) }}>×</button></div>}
      {!!draft.mentions.length && <div className="bots-mentions">{draft.mentions.map(id => <button className="bots-mention" key={id} aria-label={`${t('remove')} @${bots.find(bot => bot.id === id)?.name ?? t('unavailable')}`} onClick={() => setDraft({ ...draft, mentions: draft.mentions.filter(value => value !== id) })}><WhaleAvatar color={AVATAR_PALETTE[bots.find(bot => bot.id === id)?.avatar ?? 'charcoal']} size={22} />@{bots.find(bot => bot.id === id)?.name ?? t('unavailable')}<span aria-hidden>×</span></button>)}</div>}
      <NativeDraft ref={editor} value={draft.text} placeholder={t('placeholder')} onError={error => setError(error.message)} onChange={(text, caret) => { if (text !== draft.text) { setDraft({ ...draft, text }); setMenu(mentionAt(text, caret)); setSelected(0) } }} />
      <div className={`${inputCss.row} bots-composer-tools`}><button className="bots-mention-trigger" aria-haspopup="listbox" aria-expanded={menu !== undefined} onClick={() => { setMenu(menu === undefined ? null : undefined); setSelected(0); editor.current?.focus() }}>@{t('assistants')}</button>{(state.bootstrap?.person.hostRole === 'owner' || state.bootstrap?.person.id === room.room.ownerPersonId) && <button type="button" className="bots-invite-trigger" aria-label={t('invite')} title={t('invite')} onClick={invite}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM21 13v4h-2M13 21h4v-2M19 21h2v-2" /></svg></button>}<span className="bots-composer-intent">{draft.mentions.length ? t('mentionWillInvoke') : t('noMention')}</span><button className="bots-send" aria-label={t('send')} title={t('sendShortcut')} disabled={!draft.text.trim() || invalidMentions || sending} onClick={() => { void send() }}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><path d="M12 19V5m-6 6 6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button></div>
      {menu !== undefined && <div className="bots-mention-menu" role="listbox" aria-label={t('chooseAssistant')}>
        <small>{t('chooseAssistant')}</small>{filtered.length === 0 && <p>{t('noResults')}</p>}
        {filtered.map(bot => { const disabled = !bot.enabled || !canInvoke(bot.id) || draft.mentions.includes(bot.id); const highlighted = choices[selected % Math.max(choices.length, 1)]?.id === bot.id; return <button type="button" role="option" aria-selected={highlighted} disabled={disabled} className={highlighted ? 'is-selected' : ''} key={bot.id} onMouseDown={event => event.preventDefault()} onClick={() => choose(bot.id)}><WhaleAvatar color={AVATAR_PALETTE[bot.avatar]} size={30} /><span>{bot.name}<small>{!bot.enabled ? t('disabled') : !canInvoke(bot.id) ? t('readOnly') : draft.mentions.includes(bot.id) ? t('selectedAssistant') : t('availableAssistant')}</small></span></button> })}
      </div>}
    </div>
    <small className="bots-composer-help">{invalidMentions ? t('mentionUnavailable') : t('sendShortcut')}</small>
  </div>
}
