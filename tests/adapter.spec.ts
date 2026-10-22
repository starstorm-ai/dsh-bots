import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Binding } from '../packages/protocol/src/index.ts';
import { HostDshAdapter } from '../packages/dsh-plugin/src/adapter/dsh-adapter.ts';
import { baselineText, inspectDelivery, inspectPrompt, SessionProjection, streamText, type DurableEvent } from '../packages/dsh-plugin/src/adapter/projection.ts';
import { questionAnswer } from '../packages/dsh-plugin/src/interactions.ts';
import { AsyncQueue } from '../packages/dsh-plugin/src/async-queue.ts';

const message = (id: string, source: unknown, text = 'hello') => ({ id, role: 'user', source, content: [{ type: 'text', text }] });
const events = (...input: [string, unknown][]): DurableEvent[] => input.map(([type, data], index) => ({ type, data, seq: index + 1 }));
const append = (m: unknown) => ({ target: 'next-step', start: 0, inserted: [m] });
const claim = { target: 'next-step', start: 0, removedCount: 1, inserted: [] };

describe('native Session picker metadata', () => {
  it('reads string titles from native projections and keeps untitled sessions distinct from IDs', async () => {
    const items = [
      { sessionId: 'named', projections: { values: { title: '修复插件会话名称' } }, updatedAt: 1792590000000, running: true },
      { sessionId: 'untitled', projections: { values: { title: null } }, updatedAt: 1792580000000, running: false },
      { sessionId: 'uncached', updatedAt: 1792570000000, running: false },
      { sessionId: 'child', origin: 'subagent', projections: { values: { title: 'Child' } } },
      { sessionId: 'outside', projections: { values: { title: 'Not in a workspace' } } },
    ];
    const resolveAgent = vi.fn();
    const ctx = { sessionController: { list: async () => ({ items }), resolveAgent }, workspaceRegistry: { list: () => [{ id: 'workspace', sessionIds: ['named', 'untitled', 'uncached', 'child'] }] } } as unknown as Context;
    const sessions = await new HostDshAdapter(ctx).listSessions();
    expect(sessions).toEqual([
      { id: 'named', title: '修复插件会话名称', workspaceId: 'workspace', updatedAt: 1792590000000, active: true },
      { id: 'untitled', title: '', workspaceId: 'workspace', updatedAt: 1792580000000, active: false },
      { id: 'uncached', title: '', workspaceId: 'workspace', updatedAt: 1792570000000, active: false },
    ]);
    expect(resolveAgent).not.toHaveBeenCalled();
  });
});

describe('existing Session adoption', () => {
  function fixture() {
    const binding: Binding = { id: 'binding', botId: 'bot', roomId: 'room', workspaceId: 'workspace', sessionId: 'selected', generation: 1, active: false, publishFromSessionSeq: 0, projectionSeq: 0 };
    const workspace = { id: 'workspace', sessionIds: ['selected'], status: async () => 'ok' };
    const agent = { session: { id: 'selected' }, model: 'existing-model', permissions: 'existing-permissions', preset: 'existing-preset' };
    const create = vi.fn(); const resolveAgent = vi.fn(async () => ({ agent }));
    const ctx = { workspaceRegistry: { get: () => workspace }, sessionController: { create, resolveAgent } } as unknown as Context;
    return { adapter: new HostDshAdapter(ctx), binding, workspace, agent, create, resolveAgent };
  }
  it('resumes the exact selected Session without calling create or replacing native configuration', async () => {
    const f = fixture(); const before = structuredClone(f.agent);
    expect(await f.adapter.ensureBindingSession(f.binding)).toEqual({ sessionId: 'selected' });
    expect(f.resolveAgent).toHaveBeenCalledExactlyOnceWith('selected');
    expect(f.create).not.toHaveBeenCalled(); expect(f.agent).toEqual(before);
  });
  it('propagates a removed Session instead of recreating it from a stale workspace reference', async () => {
    const f = fixture(); const removed = new Error('Session was removed');
    f.resolveAgent.mockRejectedValueOnce(removed);
    await expect(f.adapter.ensureBindingSession(f.binding)).rejects.toBe(removed);
    expect(f.create).not.toHaveBeenCalled();
  });
  it('rechecks identity and workspace membership after asynchronous resume', async () => {
    const f = fixture(); f.resolveAgent.mockImplementationOnce(async () => { f.workspace.sessionIds = []; return { agent: f.agent }; });
    await expect(f.adapter.ensureBindingSession(f.binding)).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' });
    f.workspace.sessionIds = ['selected']; f.agent.session.id = 'another';
    await expect(f.adapter.ensureBindingSession(f.binding)).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    expect(f.create).not.toHaveBeenCalled();
  });
});

