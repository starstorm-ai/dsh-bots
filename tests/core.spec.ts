import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BotsService } from '../packages/core/src/service.ts';
import { Store } from '../packages/core/src/store.ts';
import type { ContextObservation, DshAdapter, NormalizedDshFrame, RequestObservation } from '../packages/core/src/adapter.ts';
import type { Binding, Bot, Interaction, Message, Principal, Room, Ticket } from '../packages/protocol/src/index.ts';

class FakeAdapter implements DshAdapter {
  contexts = new Map<string, ContextObservation>();
  requests = new Map<string, RequestObservation>();
  sessions = new Map<string, { id: string; title: string; workspaceId: string }>();
  calls: { kind: string; id: string; content?: string }[] = [];
  observers = 0;
  beforeInspect?: () => Promise<void>;
  throwAfterSubmit = false;
  uncertainContext = false;
  discardContext?: DshAdapter['discardContext'];
  answerAccepted = true;
  answerAuthoritative = true;
  async capabilities() { return { contextInjection: true, runningContextInjection: true, interactions: true }; }
  async listWorkspaces() { return [{ id: 'ws', name: 'Workspace', path: 'D:/workspace' }, { id: 'ws2', name: 'Second' }]; }
  async listPresets() { return [{ id: 'preset', name: 'Default' }]; }
  async listSessions() { return [...this.sessions.values()]; }
  async ensureBindingSession(binding: Binding): Promise<void | { sessionId: string }> { if (!this.sessions.has(binding.sessionId)) throw new Error('Session does not exist'); return { sessionId: binding.sessionId }; }
  async sessionCutoff() { return 0; }
  async injectContext(input: { dshMessageId: string; content: string }) { this.calls.push({ kind: 'inject', id: input.dshMessageId, content: input.content }); this.contexts.set(input.dshMessageId, { kind: this.uncertainContext ? 'unknown' : 'accepted' }); return { accepted: true as const }; }
  async inspectContext(_session: string, dshMessageId: string): Promise<ContextObservation> { return this.contexts.get(dshMessageId) ?? { kind: 'absent' }; }
  async submit(input: { requestId: string; prompt: string }) { this.calls.push({ kind: 'submit', id: input.requestId, content: input.prompt }); this.requests.set(input.requestId, { kind: 'observed', status: 'accepted' }); if (this.throwAfterSubmit) throw new Error('Connection lost after durable receipt'); return { accepted: true as const }; }
  async inspectRequest(_session: string, requestId: string): Promise<RequestObservation> { await this.beforeInspect?.(); return this.requests.get(requestId) ?? { kind: 'absent' }; }
  async *observe(_session: string, _after: number, signal: AbortSignal): AsyncIterable<NormalizedDshFrame> { this.observers++; try { await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); } finally { this.observers--; } }
  async cancelInvocation(input: { requestId: string }) { this.calls.push({ kind: 'cancel', id: input.requestId }); return { cancelled: true }; }
  async answerInteraction() { return { accepted: this.answerAccepted, authoritative: this.answerAuthoritative }; }
}
const active: BotsService[] = [];
const directories: string[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map(service => service.dispose())); vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
async function fixture(options: { file?: boolean; start?: boolean } = {}) {
  const adapter = new FakeAdapter(); const directory = options.file ? mkdtempSync(join(tmpdir(), 'dsh-bots-core-')) : undefined; if (directory) directories.push(directory);
  const databasePath = directory ? join(directory, 'bots.sqlite') : ':memory:';
  const service = new BotsService({ databasePath, adapter }); active.push(service); const owner = service.ownerPrincipal;
  adapter.sessions.set('selected-session', { id: 'selected-session', title: 'Existing DSH Session', workspaceId: 'ws' });
  const bot = await service.command(owner, { type: 'bot.create', payload: { name: 'Whale', avatar: 'charcoal', sessionId: 'selected-session', instructions: 'Help with development' } }) as Bot;
  const room = await service.command(owner, { type: 'room.create', payload: { kind: 'group', title: 'Team', botId: bot.id, acknowledgeSharedContext: true } }) as Room;
  const binding = service.snapshot(owner, room.id).bindings[0]!;
  if (options.start !== false) await service.start();
  return { service, owner, adapter, bot, room, binding, databasePath };
}
async function invite(service: BotsService, owner: Principal, room: Room, name = 'Alice') {
  const ticket = await service.command(owner, { type: 'room.invite.create', payload: { roomId: room.id } }) as Ticket;
  const credentials = service.redeemInvite({ token: ticket.token, displayName: name, deviceName: `${name} phone` });
  return { ticket, credentials, principal: service.authenticate(credentials.accessToken) };
}
async function anotherBot(f: Awaited<ReturnType<typeof fixture>>, sessionId = 'second-session') {
  f.adapter.sessions.set(sessionId, { id: sessionId, title: 'Another existing Session', workspaceId: 'ws' });
  return await f.service.command(f.owner, { type: 'bot.create', payload: { name: 'Second', sessionId } }) as Bot;
}
async function send(service: BotsService, principal: Principal, room: Room, text: string, bot?: Bot, clientMessageId: string = crypto.randomUUID()) {
  return await service.command(principal, { type: 'message.send', payload: { roomId: room.id, clientMessageId, parts: [...(bot ? [{ type: 'mention' as const, botId: bot.id, label: bot.name }] : []), { type: 'text', text }] } }) as { message: Message; invocationIds: string[] };
}

