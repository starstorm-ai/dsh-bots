import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { rankByName, relativeTime, ReferenceIconRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { MenuView } from '@deepseek-ai/dsh-client-ui-input-trigger/src/client/MenuView.tsx'
import { MENU_CLOSED, menuReduce } from '@deepseek-ai/dsh-client-ui-input-trigger/src/core/menu.ts'
import type { MenuState } from '@deepseek-ai/dsh-client-ui-input-trigger/src/core/contract.ts'
import type { InputTriggerCrumb } from '@deepseek-ai/dsh-client-ui-input-trigger/src/types.ts'
import type { SessionSummary, WorkspaceSummary } from '../../protocol/src/index.ts'
import type { NativeTranslate } from './NativeTranscript.tsx'
import type { Translate } from './locales.ts'

export interface SessionPickerLocale { menu: NativeTranslate; reference: NativeTranslate }

/** Native reference rows, with the binding target as their value (never a draft mutation). */
export function sessionCandidates(sessions: SessionSummary[], workspaces: WorkspaceSummary[], query: string, t: Translate, reference: NativeTranslate) {
  const time = Date.now()
  const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace]))
  const titleIds = new Map<string, Set<string>>()
  for (const session of sessions) {
    const title = session.title.trim()
    let ids = titleIds.get(title)
    if (!ids) { ids = new Set(); titleIds.set(title, ids) }
    ids.add(session.id)
  }
  const rows = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).map(session => {
    const trimmed = session.title.trim()
    const title = trimmed && session.title !== session.id ? trimmed : t('untitledSession')
    const workspace = workspaceById.get(session.workspaceId)
    const location = workspace?.path ?? workspace?.name ?? reference('candidate.noCwd')
    const age = session.updatedAt !== undefined ? relativeTime(session.updatedAt, time) : undefined
    const dated = age ? reference(`time.${age.unit}`, { n: age.n }) : ''
    const duplicate = titleIds.get(trimmed)!.size > 1
    const suffix = duplicate || !trimmed || session.title === session.id ? session.id.replace(/^session-/, '').slice(0, 8) : ''
    return { name: title, description: [location, dated, suffix].filter(Boolean).join(' · '), icon: 'session' as const, value: session.id }
  })
  if (!query.trim()) return rows
  const matches = rankByName(rows.flatMap(row => [row.name, row.description, row.value].map(name => ({ name, row }))), query.trim().replace(/^@/, ''))
  return [...new Set(matches.map(match => match.row))]
}

/** Uses the actual DSH @ menu and reducer, isolated from the live Session draft. */
export function NativeSessionPicker({ sessions, workspaces, value, onChange, disabled, t, native, 'aria-labelledby': labelledBy }: {
  sessions: SessionSummary[]; workspaces: WorkspaceSummary[]; value: string; onChange(id: string): void; disabled?: boolean; t: Translate; native: SessionPickerLocale; 'aria-labelledby'?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const menu = useMemo(() => createSnapshotStore<MenuState>(MENU_CLOSED), [])
  const headers = useMemo(() => createSnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>(new Map()), [])
  const state = useSyncExternalStore(menu.subscribe, menu.getSnapshot, menu.getSnapshot)
  const rows = useMemo(() => sessionCandidates(sessions, workspaces, query, t, native.reference), [sessions, workspaces, query, t, native.reference])
  useEffect(() => {
    const previous = menu.getSnapshot()
    menu.set(open && rows.length ? { ...previous, open: true, generation: previous.generation + 1, groups: [{ source: 'bots-session', showGroupTitle: false, status: 'ready', items: rows }], highlight: { source: 'bots-session', index: 0 } } : MENU_CLOSED)
  }, [menu, open, rows])
  useLayoutEffect(() => { const list = root.current?.querySelector('[role=listbox]'); if (list) list.id = menuId }, [state, menuId])
  const selected = sessions.find(session => session.id === value)
  const label = selected?.title.trim() && selected.title !== selected.id ? selected.title : value ? t('untitledSession') : ''
  const close = (): void => { setOpen(false); setQuery(''); menu.set(MENU_CLOSED) }
  const pick = (_source: string, index: number): void => {
    const id = menu.getSnapshot().groups[0]?.items[index]?.value
    if (id && !disabled) { onChange(id); close() }
  }
  return <div className="bots-session-picker" ref={root} data-native-dsh data-composer-card onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node | null)) close() }}>
    <div className="bots-session-search"><ReferenceIconRegular kind="session" size={16} /><input role="combobox" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : t('session')} aria-autocomplete="list" aria-expanded={open} aria-controls={open && rows.length ? menuId : undefined} aria-activedescendant={state.highlight ? `dsh-slash-option-${state.highlight.source}-${state.highlight.index}` : undefined}
      disabled={disabled} autoComplete="off" value={open ? query : label} placeholder={t('chooseSession')} onFocus={() => { if (!disabled) setOpen(true) }} onClick={() => { if (!disabled) setOpen(true) }}
      onChange={event => { setQuery(event.target.value); setOpen(true); if (value) onChange('') }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.stopPropagation(); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); event.stopPropagation()
          if (!open) setOpen(true)
          else menu.set(menuReduce(menu.getSnapshot(), { type: 'move', dir: event.key === 'ArrowDown' ? 1 : -1 }))
        } else if (event.key === 'Enter' && open) {
          event.preventDefault(); event.stopPropagation(); const highlight = menu.getSnapshot().highlight; if (highlight) pick(highlight.source, highlight.index)
        } else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
        else if (event.key === 'Tab') close()
      }} /><span className="bots-picker-chevron" aria-hidden>⌄</span></div>
    <MenuView menu={menu} headers={headers} onPick={pick} onHover={(source, index) => menu.set(menuReduce(menu.getSnapshot(), { type: 'hover', source, index }))} onCrumb={() => {}} onDismiss={close} t={native.menu} />
    {open && !rows.length && <div className="bots-session-empty" role="status">{t('noResults')}</div>}
  </div>
}
