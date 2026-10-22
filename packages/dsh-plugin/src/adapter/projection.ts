import type { NormalizedDshFrame, ContextObservation, RequestObservation } from '../../../core/src/adapter.ts';
import type { InvocationStatus, TranscriptBlock, TranscriptTurn } from '../../../protocol/src/index.ts';

export interface DurableEvent { type: string; seq: number; data: unknown; timestamp?: number | string; time?: number }
export function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function textContent(value: unknown): string {
  return Array.isArray(value) ? value.flatMap(block => { const b = record(block); return b.type === 'text' && typeof b.text === 'string' ? [b.text] : []; }).join('\n') : '';
}
export function requestId(message: unknown): string | undefined { const source = record(record(message).source); return source.kind === 'user' && typeof source.rpcId === 'string' ? source.rpcId : undefined; }
export function visibleBlocks(value: unknown): TranscriptBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((value): TranscriptBlock[] => {
    const block = record(value);
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }];
    if (block.type === 'image' || block.type === 'file') {
      const attachment = record(block.attachment);
      return [{ type: 'attachment', name: typeof block.name === 'string' ? block.name : typeof attachment.name === 'string' ? attachment.name : block.type, ...(typeof block.mediaType === 'string' ? { mediaType: block.mediaType } : {}) }];
    }
    return [];
  });
}
export function turnStatus(reason: unknown): InvocationStatus {
  switch (record(reason).kind) { case 'completed': return 'completed'; case 'aborted': return 'cancelled'; case 'interrupted': case 'forked': return 'interrupted'; default: return 'failed'; }
}

/** Only public assistant text and bounded tool summaries leave the native transcript. */
export class SessionProjection {
  currentRequestId?: string;
  active = false;
  currentTurn?: TranscriptTurn;
  private finalMessageId?: string;
  private readonly tools = new Map<string, string>();
  private readonly callRequests = new Map<string, string>();
  private readonly turnRequests = new Set<string>();
  requestForCall(callId: string): string | undefined { return this.callRequests.get(callId); }
  fold(event: DurableEvent): NormalizedDshFrame[] {
    const d = record(event.data); const out: NormalizedDshFrame[] = [];
    const time = event.time ?? event.timestamp;
    const date = time === undefined ? undefined : new Date(time);
    const timestamp = date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
    if (event.type === 'turn/start') { this.active = true; this.currentRequestId = undefined; this.turnRequests.clear(); this.finalMessageId = undefined; this.currentTurn = { id: `turn-${event.seq}`, number: typeof d.turn === 'number' ? d.turn : event.seq, status: 'running', ...(timestamp ? { startedAt: timestamp } : {}) }; }
    if (event.type === 'user/message') {
      const source = record(d.source); const ownContext = source.kind === 'dsh-bots-context';
      const rpc = requestId(d); if (rpc) { this.currentRequestId = rpc; this.turnRequests.add(rpc); }
      // Synthetic system inputs are not human chat. Our contexts only acknowledge consumption.
      if (source.kind === 'user' || ownContext) out.push({ kind: 'message', sourceSeq: event.seq, messageId: String(d.id), role: 'user', text: textContent(d.content), blocks: visibleBlocks(d.content), ...(rpc ? { requestId: rpc } : {}), ...(ownContext ? { contextMessageId: String(d.id) } : {}) });
      if (rpc) out.push({ kind: 'status', sourceSeq: event.seq, requestId: rpc, status: 'running' });
    }
    if (event.type === 'assistant/message') {
      const m = record(d.message); const text = textContent(m.content);
      const blocks = visibleBlocks(m.content);
      if (blocks.length) this.finalMessageId = String(m.id);
      if (blocks.length) out.push({ kind: 'message', sourceSeq: event.seq, messageId: String(m.id), role: 'assistant', text, blocks, requestId: this.currentRequestId });
    }
    if (event.type === 'tool/call') {
      const callId = String(d.callId); const name = String(d.name);
      this.tools.set(callId, name); if (this.currentRequestId) this.callRequests.set(callId, this.currentRequestId);
      out.push({ kind: 'message', sourceSeq: event.seq, messageId: `tool-${callId}`, role: 'tool', text: name, toolName: name, requestId: this.currentRequestId, blocks: [{ type: 'tool', callId, name, status: 'running', summary: '' }] });
    }
    if (event.type === 'tool/result') {
      const m = record(d.message); const toolName = this.tools.get(String(m.toolCallId)) ?? 'tool';
      const error = record(d.error);
      // Tool output can contain files, credentials and huge logs: the room receives the execution summary.
      const text = m.isError ? `${toolName}: failed${typeof error.reason === 'string' ? ` — ${error.reason.slice(0, 400)}` : ''}` : `${toolName}: completed`;
      out.push({ kind: 'message', sourceSeq: event.seq, messageId: `tool-${String(m.toolCallId)}`, role: 'tool', text, toolName, requestId: this.requestForCall(String(m.toolCallId)) ?? this.currentRequestId, blocks: [{ type: 'tool', callId: String(m.toolCallId), name: toolName, status: m.isError ? 'failed' : 'completed', summary: text }] });
    }
    if (event.type === 'turn/end') {
      if (this.currentTurn) this.currentTurn = { ...this.currentTurn, status: turnStatus(d.reason), ...(timestamp ? { endedAt: timestamp } : {}), ...(this.finalMessageId ? { finalMessageId: this.finalMessageId } : {}) };
      for (const rpc of this.turnRequests.size ? this.turnRequests : [undefined]) out.push({ kind: 'status', sourceSeq: event.seq, requestId: rpc, status: turnStatus(d.reason), ...(record(record(d.reason).error).message ? { error: String(record(record(d.reason).error).message) } : {}) });
      this.active = false; this.currentRequestId = undefined;
    }
    for (const frame of out) {
      if (frame.kind === 'message' && timestamp) frame.createdAt = timestamp;
      if ((frame.kind === 'message' || frame.kind === 'status') && this.currentTurn) frame.turn = { ...this.currentTurn };
    }
    if (event.type === 'turn/end') this.currentTurn = undefined;
    return out;
  }
}