describe('assistant deletion', () => {
  it('deletes an unbound disabled assistant idempotently and releases its Session', async () => {
    const f = await fixture({ start: false }); const bot = await anotherBot(f);
    await f.service.command(f.owner, { type: 'bot.update', payload: { botId: bot.id, enabled: false } });
    for (let attempt = 0; attempt < 2; attempt++) expect(await f.service.command(f.owner, { type: 'bot.delete', payload: { botId: bot.id } })).toEqual({ deleted: true });
    expect((await f.service.bootstrap(f.owner)).bots.map(item => item.id)).toEqual([f.bot.id]);
    const replacement = await f.service.command(f.owner, { type: 'bot.create', payload: { name: 'Replacement', sessionId: bot.sessionId! } }) as Bot;
    expect(replacement.id).not.toBe(bot.id); expect(replacement.sessionId).toBe(bot.sessionId);
    expect(f.adapter.sessions.has(bot.sessionId!)).toBe(true);
    await expect(f.service.command(f.owner, { type: 'bot.update', payload: { botId: bot.id, enabled: true } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: bot.id, acknowledgeSharedContext: true } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('preserves chat history and other assistants while cancelling queued work durably across restart', async () => {
    const f = await fixture({ file: true, start: false });
    const other = await anotherBot(f);
    const otherBinding = await f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: other.id, acknowledgeSharedContext: true } }) as Binding;
    await send(f.service, f.owner, f.room, 'Keep this background');
    const task = await send(f.service, f.owner, f.room, 'Queued task', f.bot);
    f.service.project(f.binding.id, { kind: 'message', sourceSeq: 1, messageId: 'kept-answer', role: 'assistant', text: 'Keep this reply' });
    f.service.project(f.binding.id, { kind: 'stream', messageId: 'temporary', attemptId: 'attempt', streamRevision: 1, index: 1, text: 'Temporary stream' });
    f.service.project(f.binding.id, { kind: 'interaction', sourceSeq: 2, interaction: { id: 'pending-question', kind: 'question', title: 'Which branch?', status: 'pending', revision: 1 } });
    const before = f.service.snapshot(f.owner, f.room.id);
    await f.service.command(f.owner, { type: 'bot.delete', payload: { botId: f.bot.id } });
    const after = f.service.snapshot(f.owner, f.room.id);
    expect(after.messages).toEqual(before.messages);
    expect(after.messages.find(message => message.text === 'Keep this reply')?.authorName).toBe(f.bot.name);
    expect(after.bindings).toEqual([otherBinding]); expect(after.bots).toEqual([other]); expect(after.streams).toEqual([]);
    expect(after.invocations.find(invocation => invocation.id === task.invocationIds[0])?.status).toBe('cancelled');
    expect(after.interactions[0]).toMatchObject({ status: 'expired', revision: 2 });
    const events = f.service.events(f.owner, f.room.id, before.cutoff).events;
    expect(events.map(event => event.type)).toEqual(['invocation.updated', 'interaction.updated', 'binding.removed']);
    expect(events.map(event => event.seq)).toEqual([before.cutoff + 1, before.cutoff + 2, before.cutoff + 3]);
    f.service.project(f.binding.id, { kind: 'message', sourceSeq: 3, messageId: 'late-answer', role: 'assistant', text: 'Do not publish' });
    expect(f.service.snapshot(f.owner, f.room.id).messages).toEqual(before.messages);
    await expect(f.service.command(f.owner, { type: 'invocation.retry', payload: { invocationId: task.invocationIds[0]! } })).rejects.toMatchObject({ code: 'BINDING_STALE' });
    await expect(send(f.service, f.owner, f.room, 'Deleted mention', f.bot)).rejects.toMatchObject({ code: 'BOT_NOT_MEMBER' });
    await f.service.dispose();
    const persisted = new Store(f.databasePath);
    try { expect(persisted.list<{ status: string }>('context', { field: 'bindingId', value: f.binding.id }).every(context => context.status === 'discarded')).toBe(true); }
    finally { persisted.close(); }
    const restored = new BotsService({ databasePath: f.databasePath, adapter: f.adapter }); active.push(restored); await restored.start();
    expect((await restored.bootstrap(restored.ownerPrincipal)).bots.map(bot => bot.id)).toEqual([other.id]);
    expect(restored.snapshot(restored.ownerPrincipal, f.room.id).messages).toEqual(before.messages);
    expect(restored.snapshot(restored.ownerPrincipal, f.room.id).invocations[0]?.status).toBe('cancelled');
    expect(f.adapter.calls.filter(call => call.kind === 'submit')).toEqual([]);
    const replacement = await restored.command(restored.ownerPrincipal, { type: 'bot.create', payload: { name: 'New whale', sessionId: f.bot.sessionId! } }) as Bot;
    expect(await restored.command(restored.ownerPrincipal, { type: 'binding.create', payload: { roomId: f.room.id, botId: replacement.id, acknowledgeSharedContext: true } })).toMatchObject({ sessionId: f.bot.sessionId, active: true });
    expect(f.adapter.sessions.has(f.bot.sessionId!)).toBe(true);
  });

  it('requires Host ownership even for a room member with invocation access', async () => {
    const f = await fixture({ start: false }); const guest = await invite(f.service, f.owner, f.room);
    await expect(f.service.command(guest.principal, { type: 'bot.delete', payload: { botId: f.bot.id } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.service.snapshot(f.owner, f.room.id).bindings).toEqual([f.binding]);
    await f.service.command(f.owner, { type: 'bot.delete', payload: { botId: f.bot.id } });
    expect((await f.service.bootstrap(guest.principal)).bots).toEqual([]);
    expect(f.service.snapshot(guest.principal, f.room.id).bindings).toEqual([]);
  });

  it.each(['dispatching', 'accepted', 'running', 'waiting_user', 'recovery_required'] as const)('rejects deletion without partial changes while a task is %s', async status => {
    const f = await fixture({ start: false }); const task = await send(f.service, f.owner, f.room, 'Active work', f.bot);
    const invocation = f.service.snapshot(f.owner, f.room.id).invocations.find(invocation => invocation.id === task.invocationIds[0])!;
    f.service.project(f.binding.id, { kind: 'status', sourceSeq: 1, requestId: invocation.requestId, status });
    const before = f.service.snapshot(f.owner, f.room.id);
    await expect(f.service.command(f.owner, { type: 'bot.delete', payload: { botId: f.bot.id } })).rejects.toMatchObject({ code: 'BINDING_BUSY' });
    expect(f.service.snapshot(f.owner, f.room.id)).toEqual(before);
    expect((await f.service.bootstrap(f.owner)).bots).toEqual([f.bot]);
    f.service.project(f.binding.id, { kind: 'status', sourceSeq: 2, requestId: invocation.requestId, status: 'completed' });
    await expect(f.service.command(f.owner, { type: 'bot.delete', payload: { botId: f.bot.id } })).resolves.toEqual({ deleted: true });
  });

  it.each([false, true])('does not dispatch or revive queued work if deletion wins an async receipt check (throws=%s)', async throws => {
    const f = await fixture({ start: false }); const task = await send(f.service, f.owner, f.room, 'Queued work', f.bot);
    let release!: () => void; let inspected!: () => void;
    const inspectionStarted = new Promise<void>(resolve => { inspected = resolve; });
    f.adapter.beforeInspect = async () => { inspected(); await new Promise<void>(resolve => { release = resolve; }); if (throws) throw new Error('Disconnected'); };
    const starting = f.service.start(); await inspectionStarted;
    try {
      expect(f.adapter.observers).toBe(1);
      await f.service.command(f.owner, { type: 'bot.delete', payload: { botId: f.bot.id } });
    } finally { release(); f.adapter.beforeInspect = undefined; await starting; }
    expect(f.adapter.observers).toBe(0);
    expect(f.service.snapshot(f.owner, f.room.id).invocations.find(invocation => invocation.id === task.invocationIds[0])?.status).toBe('cancelled');
    expect(f.adapter.calls.filter(call => call.kind === 'submit')).toEqual([]);
  });
});

describe('existing Session assistant selection', () => {
  it('persists a completed native turn on its existing message rows without duplicating tool output', async () => {
    const f = await fixture({ start: false });
    const turn = { id: 'turn-1', number: 1, status: 'running' as const, startedAt: '2026-10-22T01:00:00Z' };
    f.service.project(f.binding.id, { kind: 'message', sourceSeq: 1, messageId: 'tool-c', role: 'tool', text: 'exec', turn });
    f.service.project(f.binding.id, { kind: 'message', sourceSeq: 2, messageId: 'tool-c', role: 'tool', text: 'completed', turn });
    f.service.project(f.binding.id, { kind: 'message', sourceSeq: 3, messageId: 'answer', role: 'assistant', text: 'Done', turn });
    const completed = { ...turn, status: 'completed' as const, endedAt: '2026-10-22T01:00:03Z', finalMessageId: 'answer' };
    f.service.project(f.binding.id, { kind: 'status', sourceSeq: 4, status: 'completed', turn: completed });
    const messages = f.service.snapshot(f.owner, f.room.id).messages;
    expect(messages).toHaveLength(2);
    expect(messages.every(message => message.turn?.status === 'completed')).toBe(true);
    expect(messages[0]?.text).toBe('completed');
    expect(messages[1]?.turn).toEqual(completed);
    f.service.project(f.binding.id, { kind: 'status', sourceSeq: 4, status: 'completed', turn: completed });
    expect(f.service.snapshot(f.owner, f.room.id).messages).toEqual(messages);
  });
  it('binds and runs an existing Session without any workspace authorization', async () => {
    const adapter = new FakeAdapter(); adapter.sessions.set('selected', { id: 'selected', title: 'Local', workspaceId: 'ws' });
    const service = new BotsService({ databasePath: ':memory:', adapter }); active.push(service);
    const owner = service.ownerPrincipal;
    const bot = await service.command(owner, { type: 'bot.create', payload: { name: 'Local whale', sessionId: 'selected' } }) as Bot;
    const room = await service.command(owner, { type: 'room.create', payload: { kind: 'direct', title: 'Local', botId: bot.id } }) as Room;
    await service.start(); await send(service, owner, room, 'Run locally', bot); await service.flush();
    expect(adapter.calls.filter(call => call.kind === 'submit')).toHaveLength(1);
    expect((await service.bootstrap(owner)).workspaces.find(w => w.id === 'ws')).toEqual({ id: 'ws', name: 'Workspace', path: 'D:/workspace' });

  });
  it('imports history in new direct chats but retains group cutoffs unless history sharing is selected', async () => {
    const f = await fixture(); f.adapter.sessionCutoff = async () => 50;
    const second = await anotherBot(f);
    const direct = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'direct', title: 'Direct history', botId: second.id } }) as Room;
    const firstBinding = f.service.snapshot(f.owner, direct.id).bindings[0]!;
    expect(firstBinding.publishFromSessionSeq).toBe(0);
    const historical: NormalizedDshFrame = { kind: 'message', sourceSeq: 5, messageId: 'historical', role: 'assistant', text: 'Prior answer', blocks: [{ type: 'text', text: 'Prior answer' }] };
    f.service.project(firstBinding.id, historical); f.service.project(firstBinding.id, historical);
    expect(f.service.snapshot(f.owner, direct.id).messages).toHaveLength(1);
    expect(f.service.snapshot(f.owner, direct.id).messages[0]).toMatchObject({ sessionId: second.sessionId, sessionMessageId: 'historical' });
    await f.service.command(f.owner, { type: 'binding.remove', payload: { bindingId: firstBinding.id } });
    const noImport = await f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: second.id, acknowledgeSharedContext: true } }) as Binding;
    f.service.project(noImport.id, historical); expect(f.service.snapshot(f.owner, f.room.id).messages).toHaveLength(0);
    await f.service.command(f.owner, { type: 'binding.remove', payload: { bindingId: noImport.id } });
    const shared = await f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: second.id, acknowledgeSharedContext: true, importHistory: true } }) as Binding;
    f.service.project(shared.id, historical);
    f.service.project(shared.id, { kind: 'message', sourceSeq: 6, messageId: 'other-room-context', role: 'user', text: 'Internal context envelope', contextMessageId: 'other-room-context' });
    expect(f.service.snapshot(f.owner, f.room.id).messages.map(message => message.text)).toEqual(['Prior answer']);
  });
  it('derives the workspace from the selected Session and adopts that exact Session without allocating another', async () => {
    const f = await fixture(); const adopt = vi.spyOn(f.adapter, 'ensureBindingSession');
    f.adapter.sessions.set('chosen', { id: 'chosen', title: 'My native Session', workspaceId: 'ws2' });
    const before = [...f.adapter.sessions.entries()];
    const bot = await f.service.command(f.owner, { type: 'bot.create', payload: { name: 'Selected', sessionId: 'chosen' } }) as Bot;
    expect(bot).toMatchObject({ sessionId: 'chosen', defaultWorkspaceId: 'ws2', defaultPresetId: '' });
    expect(adopt).not.toHaveBeenCalled();
    const room = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'direct', title: 'Chosen Session chat', botId: bot.id } }) as Room;
    const binding = f.service.snapshot(f.owner, room.id).bindings[0]!;
    expect(binding).toMatchObject({ sessionId: 'chosen', workspaceId: 'ws2' });
    expect(adopt).toHaveBeenCalledExactlyOnceWith(binding);
    expect([...f.adapter.sessions.entries()]).toEqual(before);
  });
  it('requires an existing Session, preserves explicit revocations and reserves it for a single assistant', async () => {
    const f = await fixture();
    await expect(f.service.command(f.owner, { type: 'bot.create', payload: { name: 'Missing', sessionId: 'absent' } })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    f.adapter.sessions.set('private', { id: 'private', title: 'Private workspace', workspaceId: 'ws2' });
    await expect(f.service.command(f.owner, { type: 'bot.create', payload: { name: 'Private', sessionId: 'private' } })).resolves.toMatchObject({ sessionId: 'private', defaultWorkspaceId: 'ws2' });
    const second = await anotherBot(f);
    await f.service.command(f.owner, { type: 'bot.update', payload: { botId: second.id, enabled: false } });
    await expect(f.service.command(f.owner, { type: 'bot.create', payload: { name: 'Duplicate', sessionId: second.sessionId! } })).rejects.toMatchObject({ code: 'SESSION_ALREADY_ASSIGNED' });
    await expect(f.service.command(f.owner, { type: 'bot.update', payload: { botId: second.id, sessionId: f.bot.sessionId! } })).rejects.toMatchObject({ code: 'SESSION_ALREADY_ASSIGNED' });
  });
  it('requires unbinding before changing the selected Session and never resets into a new Session', async () => {
    const f = await fixture(); f.adapter.sessions.set('replacement', { id: 'replacement', title: 'Replacement', workspaceId: 'ws' });
    await expect(f.service.command(f.owner, { type: 'bot.update', payload: { botId: f.bot.id, sessionId: 'replacement' } })).rejects.toMatchObject({ code: 'BOT_ALREADY_BOUND' });
    await expect(f.service.command(f.owner, { type: 'binding.reset', payload: { bindingId: f.binding.id } })).rejects.toMatchObject({ code: 'EXISTING_SESSION_REQUIRED' });
    expect(f.service.snapshot(f.owner, f.room.id).bindings[0]).toEqual(f.binding);
    await f.service.command(f.owner, { type: 'binding.remove', payload: { bindingId: f.binding.id } });
    const updated = await f.service.command(f.owner, { type: 'bot.update', payload: { botId: f.bot.id, sessionId: 'replacement' } }) as Bot;
    expect(updated.sessionId).toBe('replacement');
    const binding = await f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: f.bot.id, acknowledgeSharedContext: true } }) as Binding;
    expect(binding.sessionId).toBe('replacement');
  });
  it('rejects chat-level Session overrides and missing Sessions without calling the adapter adoption path', async () => {
    const f = await fixture(); const second = await anotherBot(f); const adopt = vi.spyOn(f.adapter, 'ensureBindingSession');
    await expect(f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: second.id, sessionId: f.bot.sessionId, acknowledgeSharedContext: true } })).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    await expect(f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: second.id, workspaceId: 'ws2', acknowledgeSharedContext: true } })).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' });
    f.adapter.sessions.delete(second.sessionId!);
    await expect(f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: second.id, acknowledgeSharedContext: true } })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(adopt).not.toHaveBeenCalled();
  });
  it('migrates one existing binding while preserving ambiguous legacy assistants and their room history', async () => {
    const f = await fixture({ file: true, start: false }); await send(f.service, f.owner, f.room, 'Keep this history');
    const otherRoom = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'group', title: 'Legacy second room' } }) as Room;
    await f.service.dispose();
    const store = new Store(f.databasePath); const legacy = { ...f.bot }; delete legacy.sessionId;
    store.put('bot', legacy.id, legacy);
    store.put('bot', 'legacy-unbound', { ...legacy, id: 'legacy-unbound', name: 'Unconfigured' });
    store.put('bot', 'legacy-multi', { ...legacy, id: 'legacy-multi', name: 'Shared template' });
    store.put('binding', 'legacy-binding-a', { ...f.binding, id: 'legacy-binding-a', botId: 'legacy-multi', sessionId: 'legacy-session-a' });
    store.put('binding', 'legacy-binding-b', { ...f.binding, id: 'legacy-binding-b', roomId: otherRoom.id, botId: 'legacy-multi', sessionId: 'legacy-session-b' });
    store.close();
    const restored = new BotsService({ databasePath: f.databasePath, adapter: f.adapter }); active.push(restored);
    const bootstrap = await restored.bootstrap(restored.ownerPrincipal);
    expect(bootstrap.bots.find(bot => bot.id === f.bot.id)?.sessionId).toBe(f.binding.sessionId);
    expect(bootstrap.bots.find(bot => bot.id === 'legacy-multi')?.sessionId).toBeUndefined();
    expect(bootstrap.bots.find(bot => bot.id === 'legacy-unbound')?.sessionId).toBeUndefined();
    expect(bootstrap.bindings).toHaveLength(3);
    expect(restored.snapshot(restored.ownerPrincipal, f.room.id).messages[0]?.text).toBe('Keep this history');
    await expect(restored.command(restored.ownerPrincipal, { type: 'room.create', payload: { kind: 'direct', title: 'No guess', botId: 'legacy-multi' } })).rejects.toMatchObject({ code: 'EXISTING_SESSION_REQUIRED' });
    f.adapter.sessions.set('legacy-selected', { id: 'legacy-selected', title: 'Chosen explicitly', workspaceId: 'ws' });
    const updated = await restored.command(restored.ownerPrincipal, { type: 'bot.update', payload: { botId: 'legacy-unbound', sessionId: 'legacy-selected' } }) as Bot;
    expect(updated.sessionId).toBe('legacy-selected');
  });
  it('does not let a historical binding reserve a Session owned by another active legacy assistant', async () => {
    const f = await fixture({ file: true, start: false }); await f.service.dispose();
    const store = new Store(f.databasePath); const legacy = { ...f.bot }; delete legacy.sessionId;
    // The old historical template is deliberately inserted before the active one.
    store.put('bot', legacy.id, legacy);
    store.put('binding', f.binding.id, { ...f.binding, active: false });
    store.put('bot', 'active-owner', { ...legacy, id: 'active-owner' });
    store.put('binding', 'active-binding', { ...f.binding, id: 'active-binding', botId: 'active-owner' });
    store.close();
    const restored = new BotsService({ databasePath: f.databasePath, adapter: f.adapter }); active.push(restored);
    const bootstrap = await restored.bootstrap(restored.ownerPrincipal);
    expect(bootstrap.bots.find(bot => bot.id === f.bot.id)?.sessionId).toBeUndefined();
    expect(bootstrap.bots.find(bot => bot.id === 'active-owner')?.sessionId).toBe(f.binding.sessionId);
  });
});