describe('DSH durable inbox reconciliation', () => {
  it('distinguishes accepted, model-consumed, discarded and uncertain claims', () => {
    const m = message('context-id', { kind: 'dsh-bots-context' });
    const history = events(['agent/inbox/spliced', append(m)]);
    expect(inspectDelivery(history, 'context-id')).toEqual({ kind: 'accepted' });
    expect(inspectDelivery([...history, ...events(['agent/inbox/spliced', claim])], 'context-id')).toEqual({ kind: 'unknown' });
    expect(inspectDelivery([...history, ...events(['agent/inbox/spliced', { ...claim, outcome: 'canceled' }])], 'context-id')).toEqual({ kind: 'discarded' });
    expect(inspectDelivery([...history, ...events(['agent/inbox/spliced', claim], ['user/message', m])], 'context-id')).toEqual({ kind: 'consumed' });
    expect(inspectDelivery(history, 'other-id')).toEqual({ kind: 'absent' });
  });
  it('does not retry already admitted or cancelled request ids', () => {
    const m = message('prompt-id', { kind: 'user', rpcId: 'request-id' });
    const prefix: [string, unknown][] = [['agent/inbox/spliced', append(m)]];
    expect(inspectPrompt(events(...prefix), 'request-id')).toEqual({ kind: 'observed', status: 'accepted' });
    expect(inspectPrompt(events(...prefix, ['agent/inbox/spliced', { ...claim, outcome: 'canceled' }]), 'request-id')).toEqual({ kind: 'observed', status: 'cancelled' });
    expect(inspectPrompt(events(...prefix, ['turn/start', { turn: 1 }], ['agent/inbox/spliced', claim], ['user/message', m], ['turn/end', { turn: 1, reason: { kind: 'completed' } }]), 'request-id')).toEqual({ kind: 'observed', status: 'completed' });
  });
  it('finishes both the original task and a native steering request in the same turn', () => {
    const history = events(['turn/start', { turn: 1 }], ['user/message', message('m1', { kind: 'user', rpcId: 'bots' })], ['user/message', message('m2', { kind: 'user', rpcId: 'desktop' })], ['turn/end', { turn: 1, reason: { kind: 'aborted' } }]);
    expect(inspectPrompt(history, 'bots')).toEqual({ kind: 'observed', status: 'cancelled' });
    expect(inspectPrompt(history, 'desktop')).toEqual({ kind: 'observed', status: 'cancelled' });
  });
});

