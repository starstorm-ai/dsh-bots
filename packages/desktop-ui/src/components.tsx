import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react'
import type { Translate } from './locales.ts'
import { errorText } from './model.ts'

export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { element?.close() } }, [])
  return <dialog ref={dialog} className="bots-dialog" aria-labelledby={heading} onCancel={event => { event.preventDefault(); close() }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close() } }}>
    <header><h2 id={heading}>{title}</h2><button type="button" className="bots-icon-button" onClick={close} aria-label="Close">×</button></header>{children}
  </dialog>
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): ReactNode {
  const id = useId()
  const control = isValidElement(children) ? cloneElement(children as ReactElement<Record<string, unknown>>, { 'aria-labelledby': `${id}-label`, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) }) : children
  return <label className="bots-field"><span id={`${id}-label`}>{label}</span>{control}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>
}
export function ErrorNotice({ error }: { error?: string }): ReactNode { return error ? <div className="bots-error" role="alert">{error}</div> : null }
export function AsyncForm({ children, submit, label, close, t, danger = false }: { children: ReactNode; submit: () => Promise<void>; label: string; close?: () => void; t: Translate; danger?: boolean }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const onSubmit = async (event: FormEvent): Promise<void> => { event.preventDefault(); if (busy) return; setBusy(true); setError(undefined); try { await submit(); close?.() } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  return <form onSubmit={event => { void onSubmit(event) }}><fieldset disabled={busy}>{children}<ErrorNotice error={error} /><footer>{close && <button type="button" onClick={close}>{t('cancel')}</button>}<button className={danger ? 'bots-danger' : 'bots-primary'} type="submit">{busy ? t('loading') : label}</button></footer></fieldset></form>
}