describe('identity, membership and permissions', () => {
  it('upgrades a direct room only when someone joins, preserving its Session and history', async () => {
    const f = await fixture({ start: false }); const bot = await anotherBot(f);
    const room = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'direct', title: 'Direct', botId: bot.id } }) as Room;
    await send(f.service, f.owner, room, 'Keep this history');
    const before = f.service.snapshot(f.owner, room.id);
    const ticket = await f.service.command(f.owner, { type: 'room.invite.create', payload: { roomId: room.id } }) as Ticket;
    expect(f.service.snapshot(f.owner, room.id).room.kind).toBe('direct');
    const guest = f.service.redeemInvite({ token: ticket.token, displayName: 'Guest', deviceName: 'Phone' });
    const after = f.service.snapshot(guest.principal, room.id);
    expect(after.room).toMatchObject({ id: room.id, kind: 'group', title: room.title });
    expect(after.messages).toEqual(before.messages); expect(after.bindings).toEqual(before.bindings);
    await expect(send(f.service, guest.principal, room, 'Task', bot)).resolves.toHaveProperty('invocationIds');
    await f.service.command(f.owner, { type: 'room.member.remove', payload: { roomId: room.id, personId: guest.principal.personId } });
    expect(() => f.service.redeemInvite({ token: ticket.token, displayName: 'Guest', deviceName: 'Phone' })).toThrow(/revoked/);
  });
  it('expires an invitation without disconnecting existing members or changing grants on repeat scans', async () => {
    vi.useFakeTimers();
    const f = await fixture({ start: false }); const member = await invite(f.service, f.owner, f.room);
    await f.service.command(f.owner, { type: 'binding.grant.update', payload: { bindingId: f.binding.id, personId: member.principal.personId, canInvoke: false } });
    const repeated = f.service.redeemInvite({ token: member.ticket.token, displayName: 'Guest', deviceName: 'Phone' }, member.principal);
    expect(repeated.principal).toEqual(member.principal);
    await expect(send(f.service, member.principal, f.room, 'Still denied', f.bot)).rejects.toMatchObject({ code: 'FORBIDDEN_BOT' });
    vi.advanceTimersByTime(600_001);
    expect(() => f.service.redeemInvite({ token: member.ticket.token, displayName: 'Later', deviceName: 'Phone' })).toThrow(/expired/);
    expect(f.service.snapshot(member.principal, f.room.id).room.id).toBe(f.room.id);
    expect(f.service.authenticate(repeated.accessToken).personId).toBe(member.principal.personId);
  });
  it('creates independent invite identities with access to only their room and no workspace enumeration', async () => {
    const f = await fixture(); const second = await anotherBot(f); const privateRoom = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'direct', title: 'Private', botId: second.id } }) as Room;
    const { principal, credentials } = await invite(f.service, f.owner, f.room);
    expect(principal.personId).not.toBe(f.owner.personId); expect(principal.hostRole).toBe('member');
    const bootstrap = await f.service.bootstrap(principal); expect(bootstrap.rooms.map(r => r.id)).toEqual([f.room.id]); expect(bootstrap.workspaces).toEqual([]); expect(bootstrap.sessions).toEqual([]);
    expect(() => f.service.snapshot(principal, privateRoom.id)).toThrow(/member/);
    const result = await send(f.service, principal, f.room, 'Run this', f.bot); expect(result.invocationIds).toHaveLength(1); await f.service.flush();
    expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(1);
    const refreshed = f.service.refresh(credentials.refreshToken); expect(refreshed.accessToken).not.toBe(credentials.accessToken);
    expect(() => f.service.authenticate(credentials.accessToken)).toThrow(); expect(() => f.service.refresh(credentials.refreshToken)).toThrow();
    await f.service.command(f.owner, { type: 'device.revoke', payload: { deviceId: principal.deviceId } }); expect(() => f.service.authenticate(refreshed.accessToken)).toThrow();
  });
  it('allows multiple members and replays only the same device receipt without duplicate identities', async () => {
    const f = await fixture(); const ticket = await f.service.command(f.owner, { type: 'room.invite.create', payload: { roomId: f.room.id } }) as Ticket;
    const input = { token: ticket.token, displayName: 'Alice', deviceName: 'Phone', requestId: 'redeem-1', deviceChallenge: 'long-device-held-secret' };
    const first = f.service.redeemInvite(input); expect(f.service.redeemInvite(input)).toEqual(first);
    expect(() => f.service.redeemInvite({ ...input, deviceChallenge: 'different-device' })).toThrow(/challenge/);
    const second = f.service.redeemInvite({ ...input, requestId: 'redeem-2', displayName: 'Bob' });
    expect(second.principal.personId).not.toBe(first.principal.personId);
    expect(f.service.snapshot(f.owner, f.room.id).members).toHaveLength(3);
    expect(f.service.snapshot(first.principal, f.room.id).grants).toContainEqual({ bindingId: f.binding.id, personId: first.principal.personId, canInvoke: true });
    const again = f.service.redeemInvite({ ...input, requestId: 'redeem-3' }, first.principal);
    expect(again.principal).toEqual(first.principal); expect(f.service.snapshot(f.owner, f.room.id).members).toHaveLength(3);
    expect(f.service.redeemInvite({ ...input, requestId: 'redeem-3' })).toEqual(again);
    expect(() => f.service.redeemInvite(input)).toThrow(/credentials were replaced/);
    const rotated = f.service.refresh(again.refreshToken);
    expect(f.service.authenticate(rotated.accessToken)).toEqual(first.principal);
    expect(() => f.service.redeemInvite({ ...input, requestId: 'redeem-3' })).toThrow(/credentials were replaced/);
    const refresh = await f.service.command(f.owner, { type: 'room.invite.create', payload: { roomId: f.room.id } }) as Ticket;
    expect(() => f.service.redeemInvite(input)).toThrow(/revoked/);
    await f.service.command(f.owner, { type: 'room.invite.revoke', payload: { inviteId: refresh.id } });
    expect(() => f.service.redeemInvite({ ...input, token: refresh.token })).toThrow(/revoked/);
  });
  it('rechecks membership before pending work and denies every resource after removal', async () => {
    const f = await fixture({ start: false }); const member = await invite(f.service, f.owner, f.room);
    await f.service.command(f.owner, { type: 'binding.grant.update', payload: { bindingId: f.binding.id, personId: member.principal.personId, canInvoke: true } });
    await send(f.service, member.principal, f.room, 'background'); const result = await send(f.service, member.principal, f.room, 'task', f.bot);
    await f.service.command(f.owner, { type: 'room.member.remove', payload: { roomId: f.room.id, personId: member.principal.personId } });
    await f.service.start(); expect(f.adapter.calls).toEqual([]);
    expect(f.service.snapshot(f.owner, f.room.id).invocations.find(i => i.id === result.invocationIds[0])?.status).toBe('failed');
    expect(() => f.service.history(member.principal, f.room.id)).toThrow(); expect(() => f.service.events(member.principal, f.room.id, 0)).toThrow();
    await expect(send(f.service, member.principal, f.room, 'No access')).rejects.toMatchObject({ code: 'NOT_ROOM_MEMBER' });
  });
  it('cannot forge owner privileges through a principal role', async () => {
    const f = await fixture(); const { principal } = await invite(f.service, f.owner, f.room);
    await expect(f.service.command({ ...principal, hostRole: 'owner' }, { type: 'bot.create', payload: { name: 'Forged', sessionId: 'selected-session' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('routing and durable context', () => {
  it('reconsiders Host-discarded background only for an explicit task and persists the fresh delivery identity', async () => {
    const f = await fixture({ file: true });
    await send(f.service, f.owner, f.room, 'Restore this after Host shutdown');
    await send(f.service, f.owner, f.room, 'Already consumed'); await f.service.flush();
    const [discarded, consumed] = f.service.snapshot(f.owner, f.room.id).contexts;
    f.adapter.contexts.set(discarded!.dshMessageId, { kind: 'discarded' });
    f.adapter.contexts.set(consumed!.dshMessageId, { kind: 'consumed' });
    await f.service.dispose();
    const restored = new BotsService({ databasePath: f.databasePath, adapter: f.adapter }); active.push(restored); await restored.start();
    expect(f.adapter.calls.filter(c => c.kind === 'inject')).toHaveLength(2);
    expect(restored.snapshot(f.owner, f.room.id).contexts.map(c => c.status)).toEqual(['discarded', 'consumed']);
    const inject = f.adapter.injectContext.bind(f.adapter);
    f.adapter.injectContext = async input => {
      expect(restored.snapshot(f.owner, f.room.id).contexts.find(c => c.id === discarded!.id)?.dshMessageId).toBe(input.dshMessageId);
      expect(input.dshMessageId).not.toBe(discarded!.dshMessageId);
      return inject(input);
    };
    await send(restored, f.owner, f.room, 'Use that background', f.bot); await restored.flush();
    expect(f.adapter.calls.map(c => c.kind)).toEqual(['inject', 'inject', 'inject', 'submit']);
    const fresh = restored.snapshot(f.owner, f.room.id).contexts[0]!;
    expect(fresh.status).toBe('accepted'); expect(fresh.dshMessageId).not.toBe(discarded!.dshMessageId);
    await restored.dispose();
    const again = new BotsService({ databasePath: f.databasePath, adapter: f.adapter }); active.push(again); await again.start();
    expect(again.snapshot(f.owner, f.room.id).contexts[0]!.dshMessageId).toBe(fresh.dshMessageId);
    expect(f.adapter.calls.filter(c => c.kind === 'inject')).toHaveLength(3);
  });
  it('keeps discarded-background recovery inside the recent window and excludes removed members', async () => {
    const f = await fixture();
    for (let n = 0; n < 85; n++) { await send(f.service, f.owner, f.room, `Background ${n}`); await f.service.flush(); }
    for (const [messageId, observation] of f.adapter.contexts) if (observation.kind === 'accepted') f.adapter.contexts.set(messageId, { kind: 'discarded' });
    await f.service.flush();
    const member = await invite(f.service, f.owner, f.room);
    await send(f.service, member.principal, f.room, 'Removed member background'); await f.service.flush();
    const memberContext = f.service.snapshot(f.owner, f.room.id).contexts.at(-1)!;
    f.adapter.contexts.set(memberContext.dshMessageId, { kind: 'discarded' }); await f.service.flush();
    await f.service.command(f.owner, { type: 'room.member.remove', payload: { roomId: f.room.id, personId: member.principal.personId } });
    const before = f.adapter.calls.length;
    await send(f.service, f.owner, f.room, 'Reconsider recent background', f.bot); await f.service.flush();
    const recovered = f.adapter.calls.slice(before).filter(c => c.kind === 'inject');
    expect(recovered).toHaveLength(74);
    expect(recovered.every(c => !c.content?.includes('Removed member background'))).toBe(true);
    expect(recovered.map(c => c.content?.split('\n').at(-1))).toEqual(Array.from({ length: 74 }, (_, n) => `Background ${n + 6}`));
    expect([...f.adapter.contexts.values()].filter(c => c.kind === 'accepted')).toHaveLength(74);
  });
  it('does not reinsert discarded records if the Host can no longer confirm the cancellation', async () => {
    const f = await fixture(); await send(f.service, f.owner, f.room, 'Uncertain background'); await f.service.flush();
    const context = f.service.snapshot(f.owner, f.room.id).contexts[0]!;
    f.adapter.contexts.set(context.dshMessageId, { kind: 'discarded' }); await f.service.flush();
    f.adapter.contexts.set(context.dshMessageId, { kind: 'unknown' });
    await send(f.service, f.owner, f.room, 'Task', f.bot); await f.service.flush();
    const snapshot = f.service.snapshot(f.owner, f.room.id);
    expect(snapshot.contexts[0]?.status).toBe('recovery_required'); expect(snapshot.contexts[0]?.dshMessageId).toBe(context.dshMessageId);
    expect(snapshot.invocations[0]?.status).toBe('recovery_required'); expect(f.adapter.calls.map(c => c.kind)).toEqual(['inject']);
  });
  it('bounds accepted idle background by retaining the latest window without waking the model', async () => {
    const f = await fixture();
    f.adapter.discardContext = async (_session: string, messageId: string) => { if (f.adapter.contexts.get(messageId)?.kind !== 'accepted') return { discarded: false }; f.adapter.contexts.set(messageId, { kind: 'discarded' }); return { discarded: true }; };
    for (let n = 0; n < 105; n++) { await send(f.service, f.owner, f.room, `Background ${n}`); await f.service.flush(); }
    expect([...f.adapter.contexts.values()].filter(c => c.kind === 'accepted')).toHaveLength(80);
    const snapshot = f.service.snapshot(f.owner, f.room.id); expect(snapshot.contexts.some(c => c.status === 'omitted')).toBe(true); expect(snapshot.contexts.at(-1)?.status).toBe('accepted');
    expect(f.adapter.calls.filter(c => c.kind === 'submit')).toEqual([]);
  });
  it('omits incoming background if an adapter cannot evict an already full idle inbox', async () => {
    const f = await fixture();
    for (let n = 0; n < 85; n++) { await send(f.service, f.owner, f.room, `Background ${n}`); await f.service.flush(); }
    expect([...f.adapter.contexts.values()].filter(c => c.kind === 'accepted')).toHaveLength(80); expect(f.service.snapshot(f.owner, f.room.id).contexts.at(-1)?.status).toBe('omitted');
  });
  it('requires a structured mention in a direct room and injects ordinary messages without waking it', async () => {
    const f = await fixture(); const second = await anotherBot(f); const direct = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'direct', title: 'Private', botId: second.id } }) as Room;
    const context = await send(f.service, f.owner, direct, '@Second is plain text'); await f.service.flush(); expect(context.invocationIds).toEqual([]);
    expect(f.adapter.calls.map(c => c.kind)).toEqual(['inject']);
    const result = await send(f.service, f.owner, direct, 'Help', second); await f.service.flush(); expect(result.invocationIds).toHaveLength(1);
    await send(f.service, f.owner, f.room, 'More background while the other session is working'); await f.service.flush();
    expect(f.adapter.calls.map(c => c.kind)).toEqual(['inject', 'submit', 'inject']);
  });
  it('injects ordinary group chat without a prompt and confirms earlier background before @ dispatch', async () => {
    const f = await fixture(); const background = await send(f.service, f.owner, f.room, 'Use the current checkout'); expect(background.invocationIds).toEqual([]); await f.service.flush();
    expect(f.adapter.calls.map(c => c.kind)).toEqual(['inject']); expect(f.adapter.calls[0]?.content).toContain('not a new task');
    const task = await send(f.service, f.owner, f.room, 'Run tests', f.bot); await f.service.flush();
    expect(f.adapter.calls.map(c => c.kind)).toEqual(['inject', 'submit']); expect(task.invocationIds).toHaveLength(1);
    expect(f.service.snapshot(f.owner, f.room.id).contexts).toHaveLength(1);
  });
  it('deduplicates retransmission and rejects changing content behind the same idempotency key', async () => {
    const f = await fixture(); const first = await send(f.service, f.owner, f.room, 'Build', f.bot, 'stable-id');
    const [a, b] = await Promise.all([send(f.service, f.owner, f.room, 'Build', f.bot, 'stable-id'), send(f.service, f.owner, f.room, 'Build', f.bot, 'stable-id')]);
    expect(a.invocationIds).toEqual(first.invocationIds); expect(b.message.id).toBe(first.message.id); await f.service.flush(); expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(1);
    await expect(send(f.service, f.owner, f.room, 'Delete', f.bot, 'stable-id')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('routes multiple mentions exactly once while non-target assistants receive background', async () => {
    const f = await fixture(); const second = await anotherBot(f);
    const secondBinding = await f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: second.id, acknowledgeSharedContext: true } }) as Binding;
    await send(f.service, f.owner, f.room, 'Task only for whale', f.bot); await f.service.flush();
    const snapshot = f.service.snapshot(f.owner, f.room.id); expect(snapshot.invocations).toHaveLength(1); expect(snapshot.contexts.map(c => c.bindingId)).toEqual([secondBinding.id]);
  });
  it('does not dispatch over an uncertain context receipt', async () => {
    const f = await fixture(); f.adapter.uncertainContext = true;
    await send(f.service, f.owner, f.room, 'Important context'); await send(f.service, f.owner, f.room, 'Task', f.bot); await f.service.flush();
    expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(0); expect(f.service.snapshot(f.owner, f.room.id).invocations[0]?.status).toBe('recovery_required');
  });
  it('serializes same-workspace tasks and dispatches the next only after completion', async () => {
    const f = await fixture(); const first = await send(f.service, f.owner, f.room, 'First', f.bot); const second = await send(f.service, f.owner, f.room, 'Second', f.bot); await f.service.flush();
    expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(1);
    const invocation = f.service.snapshot(f.owner, f.room.id).invocations.find(i => i.id === first.invocationIds[0])!;
    f.service.project(f.binding.id, { kind: 'status', sourceSeq: 1, requestId: invocation.requestId, status: 'completed' }); await f.service.flush();
    expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(2); expect(f.service.snapshot(f.owner, f.room.id).invocations.find(i => i.id === second.invocationIds[0])?.status).toBe('accepted');
  });
  it('cancels a queued task while inspection is awaiting without submitting it later', async () => {
    const f = await fixture({ start: false }); const task = await send(f.service, f.owner, f.room, 'Queued', f.bot);
    let resolve!: () => void; let inspected!: () => void; const inspectionStarted = new Promise<void>(r => { inspected = r; });
    f.adapter.beforeInspect = () => { inspected(); return new Promise<void>(r => { resolve = r; }); };
    const starting = f.service.start(); await inspectionStarted;
    await f.service.command(f.owner, { type: 'invocation.cancel', payload: { invocationId: task.invocationIds[0]! } }); resolve(); f.adapter.beforeInspect = undefined; await starting;
    expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(0);
  });
});

describe('reused database queries', () => {
  it('always reads current records without mixing record kinds, filter values or row order', () => {
    const store = new Store(':memory:');
    try {
      store.put('item', 'first', { id: 'first', roomId: 'a', seq: 0 });
      store.put('item', 'second', { id: 'second', roomId: 'b', seq: 1 });
      store.put('other', 'first', { id: 'first', roomId: 'other', seq: 2 });
      expect(store.list('item', { field: 'seq', value: 0 })).toEqual([{ id: 'first', roomId: 'a', seq: 0 }]);
      expect(store.list('item', { field: 'roomId', value: 'b' })).toEqual([{ id: 'second', roomId: 'b', seq: 1 }]);
      const copy = store.get<{ roomId: string }>('item', 'first')!; copy.roomId = 'local edit';
      expect(store.get('item', 'first')).toMatchObject({ roomId: 'a' });
      store.put('item', 'first', { id: 'first', roomId: 'b', seq: 3 });
      expect(store.list<{ id: string }>('item', { field: 'roomId', value: 'b' }).map(item => item.id)).toEqual(['first', 'second']);
      expect(store.get('other', 'first')).toMatchObject({ roomId: 'other' });
      store.remove('item', 'first'); expect(store.get('item', 'first')).toBeUndefined();
      expect(store.list('item', { field: 'roomId', value: "b' OR 1=1 --" })).toEqual([]);
      expect(() => store.list('item', { field: "roomId') OR 1=1 --", value: 'b' })).toThrow('Invalid indexed record field');
    } finally { store.close(); }
  });
  it('keeps record and metadata reads correct across rolled-back and committed transactions', () => {
    const store = new Store(':memory:');
    try {
      store.put('item', 'a', { value: 'before' }); store.setMeta('state', 'before');
      expect(store.get('item', 'a')).toEqual({ value: 'before' }); expect(store.meta('state')).toBe('before');
      expect(() => store.transaction(() => {
        store.put('item', 'a', { value: 'rolled back' }); store.setMeta('state', 'rolled back');
        expect(store.get('item', 'a')).toEqual({ value: 'rolled back' }); expect(store.meta('state')).toBe('rolled back');
        throw new Error('abort');
      })).toThrow('abort');
      expect(store.get('item', 'a')).toEqual({ value: 'before' }); expect(store.meta('state')).toBe('before');
      store.transaction(() => { store.put('item', 'a', { value: 'committed' }); store.setMeta('state', 'committed'); });
      expect(store.get('item', 'a')).toEqual({ value: 'committed' }); expect(store.meta('state')).toBe('committed');
    } finally { store.close(); }
  });
});

describe('projection, recovery and sync', () => {
  it('rejects an adapter that substitutes another Session for the selected identity', async () => {
    const f = await fixture(); const second = await anotherBot(f);
    f.adapter.ensureBindingSession = async () => ({ sessionId: 'unexpected-session' });
    await expect(f.service.command(f.owner, { type: 'room.create', payload: { kind: 'direct', title: 'Wrong identity', botId: second.id } })).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    expect((await f.service.bootstrap(f.owner)).bindings.map(binding => binding.sessionId)).toEqual(['selected-session']);
  });
  it('does not alter an unsupported future database schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-bots-future-')); directories.push(directory); const path = join(directory, 'future.sqlite');
    const db = new DatabaseSync(path); db.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(4); CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES(\'keep\');'); const before = db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(); db.close();
    expect(() => new Store(path)).toThrow(/version 4/); const check = new DatabaseSync(path); expect(check.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()).toEqual(before); expect(check.prepare('SELECT value FROM future_data').get()).toMatchObject({ value: 'keep' }); check.close();
  });
  it('removes retired authorization and pairing data while preserving bound chats during the v3 migration', async () => {
    const f = await fixture({ file: true, start: false }); await send(f.service, f.owner, f.room, 'Keep existing history');
    const before = f.service.snapshot(f.owner, f.room.id); await f.service.dispose();
    const old = new DatabaseSync(f.databasePath);
    old.exec("DELETE FROM migrations WHERE version=3; INSERT INTO records VALUES('workspace','ws','{\"allowed\":false}'); INSERT INTO records VALUES('session-access','old','{}'); INSERT INTO records VALUES('ticket','old','{}'); INSERT INTO records VALUES('credential','old','{}');"); old.close();
    const restored = new BotsService({ databasePath: f.databasePath, adapter: f.adapter }); active.push(restored);
    const after = restored.snapshot(restored.ownerPrincipal, f.room.id);
    expect(after.messages).toEqual(before.messages); expect(after.bindings).toEqual(before.bindings);
    await expect(send(restored, restored.ownerPrincipal, f.room, 'No old grant required', f.bot)).resolves.toHaveProperty('invocationIds');
    const check = new DatabaseSync(f.databasePath, { readOnly: true });
    try { expect(check.prepare("SELECT COUNT(*) AS n FROM records WHERE kind IN ('workspace','session-access','ticket','credential')").get()).toMatchObject({ n: 0 }); }
    finally { check.close(); }
  });
  it('upgrades a version 1 projection index without rewriting chat history or binding cutoffs', async () => {
    const f = await fixture({ file: true, start: false });
    await send(f.service, f.owner, f.room, 'Keep existing human history');
    f.service.project(f.binding.id, { kind: 'message', sourceSeq: 7, messageId: 'kept', role: 'assistant', text: 'Keep existing answer' });
    const before = f.service.snapshot(f.owner, f.room.id).messages;
    await f.service.dispose();
    const old = new DatabaseSync(f.databasePath);
    old.exec("DELETE FROM migrations WHERE version>=2; DROP INDEX projection_source_v3; CREATE UNIQUE INDEX projection_source_v2 ON records(json_extract(data,'$.sessionId'),json_extract(data,'$.sourceKey')) WHERE kind='projection'; UPDATE records SET data=json_remove(data,'$.bindingId') WHERE kind='projection'; UPDATE records SET data=json_set(data,'$.publishFromSessionSeq',50,'$.projectionSeq',60) WHERE kind='binding';");
    old.close();
    const restored = new BotsService({ databasePath: f.databasePath, adapter: f.adapter }); active.push(restored);
    const after = restored.snapshot(restored.ownerPrincipal, f.room.id);
    expect(after.messages).toEqual(before);
    expect(after.bindings[0]).toMatchObject({ publishFromSessionSeq: 50, projectionSeq: 60 });
    restored.project(f.binding.id, { kind: 'message', sourceSeq: 10, messageId: 'hidden', role: 'assistant', text: 'Do not import older messages' });
    expect(restored.snapshot(restored.ownerPrincipal, f.room.id).messages).toEqual(before);
    const check = new DatabaseSync(f.databasePath, { readOnly: true });
    expect(check.prepare('SELECT MAX(version) AS version FROM migrations').get()).toMatchObject({ version: 3 });
    check.close();
  });
  it('does not claim an authoritative actor for an idempotent Gateway delivery acknowledgement', async () => {
    const f = await fixture(); f.adapter.answerAuthoritative = false;
    f.service.project(f.binding.id, { kind: 'interaction', sourceSeq: 0, interaction: { id: 'gateway-approval', kind: 'approval', title: 'Allow?', status: 'pending', revision: 1 } });
    const result = await f.service.command(f.owner, { type: 'interaction.answer', payload: { interactionId: 'gateway-approval', revision: 1, answer: { approved: true } } }) as Interaction;
    expect(result.answeredBy).toBeUndefined(); expect(result.answer).toBeUndefined(); expect(result.status).toBe('pending');
    f.service.project(f.binding.id, { kind: 'interaction', sourceSeq: 0, interaction: { id: 'gateway-approval', kind: 'approval', title: 'Allow?', status: 'answered', revision: 2 } });
    expect(f.service.snapshot(f.owner, f.room.id).interactions[0]?.status).toBe('answered');
  });
  it('reconciles a lost submit reply against the durable request receipt instead of submitting again', async () => {
    const f = await fixture(); f.adapter.throwAfterSubmit = true;
    await send(f.service, f.owner, f.room, 'Do this once', f.bot); await f.service.flush();
    expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(1); expect(f.service.snapshot(f.owner, f.room.id).invocations[0]?.status).toBe('accepted');
  });
  it('marks accepted work interrupted after restart when its Host receipt is definitively absent', async () => {
    const f = await fixture({ file: true }); await send(f.service, f.owner, f.room, 'Work', f.bot); await f.service.flush(); await f.service.dispose();
    f.adapter.requests.clear(); const restored = new BotsService({ databasePath: f.databasePath, adapter: f.adapter }); active.push(restored); await restored.start();
    expect(restored.snapshot(restored.ownerPrincipal, f.room.id).invocations[0]?.status).toBe('interrupted'); expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(1);
  });
  it('clears streams on a same-index end and on durable messages with different IDs', async () => {
    const f = await fixture(); const stream: NormalizedDshFrame = { kind: 'stream', messageId: 'attempt-message', attemptId: 'attempt', streamRevision: 1, index: 3, text: 'Draft' };
    f.service.project(f.binding.id, stream); expect(f.service.snapshot(f.owner, f.room.id).streams).toHaveLength(1);
    f.service.project(f.binding.id, { ...stream, text: '' }); expect(f.service.snapshot(f.owner, f.room.id).streams).toEqual([]);
    f.service.project(f.binding.id, { ...stream, index: 4, text: 'Full draft' });
    f.service.project(f.binding.id, { kind: 'message', sourceSeq: 1, messageId: 'durable-message', role: 'assistant', text: 'Full draft' });
    expect(f.service.snapshot(f.owner, f.room.id).streams).toEqual([]);
  });
  it('reconnects failed observers with backoff from the last durable cursor', async () => {
    vi.useFakeTimers(); const f = await fixture({ start: false }); const cursors: number[] = []; let attempt = 0;
    f.adapter.observe = async function* (_session, afterSeq, signal) {
      cursors.push(afterSeq);
      if (++attempt === 1) { yield { kind: 'message', sourceSeq: 5, messageId: 'reconnect-message', role: 'assistant', text: 'Durable before disconnect' } as NormalizedDshFrame; throw new Error('Transient connection'); }
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    await f.service.start(); await Promise.resolve(); expect(cursors).toEqual([0]);
    await vi.advanceTimersByTimeAsync(5_000); expect(cursors).toEqual([0, 5]);
    expect(f.service.snapshot(f.owner, f.room.id).messages.filter(m => m.text === 'Durable before disconnect')).toHaveLength(1);
  });
  it('projects replies, tools, native messages and interaction revisions without duplicate dispatch', async () => {
    const f = await fixture(); const task = await send(f.service, f.owner, f.room, 'Task', f.bot); await f.service.flush(); const invocation = f.service.snapshot(f.owner, f.room.id).invocations.find(i => i.id === task.invocationIds[0])!;
    const frame: NormalizedDshFrame = { kind: 'message', sourceSeq: 1, messageId: 'response', role: 'assistant', requestId: invocation.requestId, text: 'Finished work' };
    f.service.project(f.binding.id, frame); f.service.project(f.binding.id, frame);
    f.service.project(f.binding.id, { kind: 'status', sourceSeq: 1, requestId: invocation.requestId, status: 'completed' });
    f.service.project(f.binding.id, { kind: 'message', sourceSeq: 2, messageId: 'native', role: 'user', text: 'From desktop' });
    f.service.project(f.binding.id, { kind: 'message', sourceSeq: 3, messageId: 'tool', role: 'tool', toolName: 'shell', text: 'Tests passed' });
    const interaction = { id: 'q1', kind: 'question' as const, title: 'Which branch?', status: 'pending' as const, revision: 1 };
    f.service.project(f.binding.id, { kind: 'interaction', sourceSeq: 3, requestId: invocation.requestId, interaction });
    f.service.project(f.binding.id, { kind: 'interaction', sourceSeq: 3, requestId: invocation.requestId, interaction: { ...interaction, status: 'answered', revision: 2 } });
    const snapshot = f.service.snapshot(f.owner, f.room.id); expect(snapshot.messages.filter(m => m.text === 'Finished work')).toHaveLength(1); expect(snapshot.messages.find(m => m.text === 'From desktop')?.source).toBe('desktop'); expect(snapshot.messages.find(m => m.text === 'Tests passed')?.toolName).toBe('shell'); expect(snapshot.interactions[0]?.status).toBe('answered');
    await f.service.flush(); expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(1);
  });
  it('enforces first-answer wins and owner-only approval', async () => {
    const f = await fixture(); const { principal } = await invite(f.service, f.owner, f.room);
    f.service.project(f.binding.id, { kind: 'interaction', sourceSeq: 0, interaction: { id: 'approval', kind: 'approval', title: 'Allow tool?', status: 'pending', revision: 1 } });
    await expect(f.service.command(principal, { type: 'interaction.answer', payload: { interactionId: 'approval', revision: 1, answer: 'approve' } })).rejects.toThrow();
    const answer = await f.service.command(f.owner, { type: 'interaction.answer', payload: { interactionId: 'approval', revision: 1, answer: 'reject' } }) as Interaction; expect(answer.status).toBe('answered');
    await expect(f.service.command(f.owner, { type: 'interaction.answer', payload: { interactionId: 'approval', revision: 1, answer: 'approve' } })).rejects.toMatchObject({ code: 'INTERACTION_EXPIRED' });
  });
  it('keeps read and synchronization cursors isolated between invited members', async () => {
    const f = await fixture(); const member = await invite(f.service, f.owner, f.room); await send(f.service, f.owner, f.room, 'Hello');
    // Separate members have independent read state; a removed identity cannot
    // allocate owner devices through the retired pairing API.
    const second = (await invite(f.service, f.owner, f.room, 'Bob')).credentials;
    const cutoff = f.service.snapshot(member.principal, f.room.id).cutoff;
    await f.service.command(member.principal, { type: 'read.update', payload: { roomId: f.room.id, seq: cutoff } }); await f.service.command(member.principal, { type: 'sync.ack', payload: { roomId: f.room.id, seq: cutoff } });
    const snapshot = f.service.snapshot(second.principal, f.room.id); expect(snapshot.readSeq).toBe(0); expect(snapshot.syncSeq).toBe(0);
    expect(f.service.snapshot(f.owner, f.room.id).readSeq).toBe(0);
    expect(f.service.events(member.principal, f.room.id, 0, 1).hasMore).toBe(true);
    await expect(f.service.command(member.principal, { type: 'sync.resume', payload: { roomId: f.room.id, afterSeq: 0, storeEpoch: 'wrong' } })).rejects.toMatchObject({ code: 'SNAPSHOT_REQUIRED' });
  });
  it('persists identity/messages/contexts and reconciles submitted tasks after restart', async () => {
    const f = await fixture({ file: true }); const member = await invite(f.service, f.owner, f.room); await send(f.service, f.owner, f.room, 'Background'); await send(f.service, f.owner, f.room, 'Work', f.bot); await f.service.flush();
    const before = f.service.snapshot(f.owner, f.room.id); const submitCount = f.adapter.calls.filter(c => c.kind === 'submit').length; const injectCount = f.adapter.calls.filter(c => c.kind === 'inject').length;
    await f.service.dispose(); expect(f.adapter.observers).toBe(0);
    const restored = new BotsService({ databasePath: f.databasePath, adapter: f.adapter }); active.push(restored); await restored.start();
    expect(restored.hostId).toBe(f.service.hostId); expect(restored.storeEpoch).toBe(f.service.storeEpoch); expect(restored.authenticate(member.credentials.accessToken)).toEqual(member.principal); expect(restored.snapshot(restored.ownerPrincipal, f.room.id).messages).toHaveLength(before.messages.length);
    expect(f.adapter.calls.filter(c => c.kind === 'submit')).toHaveLength(submitCount); expect(f.adapter.calls.filter(c => c.kind === 'inject')).toHaveLength(injectCount);
  });
  it('requires explicit sharing acknowledgement and prevents duplicate active session bindings', async () => {
    const f = await fixture(); const bot2 = await anotherBot(f, 'existing'); f.adapter.sessionCutoff = async () => 50;
    await expect(f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: bot2.id, sessionId: 'existing' } })).rejects.toMatchObject({ code: 'SHARED_CONTEXT_CONFIRMATION_REQUIRED' });
    const binding = await f.service.command(f.owner, { type: 'binding.create', payload: { roomId: f.room.id, botId: bot2.id, sessionId: 'existing', acknowledgeSharedContext: true } }) as Binding; expect(binding.publishFromSessionSeq).toBe(50);
    const other = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'group', title: 'Other' } }) as Room;
    await expect(f.service.command(f.owner, { type: 'binding.create', payload: { roomId: other.id, botId: bot2.id, sessionId: 'existing', acknowledgeSharedContext: true } })).rejects.toMatchObject({ code: 'SESSION_ALREADY_BOUND' });
  });
});
