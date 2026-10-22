import { PROTOCOL_VERSION } from '../packages/protocol/src/index.ts'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Binding, Bot, RoomSnapshot } from '../packages/protocol/src/index.ts'
import { BotForm, ChatForm, DeleteBotForm, selectableBots, selectableSessions } from '../packages/desktop-ui/src/forms.tsx'
import { sessionCandidates } from '../packages/desktop-ui/src/NativeSessionPicker.tsx'
import { translate } from '../packages/desktop-ui/src/locales.ts'
import type { BotsClientModel, ClientBootstrap } from '../packages/desktop-ui/src/model.ts'

const form = vi.hoisted(() => ({ submit: undefined as undefined | (() => Promise<void>) }))
vi.mock('@deepseek-ai/dsh-client-ui-input-trigger/src/client/MenuView.tsx', () => ({ MenuView: () => null }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => ({
  ...await import('@deepseek-ai/dsh-client-ui-primitives/src/relative-time.ts'),
  ...await import('@deepseek-ai/dsh-client-ui-primitives/src/rank-by-name.ts'),
  ReferenceIconRegular: () => null,
}))
vi.mock('../packages/desktop-ui/src/components.tsx', async importOriginal => {
  const actual = await importOriginal<typeof import('../packages/desktop-ui/src/components.tsx')>()
  return { ...actual, AsyncForm: ({ submit, children }: { submit: () => Promise<void>; children: ReactNode }) => { form.submit = submit; return <form>{children}</form> } }
})
const t = translate('zh')
const native = { menu: (key: string) => key, reference: (key: string, params?: Record<string, unknown>) => `${key}${params?.n ?? ''}` }
const bot = (id: string, sessionId?: string): Bot => ({ id, name: id, avatar: 'blue', instructions: 'Legacy instructions', instructionsVersion: 1, defaultWorkspaceId: 'ws', defaultPresetId: 'old-preset', enabled: true, ...(sessionId ? { sessionId } : {}) })
const binding = (botId: string, sessionId: string): Binding => ({ id: `binding-${botId}`, roomId: 'another-room', botId, sessionId, workspaceId: 'ws', generation: 1, active: true, publishFromSessionSeq: 0, projectionSeq: 0 })
const bootstrap = (): ClientBootstrap => ({ version: PROTOCOL_VERSION, hostId: 'host', hostName: 'Host', storeEpoch: 'epoch', person: { id: 'owner', displayName: 'Owner', hostRole: 'owner' }, device: { id: 'desktop', personId: 'owner', name: 'Desktop', createdAt: '', lastSeenAt: '' }, rooms: [], bots: [], bindings: [], people: [], devices: [], workspaces: [{ id: 'ws', name: 'Workspace' }, { id: 'private', name: 'Private' }], sessions: [], presets: [{ id: 'old-preset', name: 'Legacy preset' }], capabilities: { contextInjection: true, runningContextInjection: true, interactions: true }, schedulerPaused: false })
const mockModel = () => ({ command: vi.fn(async () => ({ id: 'created-room' })), selectRoom: vi.fn(async () => {}), clearError: vi.fn() })
beforeEach(() => { form.submit = undefined })

describe('Session-backed assistant forms', () => {
  it('confirms assistant deletion without requesting Session or history deletion', async () => {
    const model = mockModel(); const assistant = bot('Retired whale', 'kept-session')
    const html = renderToStaticMarkup(<DeleteBotForm bot={assistant} model={model as unknown as BotsClientModel} close={() => {}} t={t} />)
    expect(html).toContain('Retired whale'); expect(html).toContain('聊天记录和原 DSH Session 会保留')
    await form.submit!()
    expect(model.command).toHaveBeenCalledExactlyOnceWith({ type: 'bot.delete', payload: { botId: assistant.id } })
  })

  it('explains why active work prevents deletion and keeps the error in the confirmation dialog', async () => {
    const model = mockModel()
    model.command.mockRejectedValue(Object.assign(new Error('Binding busy'), { code: 'BINDING_BUSY' }))
    renderToStaticMarkup(<DeleteBotForm bot={bot('Busy whale', 'busy-session')} model={model as unknown as BotsClientModel} close={() => {}} t={t} />)
    await expect(form.submit!()).rejects.toThrow(t('assistantBusy'))
    expect(model.clearError).toHaveBeenCalledOnce()
  })

  it('labels choices with native titles, workspace and activity time, disambiguating duplicate and unnamed conversations', () => {
    const state = bootstrap()
    state.sessions = [
      { id: 'session-11111111-a', title: '修复会话名称', workspaceId: 'ws', updatedAt: 1792590000000 },
      { id: 'session-22222222-b', title: '修复会话名称', workspaceId: 'ws', updatedAt: 1792590000000 },
      { id: 'session-33333333-c', title: '', workspaceId: 'ws', updatedAt: 1792580000000 },
      { id: 'session-44444444-d', title: 'session-44444444-d', workspaceId: 'ws' },
    ]
    const options = sessionCandidates(state.sessions, state.workspaces, '', t, native.reference)
    expect(options[0]).toMatchObject({ name: '修复会话名称', value: 'session-11111111-a', icon: 'session' })
    expect(options[0]?.description).toMatch(/^Workspace · time\..* · 11111111$/)
    expect(options[1]?.description).toContain('22222222')
    expect(options[2]).toMatchObject({ name: '未命名会话' }); expect(options[2]?.description).toContain('33333333')
    expect(options[3]?.description).toBe('Workspace · 44444444')
    expect(sessionCandidates(state.sessions, state.workspaces, '2222', t, native.reference).map(row => row.value)).toEqual(['session-22222222-b'])
  })

  it('offers unreserved Sessions from every workspace and renders a searchable binding control', () => {
    const state = bootstrap(); const edited = bot('edited', 'own')
    state.bots = [edited, { ...bot('disabled-other', 'reserved'), enabled: false }]
    state.bindings = [binding('legacy-other', 'legacy-reserved')]
    state.sessions = ['own', 'free', 'reserved', 'legacy-reserved'].map(id => ({ id, title: id, workspaceId: 'ws' }))
    state.sessions.push({ id: 'private-session', title: 'Private session', workspaceId: 'private' })
    expect(selectableSessions(state, edited).map(session => session.id)).toEqual(['own', 'free', 'private-session'])
    const html = renderToStaticMarkup(<BotForm native={native} bootstrap={state} model={mockModel() as unknown as BotsClientModel} close={() => {}} t={t} />)
    expect(html).not.toContain('<select'); expect(html.match(/role="radio"/g)).toHaveLength(6)
    expect(html).toContain('名称'); expect(html).toContain('会话'); expect(html).toContain('role="combobox"')
    expect(html).not.toContain('<textarea'); expect(html).not.toContain('职责说明'); expect(html).not.toContain('Agent 预设'); expect(html).not.toContain('工作区'); expect(html).not.toContain('打开 DSH')
  })

  it.each([true, false])('keeps cosmetic editing possible for a bound missing Session (configured=%s)', async configured => {
    const state = bootstrap(); const edited = bot('edited', configured ? 'missing-session' : undefined)
    state.bots = [edited]; state.bindings = [binding(edited.id, 'missing-session')]
    const model = mockModel()
    const html = renderToStaticMarkup(<BotForm native={native} bot={edited} bootstrap={state} model={model as unknown as BotsClientModel} close={() => {}} t={t} />)
    expect(html).toMatch(/<input[^>]+role="combobox"[^>]+disabled=""/); expect(html).toContain('value="未命名会话"')
    await form.submit!()
    expect(model.command).toHaveBeenCalledWith({ type: 'bot.update', payload: { botId: edited.id, name: edited.name, avatar: edited.avatar } })
  })

  it('requires an explicit Session to finish configuring an unbound legacy assistant', async () => {
    const state = bootstrap(); const edited = bot('legacy'); const model = mockModel()
    const html = renderToStaticMarkup(<BotForm native={native} bot={edited} bootstrap={state} model={model as unknown as BotsClientModel} close={() => {}} t={t} />)
    expect(html).toContain('暂无可选 Session。')
    await expect(form.submit!()).rejects.toThrow('请填写名称并选择已有 Session。')
    expect(model.command).not.toHaveBeenCalled()
  })

  it('creates a direct chat with its configured assistant, never overriding or allocating a Session', async () => {
    const state = bootstrap(); state.bots = [bot('bound', 'bound-session'), bot('legacy'), { ...bot('disabled', 'disabled-session'), enabled: false }, bot('available', 'selected-session')]; state.bindings = [binding('bound', 'bound-session')]
    expect(selectableBots(state).map(item => item.id)).toEqual(['available'])
    const model = mockModel()
    const html = renderToStaticMarkup(<ChatForm bootstrap={state} model={model as unknown as BotsClientModel} close={() => {}} t={t} />)
    expect(html).not.toContain('工作区'); expect(html).not.toContain('创建新会话'); expect(html).not.toContain('Agent 预设')
    await form.submit!()
    expect(model.command).toHaveBeenCalledWith({ type: 'room.create', payload: { kind: 'direct', title: 'available', botId: 'available' } })
    expect(model.selectRoom).toHaveBeenCalledWith('created-room')
  })

  it('requires shared-context consent before adding a configured assistant to a group', async () => {
    const state = bootstrap(); state.bots = [bot('available', 'selected-session')]; const model = mockModel()
    const room = { room: { id: 'group', kind: 'group' } } as RoomSnapshot
    const html = renderToStaticMarkup(<ChatForm room={room} bootstrap={state} model={model as unknown as BotsClientModel} close={() => {}} t={t} />)
    expect(html).toContain('我同意向此聊天全部成员分享后续输出。'); expect(html).toMatch(/type="checkbox"[^>]*required=""/)
    await expect(form.submit!()).rejects.toThrow('此会话可能已有私有上下文。')
    expect(model.command).not.toHaveBeenCalled()
  })
})
