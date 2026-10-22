/** Additive DSH browser plugin: one sidebar entry, one global chat panel. */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import remote from 'dsh-bots/remote'
import { BotsApp } from './App.tsx'
import { WhaleAvatar } from './Avatar.tsx'
import { en, NS, zh } from './locales.ts'
import { BotsClientModel, type BotsRemoteAdapter } from './model.ts'
import cssText from './styles.css?inline'
import conversationCss from './conversation.css?inline'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { dshBots: keyof typeof en }
}

export const inject = ['remote', 'slots', 'locale', 'layout', 'uiWorkspace']
export const PANEL_ID = 'dsh-bots' as MainPanelId

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(remote)
  const ui = ctx.inject(['remote.dshBots', 'slots', 'locale', 'layout', 'uiWorkspace'], scope => {
    scope.effect(() => { const tag = document.createElement('style'); tag.dataset.dshBots = 'true'; tag.textContent = cssText + '\n' + conversationCss; document.head.append(tag); return () => { tag.remove() } }, 'dsh-bots: styles')
    scope.effect(() => scope.locale.register(NS, { zh, en }), 'dsh-bots: dictionaries')
    let storage: Storage | undefined
    try { storage = globalThis.localStorage } catch { /* Restricted browser storage is surfaced by outbox operations. */ }
    const adapter: BotsRemoteAdapter = {
      bootstrap: (request, signal) => scope.remote.dshBots.bootstrap(request, signal),
      command: (request, signal) => scope.remote.dshBots.command(request, signal),
      snapshot: (request, signal) => scope.remote.dshBots.snapshot(request, signal),
      history: (request, signal) => scope.remote.dshBots.history(request, signal),
      stream: (request, signal) => scope.remote.dshBots.stream(request, signal),
    }
    const model = new BotsClientModel(adapter, storage, globalThis.location?.origin ?? 'dsh')
    scope.effect(() => () => { model.dispose() }, 'dsh-bots: client model')
    scope.on('connection/reset', () => { void model.reconnect() })
    const locale = { getSnapshot: () => scope.locale.getLocale().active as string, subscribe: (listener: () => void) => scope.locale.subscribe(listener) }
    scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ model, locale, nativeChatT: scope.locale.bind('chat' as string), nativeConversationT: scope.locale.bind('conversation' as string), nativeSessionT: { menu: scope.locale.bind('slash.menu' as string), reference: scope.locale.bind('reference' as string) }, openSession: (id: string) => { scope.uiWorkspace.openSession(id as SessionId) } }) }, BotsApp))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: -5, label: () => 'Bots' }, ({ size }: { size: number }) => createElement(WhaleAvatar, { size })))
  })
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}
