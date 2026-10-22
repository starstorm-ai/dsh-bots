import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-user-questions';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions';
import type { Interaction } from '../../protocol/src/index.ts';
import { BotsError } from '../../protocol/src/index.ts';
import { record } from './adapter/projection.ts';

export type BridgeInteraction = Omit<Interaction, 'roomId' | 'bindingId' | 'invocationId' | 'sessionId' | 'generation'>;
interface Pending { sessionId: string; clientId: string; eventId: string; value: BridgeInteraction; lifetime: AbortController }
async function* empty(): AsyncGenerator<never> {}

export function questionAnswer(questions: NonNullable<Interaction['questions']>, answer: unknown): AskUserQuestionAnswer {
  const input = record(answer); const answers = record(input.answers); const custom = record(input.custom);
  return { answers: questions.map(q => {
    const selectedValue = answers[q.id];
    if (selectedValue !== undefined && (!Array.isArray(selectedValue) || selectedValue.some(x => typeof x !== 'string'))) throw new BotsError('INVALID_ANSWER', 'Question answers must be arrays of strings');
    let selected = Array.isArray(selectedValue) ? selectedValue as string[] : [];
    let free = typeof custom[q.id] === 'string' ? String(custom[q.id]).trim() : '';
    if (!q.options?.length) { free = free || selected.join('\n'); selected = []; }
    if (selected.some(s => !q.options?.includes(s)) || new Set(selected).size !== selected.length || (!q.multiple && selected.length + (free ? 1 : 0) > 1)) throw new BotsError('INVALID_ANSWER', 'Invalid question option selection');
    if (!selected.length && !free) throw new BotsError('INVALID_ANSWER', `Answer required for ${q.id}`);
    if (free.length > 16000) throw new BotsError('INVALID_ANSWER', 'Answer is too long');
    return { id: q.id, selected, ...(free ? { custom: free } : {}) };
  }) };
}

