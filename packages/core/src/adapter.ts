import type { Binding, Interaction, InvocationStatus, PresetSummary, RuntimeCapabilities, SessionSummary, TranscriptBlock, TranscriptTurn, WorkspaceSummary } from '../../protocol/src/index.ts';
export type ContextObservation = { kind: 'absent' | 'accepted' | 'consumed' | 'discarded' | 'unknown' };
export type RequestObservation = { kind: 'absent' | 'unknown' } | { kind: 'observed'; status: InvocationStatus };
export type NormalizedDshFrame =
  | { kind: 'message'; sourceSeq: number; messageId: string; role: 'user' | 'assistant' | 'tool'; text: string; requestId?: string; contextMessageId?: string; toolName?: string; createdAt?: string; blocks?: TranscriptBlock[]; turn?: TranscriptTurn }
  | { kind: 'status'; sourceSeq: number; requestId?: string; status: InvocationStatus; error?: string; turn?: TranscriptTurn }
  | { kind: 'stream'; messageId: string; requestId?: string; attemptId: string; streamRevision: number; index: number; text: string; turn?: TranscriptTurn }
  | { kind: 'interaction'; sourceSeq: number; requestId?: string; interaction: Omit<Interaction, 'roomId' | 'bindingId' | 'invocationId' | 'sessionId' | 'generation'> };
export interface DshAdapter {
  capabilities(): Promise<RuntimeCapabilities>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  listPresets(): Promise<PresetSummary[]>;
  listSessions(): Promise<SessionSummary[]>;
  /** Adopt the selected existing Session without changing its runtime configuration. Never create a Session. */
  ensureBindingSession(binding: Binding): Promise<void | { sessionId: string }>;
  sessionCutoff(sessionId: string): Promise<number>;
  injectContext(input: { sessionId: string; bindingGeneration: number; deliveryId: string; dshMessageId: string; content: string }): Promise<{ accepted: true }>;
  inspectContext(sessionId: string, dshMessageId: string): Promise<ContextObservation>;
  /** Remove only this plugin's still-pending background; never remove consumed input. */
  discardContext?(sessionId: string, dshMessageId: string): Promise<{ discarded: boolean }>;
  submit(input: { sessionId: string; requestId: string; prompt: string; mode: 'queue' }): Promise<{ accepted: true }>;
  inspectRequest(sessionId: string, requestId: string): Promise<RequestObservation>;
  observe(sessionId: string, afterSeq: number, signal: AbortSignal): AsyncIterable<NormalizedDshFrame>;
  cancelInvocation(input: { sessionId: string; requestId: string; invocationId: string; expectedBindingGeneration: number }): Promise<{ cancelled: boolean; reason?: string }>;
  answerInteraction(input: { interactionId: string; sessionId: string; revision: number; answer: unknown }): Promise<{ accepted: boolean; reason?: string; authoritative?: boolean }>;
}
