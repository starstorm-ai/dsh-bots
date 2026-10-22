import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import TypertGateway from '@deepseek-ai/dsh-api-gateway';
import type { TypertRemoteEventDispatch, TypertRemoteEventOutcome } from '@deepseek-ai/dsh-api-gateway';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { InteractionBridge, type BridgeInteraction } from '../packages/dsh-plugin/src/interactions.ts';
import { AsyncQueue } from '../packages/dsh-plugin/src/async-queue.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Real Cordis, Gateway arbitration, Connection RPC parsing and response envelopes.
 * Only the upstream Agent event producer and timed-question hold are fixtures. */
async function fixture(options: { timeoutMs?: number } = {}) {
  const ctx = new Context(); const queue = new AsyncQueue<TypertRemoteEventDispatch>();
  const bridges: InteractionBridge[] = []; let holds = 0; let attachedSession: string | undefined; let attachedCall: string | undefined;
  await ctx.plugin(TypertRegistry);
  await ctx.plugin((connectionCtx: Context) => {
    // Shared in-process fetch bypasses HTTP browser admission. This fixture does
    // not expose a network listener or replace the LAN transport's own auth tests.
    new HostConnectionService(connectionCtx, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
  });
  await ctx.plugin(TypertGateway, {});
  ctx.provide('sessionController', { async resolveAgent(sessionId: string) { attachedSession = sessionId; return { agent: { id: sessionId } }; } } as unknown as Context['sessionController']);
  ctx.provide('userQuestions', {
    async *attachWait(_agent: unknown, callId: string, signal: AbortSignal) {
      holds++; attachedCall = callId;
      try {
        yield { remainingMs: options.timeoutMs ?? 30_000 };
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      } finally { holds--; }
    },
  } as unknown as Context['userQuestions']);
  const unregister = ctx.typertGateway.registerRemoteEvents(signal => {
    signal.addEventListener('abort', () => queue.close(), { once: true }); return queue;
  }, { home: '/fixture/dsh-home' });
  cleanups.push(async () => { await Promise.all(bridges.map(bridge => bridge.dispose())); await unregister(); await ctx.fiber.dispose(); });

  async function client(sessionId = 'session-1') {
    const bridge = new InteractionBridge(ctx); bridges.push(bridge); const cards: BridgeInteraction[] = [];
    const unsubscribe = bridge.subscribe(sessionId, value => cards.push(structuredClone(value))); bridge.start();
    await expect.poll(() => bridge.available).toBe(true);
    return { bridge, cards, unsubscribe };
  }
  function fire(event: string, request: Record<string, unknown> = {}, sessionId = 'session-1') {
    const control = new AbortController(); const subject = { id: sessionId }; let settled = false;
    let resolve!: (outcome: TypertRemoteEventOutcome) => void; let reject!: (error: unknown) => void;
    const done = new Promise<TypertRemoteEventOutcome>((accept, fail) => { resolve = accept; reject = fail; });
    void done.then(() => { settled = true; }, () => { settled = true; });
    queue.push({ event, request: { ...request, agent: subject, signal: control.signal }, context: { value: ctx, subject, agentId: sessionId }, resolve, reject });
    return { done, control, settled: () => settled };
  }
  return { ctx, client, fire, holds: () => holds, attachment: () => ({ sessionId: attachedSession, callId: attachedCall }) };
}
const questions = { questions: [{ id: 'branch', question: 'Which branch?', options: [{ label: 'main', description: 'Default' }, { label: 'feature', description: 'Development' }], multiSelect: false }, { id: 'notes', question: 'Additional detail?' }] };

describe('InteractionBridge with the real DSH Gateway and Connection', () => {
  it('delegates unrelated events and unbound sessions back to the existing Host waterfall', async () => {
    const f = await fixture(); const client = await f.client();
    await expect(f.fire('other/request', { example: 1 }).done).resolves.toEqual({ kind: 'next' });
    await expect(f.fire('approval/request', { toolName: 'shell' }, 'private-other-session').done).resolves.toEqual({ kind: 'next' });
    expect(client.cards).toEqual([]);
  });

  it('submits questions through the real RPC envelope in the exact DSH answer shape', async () => {
    const f = await fixture(); const client = await f.client(); const request = f.fire('user-questions/request', questions);
    await expect.poll(() => client.cards.length).toBe(1); const card = client.cards[0]!;
    expect(card).toMatchObject({ kind: 'question', status: 'pending', revision: 1, questions: [{ id: 'branch', options: ['main', 'feature'], multiple: false }, { id: 'notes' }] });
    const answer = await client.bridge.answer('session-1', card.id, card.revision, { answers: { branch: ['feature'] }, custom: { notes: '  Keep existing tests  ' } });
    expect(answer).toEqual({ accepted: true, authoritative: false });
    await expect(request.done).resolves.toEqual({ kind: 'result', value: { answers: [{ id: 'branch', selected: ['feature'] }, { id: 'notes', selected: [], custom: 'Keep existing tests' }] } });
    expect(client.cards.at(-1)).toMatchObject({ id: card.id, status: 'answered', revision: 2 });
  });

  it.each([[true, 'allowed-once'], [false, 'rejected']] as const)('forwards explicit approval=%s as %s', async (approved, expected) => {
    const f = await fixture(); const client = await f.client(); const request = f.fire('approval/request', { toolName: 'shell', reason: 'Write build output' });
    await expect.poll(() => client.cards.length).toBe(1); const card = client.cards[0]!;
    expect(card.title).toContain('shell'); expect(card.description).toBe('Write build output');
    expect(await client.bridge.answer('session-1', card.id, card.revision, { approved })).toMatchObject({ accepted: true, authoritative: false });
    await expect(request.done).resolves.toEqual({ kind: 'result', value: expected });
  });

  it('lets Gateway settle once and invalidate every other client card', async () => {
    const f = await fixture(); const phone = await f.client(); const desktop = await f.client(); const request = f.fire('approval/request', { toolName: 'shell' });
    await expect.poll(() => phone.cards.length + desktop.cards.length).toBe(2);
    const phoneCard = phone.cards[0]!; const desktopCard = desktop.cards[0]!; expect(phoneCard.id).toBe(desktopCard.id);
    await desktop.bridge.answer('session-1', desktopCard.id, desktopCard.revision, { approved: false });
    await expect(request.done).resolves.toEqual({ kind: 'result', value: 'rejected' });
    await expect.poll(() => phone.cards.at(-1)?.status).toBe('expired');
    expect(await phone.bridge.answer('session-1', phoneCard.id, phoneCard.revision, { approved: true })).toMatchObject({ accepted: false });
    expect(desktop.cards.at(-1)?.status).toBe('answered');
  });

  it('validates answers before forwarding and rejects stale revisions or wrong sessions', async () => {
    const f = await fixture(); const client = await f.client(); const request = f.fire('user-questions/request', questions);
    await expect.poll(() => client.cards.length).toBe(1); const card = client.cards[0]!;
    const invalid = [{ answers: { branch: 'main' } }, { answers: { branch: ['unknown'] } }, { answers: { branch: ['main', 'feature'] } }, { answers: { branch: ['main', 'main'] } }, { answers: { branch: ['main'] }, custom: { notes: '' } }];
    for (const answer of invalid) await expect(client.bridge.answer('session-1', card.id, 1, answer)).rejects.toMatchObject({ code: 'INVALID_ANSWER' });
    expect(await client.bridge.answer('session-1', card.id, 2, {})).toMatchObject({ accepted: false });
    expect(await client.bridge.answer('other-session', card.id, 1, {})).toMatchObject({ accepted: false });
    expect(request.settled()).toBe(false); expect(client.cards.at(-1)?.status).toBe('pending');
    await client.bridge.answer('session-1', card.id, 1, { answers: { branch: ['main'] }, custom: { notes: 'Valid now' } });
    await expect(request.done).resolves.toMatchObject({ kind: 'result' });
  });

  it('rejects string or missing approval decisions without releasing the Host request', async () => {
    const f = await fixture(); const client = await f.client(); const request = f.fire('approval/request', { toolName: 'shell' });
    await expect.poll(() => client.cards.length).toBe(1); const card = client.cards[0]!;
    for (const answer of [true, 'approve', {}, { approved: 'true' }]) await expect(client.bridge.answer('session-1', card.id, 1, answer)).rejects.toMatchObject({ code: 'INVALID_ANSWER' });
    expect(request.settled()).toBe(false);
    request.control.abort(new Error('Task cancelled')); await expect(request.done).rejects.toThrow('Task cancelled');
    await expect.poll(() => client.cards.at(-1)?.status).toBe('expired');
  });

  it('releases the previous bridge on reload and redelivers a still-live Host request', async () => {
    const f = await fixture(); const first = await f.client(); const request = f.fire('approval/request', { toolName: 'shell' });
    await expect.poll(() => first.cards.length).toBe(1); const oldCard = first.cards[0]!;
    await first.bridge.dispose(); expect(first.bridge.available).toBe(false); expect(first.cards.at(-1)?.status).toBe('expired');
    expect(await first.bridge.answer('session-1', oldCard.id, 1, { approved: true })).toMatchObject({ accepted: false });
    const second = await f.client(); await expect.poll(() => second.cards.length).toBe(1);
    expect(second.cards[0]?.id).toBe(oldCard.id);
    await second.bridge.answer('session-1', second.cards[0]!.id, 1, { approved: false });
    await expect(request.done).resolves.toEqual({ kind: 'result', value: 'rejected' });
  });

  it('delegates an outstanding delivery when its last room observer unsubscribes', async () => {
    const f = await fixture(); const client = await f.client(); const request = f.fire('approval/request', { toolName: 'shell' });
    await expect.poll(() => client.cards.length).toBe(1); const card = client.cards[0]!; client.unsubscribe();
    await expect(request.done).resolves.toEqual({ kind: 'next' });
    expect(await client.bridge.answer('session-1', card.id, 1, { approved: true })).toMatchObject({ accepted: false });
  });

  it('cancels and releases a timed-question wait when the Host cancels its request', async () => {
    const f = await fixture(); const client = await f.client(); const request = f.fire('user-questions/request', { ...questions, wait: { timed: true, callId: 'call-1' } });
    await expect.poll(f.holds).toBe(1); expect(f.attachment()).toEqual({ sessionId: 'session-1', callId: 'call-1' });
    request.control.abort(new Error('Native task stopped')); await expect(request.done).rejects.toThrow('Native task stopped');
    await expect.poll(f.holds).toBe(0); await expect.poll(() => client.cards.at(-1)?.status).toBe('expired');
  });

  it('sends the actual ASK_TIMED_OUT error shape through Gateway when a timed hold expires', async () => {
    const f = await fixture({ timeoutMs: 5 }); const client = await f.client(); const request = f.fire('user-questions/request', { ...questions, wait: { timed: true, callId: 'call-timeout' } });
    await expect(request.done).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_TIMED_OUT', message: 'Question foreground timeout' });
    await expect.poll(f.holds).toBe(0); expect(client.cards.at(-1)?.status).toBe('expired');
  });
});