describe('native Session to chat projection', () => {
  it('preserves native turn identity, source time and final answer across tools and continuation', () => {
    const p = new SessionProjection();
    p.fold({ type: 'turn/start', seq: 10, time: 1000, data: { turn: 7 } });
    const process = p.fold({ type: 'assistant/message', seq: 11, time: 2000, data: { message: { id: 'progress', content: [{ type: 'text', text: 'Working' }] } } });
    p.fold({ type: 'tool/call', seq: 12, time: 3000, data: { callId: 'c', name: 'exec' } });
    p.fold({ type: 'assistant/message', seq: 13, time: 4000, data: { message: { id: 'answer', content: [{ type: 'text', text: 'Done' }] } } });
    const end = p.fold({ type: 'turn/end', seq: 14, time: 5000, data: { reason: { kind: 'completed' } } });
    expect(process[0]).toMatchObject({ createdAt: new Date(2000).toISOString(), turn: { id: 'turn-10', number: 7, status: 'running' } });
    expect(end[0]).toMatchObject({ turn: { id: 'turn-10', status: 'completed', startedAt: new Date(1000).toISOString(), endedAt: new Date(5000).toISOString(), finalMessageId: 'answer' } });
    expect(process[0]).toMatchObject({ turn: { status: 'running' } }); // prior frames are immutable
    p.fold({ type: 'turn/start', seq: 15, time: 6000, data: { turn: 8 } });
    expect(p.currentTurn).toMatchObject({ id: 'turn-15', status: 'running' });
    expect(p.currentTurn?.finalMessageId).toBeUndefined();
  });
  it('treats injected contexts as consumption receipts and ignores synthetic system input', () => {
    const p = new SessionProjection();
    const context = p.fold({ type: 'user/message', seq: 5, data: message('ctx', { kind: 'dsh-bots-context' }) });
    expect(context).toMatchObject([{ kind: 'message', contextMessageId: 'ctx' }]);
    expect(p.fold({ type: 'user/message', seq: 6, data: message('sys', { kind: 'skill-catalog' }) })).toEqual([]);
  });
  it('projects final assistant text without reasoning or tool secrets', () => {
    const p = new SessionProjection();
    p.fold({ type: 'user/message', seq: 1, data: message('u', { kind: 'user', rpcId: 'r' }) });
    const output = p.fold({ type: 'assistant/message', seq: 2, data: { message: { id: 'a', content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'Result' }, { type: 'tool_call', arguments: 'secret' }] } } });
    expect(output).toEqual([{ kind: 'message', sourceSeq: 2, messageId: 'a', role: 'assistant', text: 'Result', blocks: [{ type: 'text', text: 'Result' }], requestId: 'r' }]);
    p.fold({ type: 'tool/call', seq: 3, data: { callId: 'c', name: 'read_file', arguments: 'private' } });
    expect(p.requestForCall('c')).toBe('r');
    const result = p.fold({ type: 'tool/result', seq: 4, data: { message: { id: 't', toolCallId: 'c', content: [{ type: 'text', text: 'credentials in file' }] } } });
    expect(result).toMatchObject([{ text: 'read_file: completed', toolName: 'read_file' }]);
    expect(JSON.stringify(result)).not.toContain('credentials');
  });
  it('maps failures and native continuation without inventing an invocation id', () => {
    const p = new SessionProjection();
    const frames = events(['turn/start', {}], ['user/message', message('m', { kind: 'user' })], ['turn/end', { reason: { kind: 'error', error: { message: 'Provider unavailable' } } }]).flatMap(e => p.fold(e));
    expect(frames.at(-1)).toMatchObject({ kind: 'status', status: 'failed', error: 'Provider unavailable' });
    expect(frames.at(-1)).not.toHaveProperty('invocationId');
  });
  it('reconstructs only visible text from live deltas and compact reconnect baselines', () => {
    expect(streamText({ type: 'reasoning-delta', text: 'hidden' })).toBe('');
    expect(baselineText([{ type: 'text-chunks', texts: ['Hel', 'lo'] }, { type: 'reasoning-chunks', texts: ['hidden'] }, { type: 'chunk', chunk: { type: 'text-delta', text: '!' } }])).toBe('Hello!');
  });
});

describe('interaction answer validation and backpressure', () => {
  it('converts chat choices and free text to DSH answer batches', () => {
    expect(questionAnswer([{ id: 'choice', question: 'Choose', options: ['A', 'B'] }, { id: 'name', question: 'Name' }], { answers: { choice: ['A'], name: ['Whale'] } })).toEqual({ answers: [{ id: 'choice', selected: ['A'] }, { id: 'name', selected: [], custom: 'Whale' }] });
  });
  it('rejects fabricated options, duplicate selections and missing answers before arbitration', () => {
    const q = [{ id: 'q', question: 'Choose', options: ['A', 'B'] }];
    for (const answers of [{ q: ['C'] }, { q: ['A', 'A'] }, { q: ['A', 'B'] }, {}]) expect(() => questionAnswer(q, { answers })).toThrow();
  });
  it('forces a reconnect on slow consumer overflow instead of dropping durable events', async () => {
    const queue = new AsyncQueue<number>(1); queue.push(1); queue.push(2);
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow(/reconnect/);
    const empty = new AsyncQueue<number>(); const next = empty[Symbol.asyncIterator]().next(); empty.close();
    expect(await next).toEqual({ value: undefined, done: true });
  });
});
