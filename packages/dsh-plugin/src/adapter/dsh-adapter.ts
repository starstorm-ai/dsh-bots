import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionFollowFrame, SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-user-questions';
import { SessionId } from '@deepseek-ai/dsh-session';
import { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import { MessageId, ToolCallId, freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { BotsError, type Binding, type Interaction } from '../../../protocol/src/index.ts';
import type { DshAdapter, NormalizedDshFrame } from '../../../core/src/adapter.ts';
import { AsyncQueue } from '../async-queue.ts';
import { InteractionBridge, questionAnswer, type BridgeInteraction } from '../interactions.ts';
import { baselineText, inspectDelivery, inspectPrompt, record, requestId, SessionProjection, streamText } from './projection.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-bots-context': { kind: 'dsh-bots-context'; form: 'relay'; deliveryId: string; bindingGeneration: number };
  }
}

/** Delegates to the existing DSH Session controller and its exact live Agent. */
export class HostDshAdapter implements DshAdapter {
  readonly interactions: InteractionBridge;
  private readonly bindings = new Map<string, Binding>();
  private readonly continued = new Map<string, { sessionId: string; callId: string; value: BridgeInteraction }>();
  constructor(private readonly ctx: Context) { this.interactions = new InteractionBridge(ctx); }
  start(): void { this.interactions.start(); }
  async dispose(): Promise<void> { await this.interactions.dispose(); }
  async capabilities() { return { contextInjection: true, runningContextInjection: true, interactions: this.interactions.available, runtimeName: 'DSH existing Session/Agent' }; }
  async listWorkspaces() { return this.ctx.workspaceRegistry.list().map(w => ({ id: w.id, name: w.title, path: w.path })); }
  async listPresets() { return (await this.ctx.agentPresets.list()).filter(p => !p.broken).map(p => ({ id: p.id, name: p.name ?? p.id })); }
  async listSessions() {
    const { items } = await this.ctx.sessionController.list({}, new AbortController().signal);
    const workspaces = this.ctx.workspaceRegistry.list();
    return items.flatMap(s => {
      const workspace = workspaces.find(w => w.sessionIds.includes(s.sessionId));
      if (!workspace || s.origin === 'subagent') return [];
      // The native title projection is a string (or null), not { title }.
      const title = s.projections?.values.title;
      return [{ id: s.sessionId, title: typeof title === 'string' ? title : '', workspaceId: workspace.id, updatedAt: s.updatedAt, active: s.running }];
    });
  }
  async ensureBindingSession(binding: Binding): Promise<{ sessionId: string }> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(binding.workspaceId));
    if (!workspace || await workspace.status() !== 'ok') throw new BotsError('WORKSPACE_UNAVAILABLE', 'Workspace directory is unavailable');
    if (!workspace.sessionIds.includes(SessionId(binding.sessionId))) throw new BotsError('WORKSPACE_MISMATCH', 'Existing session is no longer in the selected workspace');
    // resolveAgent only resumes existing Sessions. create can recreate a deleted
    // identity with default configuration, even when a sessionId was supplied.
    const agent = await this.agent(binding.sessionId);
    if (agent.session.id !== binding.sessionId) throw new BotsError('SESSION_MISMATCH', 'Existing session adoption returned a different identity');
    if (!this.ctx.workspaceRegistry.get(workspace.id)?.sessionIds.includes(agent.session.id)) throw new BotsError('WORKSPACE_MISMATCH', 'Session does not belong to the selected workspace');
    this.bindings.set(binding.sessionId, { ...binding });
    return { sessionId: binding.sessionId };
  }
  private async inspection(sessionId: string) { return this.ctx.sessionController.inspect(SessionId(sessionId)); }
  async sessionCutoff(sessionId: string): Promise<number> { const value = await this.inspection(sessionId); return value.events.at(-1)?.seq ?? 0; }
  private async agent(sessionId: string) {
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId));
    if ('error' in resolved) throw resolved.error;
    return resolved.agent;
  }
  async inspectContext(sessionId: string, messageId: string) { return inspectDelivery((await this.inspection(sessionId)).events, messageId); }
  async discardContext(sessionId: string, messageId: string): Promise<{ discarded: boolean }> {
    const agent = await this.agent(sessionId);
    if (this.ctx.agents.get(agent.id) !== agent) return { discarded: false };
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].find(m => m.id === messageId && m.source.kind === 'dsh-bots-context');
    if (!pending) return { discarded: false };
    const discarded = agent.inbox.remove(pending.id);
    if (!await this.ctx.sessions.flush(agent.session)) throw new BotsError('PERSISTENCE_UNAVAILABLE', 'DSH has no durable Session writer');
    return { discarded };
  }
  async injectContext(input: { sessionId: string; bindingGeneration: number; deliveryId: string; dshMessageId: string; content: string }): Promise<{ accepted: true }> {
    const binding = this.bindings.get(input.sessionId);
    if (binding && binding.generation !== input.bindingGeneration) throw new BotsError('BINDING_STALE', 'Binding generation changed');
    const agent = await this.agent(input.sessionId);
    // No await separates the exact-Agent check and inbox insertion.
    if (this.ctx.agents.get(agent.id) !== agent) throw new BotsError('SESSION_CHANGED', 'Session runtime changed; retry after reconciliation', true);
    const seen = inspectDelivery(agent.session.snapshotEvents(), input.dshMessageId);
    if (seen.kind === 'accepted' || seen.kind === 'consumed') return { accepted: true };
    if (seen.kind !== 'absent') throw new BotsError('RECOVERY_REQUIRED', 'Previous context delivery has an uncertain or discarded outcome');
    agent.inject(freezeMessage<UserMessage>({ id: MessageId(input.dshMessageId), role: 'user', source: { kind: 'dsh-bots-context', form: 'relay', deliveryId: input.deliveryId, bindingGeneration: input.bindingGeneration }, content: [{ type: 'text', text: input.content }] }));
    // Admission is acknowledged only after the durable inbox mutation is flushed.
    if (!await this.ctx.sessions.flush(agent.session)) throw new BotsError('PERSISTENCE_UNAVAILABLE', 'DSH has no durable Session writer');
    return { accepted: true };
  }
  async submit(input: { sessionId: string; requestId: string; prompt: string; mode: 'queue' }): Promise<{ accepted: true }> {
    await this.ctx.sessionController.prompt({ sessionId: SessionId(input.sessionId), requestId: input.requestId as SessionPromptRequest['requestId'], mode: input.mode, content: [{ type: 'text', text: input.prompt }] }, new AbortController().signal);
    return { accepted: true };
  }
  async inspectRequest(sessionId: string, rpcId: string) { return inspectPrompt((await this.inspection(sessionId)).events, rpcId); }
  async cancelInvocation(input: { sessionId: string; requestId: string; invocationId: string; expectedBindingGeneration: number }): Promise<{ cancelled: boolean; reason?: string }> {
    const binding = this.bindings.get(input.sessionId);
    if (binding && binding.generation !== input.expectedBindingGeneration) return { cancelled: false, reason: 'Binding generation changed' };
    const agent = await this.agent(input.sessionId);
    if (this.ctx.agents.get(agent.id) !== agent) return { cancelled: false, reason: 'Session runtime changed' };
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(m => requestId(m) === input.requestId);
    if (pending) {
      const removed = agent.inbox.remove(pending.id); await this.ctx.sessions.flush(agent.session); return { cancelled: removed };
    }
    const projection = new SessionProjection(); for (const event of agent.session.snapshotEvents()) projection.fold(event);
    if (agent.status !== 'running' || !projection.active || projection.currentRequestId !== input.requestId) return { cancelled: false, reason: 'This invocation is no longer the current task' };
    // Check-and-cancel executes synchronously against one exact live Agent; queued native work is retained.
    await agent.cancel({ kind: 'user' }, { keepInbox: true }); await this.ctx.sessions.flush(agent.session);
    return { cancelled: true };
  }
  async answerInteraction(input: { interactionId: string; sessionId: string; revision: number; answer: unknown }) {
    const late = this.continued.get(input.interactionId);
    if (!late) return this.interactions.answer(input.sessionId, input.interactionId, input.revision, input.answer);
    if (late.sessionId !== input.sessionId || late.value.revision !== input.revision || late.value.status !== 'pending') return { accepted: false, reason: 'Question has already settled' };
    const accepted = this.ctx.userQuestions.answer(await this.agent(input.sessionId), ToolCallId(late.callId), questionAnswer(late.value.questions ?? [], input.answer));
    return { accepted, ...(accepted ? {} : { reason: 'Question has already settled' }) };
  }
  async *observe(sessionId: string, afterSeq: number, signal: AbortSignal): AsyncIterable<NormalizedDshFrame> {
    const control = new AbortController(); const abort = () => control.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) control.abort();
    const queue = new AsyncQueue<{ type: 'session'; frame: SessionFollowFrame } | { type: 'interaction'; value: BridgeInteraction }>();
    const close = () => queue.close(); control.signal.addEventListener('abort', close, { once: true });
    const unsubscribe = this.interactions.subscribe(sessionId, value => queue.push({ type: 'interaction', value }));
    const projection = new SessionProjection(); let cursor = -1; let attemptId = ''; let text = ''; let lastIndex = -1;
    const source = this.ctx.sessionController.follow({ address: { kind: 'session', sessionId: SessionId(sessionId) }, assistantStream: true, maxMessages: 100 }, control.signal);
    const producer = (async () => { try { for await (const frame of source) queue.push({ type: 'session', frame }); queue.close(); } catch (e) { queue.close(control.signal.aborted ? undefined : e instanceof Error ? e : new Error(String(e))); } })();
    try {
      for await (const item of queue) {
        if (control.signal.aborted) break;
        if (item.type === 'interaction') { yield { kind: 'interaction', sourceSeq: Math.max(0, cursor), requestId: projection.currentRequestId, interaction: item.value }; continue; }
        const frame = item.frame;
        if (frame.type === 'snapshot') {
          // Follow attaches before inspection: its cursor cuts the backfill, then buffered live events follow.
          const inspected = await this.ctx.sessionController.inspect(SessionId(sessionId), control.signal);
          for (const event of inspected.events) {
            if (event.seq > frame.cursor) break; cursor = event.seq;
            const normalized = projection.fold(event); if (event.seq > afterSeq) yield* normalized;
          }
          const attempt = frame.assistantStream?.activeAttempt;
          if (attempt) { attemptId = attempt.attemptId; text = baselineText(attempt.stream); lastIndex = attempt.nextIndex - 1; yield { kind: 'stream', messageId: attemptId, requestId: projection.currentRequestId, turn: projection.currentTurn, attemptId, streamRevision: frame.assistantStream!.revision, index: attempt.nextIndex, text }; }
          yield* this.questionFrames(sessionId, frame.projections.values.userQuestions, cursor, projection);
        } else if (frame.type === 'event') {
          if (frame.event.seq <= cursor) continue; cursor = frame.event.seq;
          yield* projection.fold(frame.event);
          if (frame.event.type === 'tool/result' || frame.event.type === 'user/message') {
            const state = await this.ctx.sessionController.projections({ sessionId: SessionId(sessionId) }, control.signal);
            if (state) yield* this.questionFrames(sessionId, state.values.userQuestions, cursor, projection);
          }
        } else {
          const s = frame.frame;
          if (s.type === 'start') { attemptId = s.attemptId; text = ''; lastIndex = -1; }
          if (s.attemptId !== attemptId) continue;
          if (s.type === 'chunk') { if (s.index <= lastIndex) continue; if (s.index !== lastIndex + 1) throw new Error('DSH assistant stream gap; reconnect required'); lastIndex = s.index; text += streamText(s.chunk); }
          if (s.type === 'end') text = '';
          yield { kind: 'stream', messageId: attemptId, requestId: projection.currentRequestId, turn: projection.currentTurn, attemptId, streamRevision: s.revision, index: s.type === 'start' ? 0 : s.index + (s.type === 'chunk' ? 1 : 0), text };
        }
      }
    } finally { control.abort(); unsubscribe(); signal.removeEventListener('abort', abort); control.signal.removeEventListener('abort', close); await producer; }
  }
  private *questionFrames(sessionId: string, state: unknown, sourceSeq: number, projection: SessionProjection): Iterable<NormalizedDshFrame> {
    const active = record(state).active; const current = new Set<string>();
    if (Array.isArray(active)) for (const raw of active) {
      const q = record(raw); if (q.state !== 'continued' || typeof q.callId !== 'string' || !Array.isArray(q.questions)) continue;
      const id = `continued:${sessionId}:${q.callId}`; current.add(id); if (this.continued.has(id)) continue;
      const questions: Interaction['questions'] = q.questions.map(rawQ => { const item = record(rawQ); return { id: String(item.id), question: String(item.question), options: Array.isArray(item.options) ? item.options.map(o => String(record(o).label)) : undefined, multiple: item.multiSelect === true }; });
      const value: BridgeInteraction = { id, kind: 'question', title: 'Assistant question (reply continues the session)', questions, status: 'pending', revision: 1 };
      this.continued.set(id, { sessionId, callId: q.callId, value }); yield { kind: 'interaction', sourceSeq, requestId: projection.requestForCall(q.callId) ?? projection.currentRequestId, interaction: value };
    }
    for (const [id, old] of this.continued) if (old.sessionId === sessionId && !current.has(id)) { this.continued.delete(id); yield { kind: 'interaction', sourceSeq, requestId: projection.requestForCall(old.callId) ?? projection.currentRequestId, interaction: { ...old.value, status: 'answered', revision: old.value.revision + 1 } }; }
  }
}