/** Replay durable inbox mutations, including consumed versus removed-before-model messages. */
export function inspectDelivery(events: readonly DurableEvent[], messageId: string): ContextObservation {
  const queues: Record<string, unknown[]> = { 'next-step': [], 'next-turn': [] };
  let known: ContextObservation = { kind: 'absent' };
  for (const event of events) {
    const d = record(event.data);
    if (event.type === 'user/message' && d.id === messageId) known = { kind: 'consumed' };
    if (event.type !== 'agent/inbox/spliced') continue;
    const queue = queues[String(d.target)]; if (!queue || !Array.isArray(d.inserted) || typeof d.start !== 'number') continue;
    const removed = queue.splice(d.start, typeof d.removedCount === 'number' ? d.removedCount : 0, ...d.inserted);
    if (d.inserted.some(m => record(m).id === messageId)) known = { kind: 'accepted' };
    if (removed.some(m => record(m).id === messageId)) known = d.outcome === 'canceled' ? { kind: 'discarded' } : { kind: 'unknown' };
  }
  return known;
}

export function inspectPrompt(events: readonly DurableEvent[], rpcId: string): RequestObservation {
  const projection = new SessionProjection(); let result: RequestObservation = { kind: 'absent' };
  let messageId: string | undefined;
  for (const event of events) {
    const d = record(event.data);
    if (event.type === 'agent/inbox/spliced' && Array.isArray(d.inserted)) {
      const own = d.inserted.find(m => requestId(m) === rpcId);
      if (own) { messageId = String(record(own).id); result = { kind: 'observed', status: 'accepted' }; }
    }
    for (const frame of projection.fold(event)) if (frame.kind === 'status' && frame.requestId === rpcId) result = { kind: 'observed', status: frame.status };
  }
  if (messageId && result.kind === 'observed' && result.status === 'accepted') {
    const delivery = inspectDelivery(events, messageId);
    if (delivery.kind === 'discarded') return { kind: 'observed', status: 'cancelled' };
    if (delivery.kind === 'unknown') return { kind: 'unknown' };
  }
  return result;
}

/** Visible text only; no reasoning deltas or tool arguments. */
export function streamText(chunk: unknown): string { const d = record(chunk); return d.type === 'text-delta' && typeof d.text === 'string' ? d.text : ''; }
export function baselineText(stream: readonly unknown[]): string {
  return stream.map(item => { const r = record(item); return r.type === 'text-chunks' && Array.isArray(r.texts) ? r.texts.filter(t => typeof t === 'string').join('') : r.type === 'chunk' ? streamText(r.chunk) : ''; }).join('');
}