/** A client of the existing Gateway arbitration, never a second approval waterfall. */
export class InteractionBridge {
  private readonly control = new AbortController();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<(value: BridgeInteraction) => void>>();
  private job?: Promise<void>;
  private live = false;
  constructor(private readonly ctx: Context) {}
  get available(): boolean { return this.live; }
  start(): void { this.job ??= this.run(); }
  subscribe(sessionId: string, listener: (value: BridgeInteraction) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set(); set.add(listener); this.listeners.set(sessionId, set);
    for (const item of this.pending.values()) if (item.sessionId === sessionId) listener(item.value);
    return () => {
      set.delete(listener); if (set.size) return; this.listeners.delete(sessionId);
      for (const item of this.pending.values()) if (item.sessionId === sessionId) { void this.reply(item, { kind: 'next' }).catch(() => {}); this.finish(item, 'expired'); }
    };
  }
  private publish(item: Pending): void { for (const listener of this.listeners.get(item.sessionId) ?? []) listener(item.value); }
  private finish(item: Pending, status: 'answered' | 'expired'): void {
    if (item.value.status !== 'pending') return;
    item.value = { ...item.value, status, revision: item.value.revision + 1 }; this.publish(item);
    item.lifetime.abort(); this.pending.delete(item.eventId);
  }
  async dispose(): Promise<void> { this.control.abort(); for (const item of [...this.pending.values()]) this.finish(item, 'expired'); await this.job; this.listeners.clear(); }
  async answer(sessionId: string, interactionId: string, revision: number, answer: unknown): Promise<{ accepted: boolean; authoritative?: boolean; reason?: string }> {
    const item = this.pending.get(interactionId);
    if (!item || item.sessionId !== sessionId || item.value.revision !== revision || item.value.status !== 'pending') return { accepted: false, reason: 'Interaction already settled or expired' };
    let value: unknown;
    if (item.value.kind === 'approval') {
      const approved = record(answer).approved;
      if (typeof approved !== 'boolean') throw new BotsError('INVALID_ANSWER', 'Approval requires an explicit boolean decision');
      value = approved ? 'allowed-once' : 'rejected';
    } else value = questionAnswer(item.value.questions ?? [], answer);
    try {
      await this.reply(item, { kind: 'result', value });
      // The winner is removed before Gateway broadcasts cancellation. A competing
      // winner cancels our delivery, including a race with an idempotent late RPC.
      if (item.value.status !== 'pending') return { accepted: false, reason: 'Another client already settled this interaction' };
      this.finish(item, 'answered'); return { accepted: true, authoritative: false };
    }
    catch (error) { this.finish(item, 'expired'); return { accepted: false, reason: error instanceof Error ? error.message : 'Interaction expired' }; }
  }
  private async reply(item: Pick<Pending, 'clientId' | 'eventId'>, outcome: unknown): Promise<void> {
    const response = await this.ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://localhost/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: this.control.signal,
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId: item.clientId, eventId: item.eventId, outcome } } }),
    }));
    const envelope = record(await response.json()); const result = record(envelope.result);
    if (!response.ok || result.ok !== true) throw new Error(String(record(result.error).message ?? 'DSH rejected the interaction result'));
  }
  private async attachTimedWait(item: Pending, callId: string): Promise<void> {
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(SessionId(item.sessionId)); if ('error' in resolved) return;
      for await (const frame of this.ctx.userQuestions.attachWait(resolved.agent, ToolCallId(callId), item.lifetime.signal)) {
        await delay(frame.remainingMs, undefined, { signal: item.lifetime.signal });
        if (item.value.status === 'pending') {
          await this.reply(item, { kind: 'rejected', error: { name: 'UserQuestionError', code: 'ASK_TIMED_OUT', message: 'Question foreground timeout' } });
          this.finish(item, 'expired');
        }
      }
    } catch { /* Gateway cancellation or Host disposal ends this same wait. */ }
  }
  private async run(): Promise<void> {
    while (!this.control.signal.aborted) {
      try {
        const source = await this.ctx.typertGateway.wireStream.open('$events', { args: {} }, empty(), undefined, this.control.signal);
        let clientId = '';
        for await (const raw of source) {
          const frame = record(raw);
          if (frame.type === 'ready' && typeof frame.clientId === 'string') { clientId = frame.clientId; this.live = true; }
          if (frame.type === 'cancel' && typeof frame.eventId === 'string') { const item = this.pending.get(frame.eventId); if (item) this.finish(item, 'expired'); }
          if (frame.type !== 'waterfall' || typeof frame.eventId !== 'string') continue;
          const sessionId = String(frame.agentId); const eventId = frame.eventId; const request = record(frame.request);
          if (!this.listeners.has(sessionId) || (frame.event !== 'approval/request' && frame.event !== 'user-questions/request')) { await this.reply({ clientId, eventId }, { kind: 'next' }); continue; }
          const approval = frame.event === 'approval/request';
          const questions = Array.isArray(request.questions) ? request.questions.map(rawQuestion => {
            const q = record(rawQuestion);
            return { id: String(q.id), question: String(q.question), options: Array.isArray(q.options) ? q.options.map(o => String(record(o).label)) : undefined, multiple: q.multiSelect === true };
          }) : undefined;
          const item: Pending = { sessionId, clientId, eventId, lifetime: new AbortController(), value: {
            id: eventId, kind: approval ? 'approval' : 'question', title: approval ? `Approve ${String(request.toolName ?? 'tool execution')}` : 'Assistant needs your answer',
            ...(approval ? { description: String(request.reason ?? request.description ?? request.toolName ?? '') } : { questions, description: Array.isArray(request.questions) ? request.questions.map(q => record(q).detail).filter(x => typeof x === 'string').join('\n\n') : '' }), status: 'pending', revision: 1,
          } };
          this.pending.set(eventId, item); this.publish(item);
          const wait = record(request.wait); if (wait.timed === true && typeof wait.callId === 'string') void this.attachTimedWait(item, wait.callId);
        }
      } catch { /* Remote assembly can start after this plugin; retry without blocking Host startup. */ }
      this.live = false; for (const item of [...this.pending.values()]) this.finish(item, 'expired');
      try { await delay(1000, undefined, { signal: this.control.signal }); } catch { break; }
    }
  }
}
