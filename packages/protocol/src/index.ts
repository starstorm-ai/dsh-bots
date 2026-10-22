import { commandValidationError } from './validate.ts';
export { COMMAND_SCHEMA } from './validate.ts';
/** Public wire types. IDs are opaque; identity is always derived from credentials. */
export const PROTOCOL_VERSION = { major: 1, minor: 2 } as const;
export type Id = string;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** Strip optional undefined properties and enforce the public JSON boundary. */
export function toJsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value) ?? 'null') as JsonValue; }
export type AvatarColor = 'charcoal' | 'blue' | 'teal' | 'violet' | 'amber' | 'coral';
export interface Person { id: Id; displayName: string; hostRole: 'owner' | 'member'; revokedAt?: string }
export interface Device { id: Id; personId: Id; name: string; createdAt: string; lastSeenAt: string; revokedAt?: string }
export interface Principal { personId: Id; deviceId: Id; hostRole: 'owner' | 'member' }
export interface Bot { id: Id; name: string; avatar: AvatarColor; instructions: string; instructionsVersion: number; /** Missing only on legacy assistants that still need an explicit Session selection. */ sessionId?: Id; defaultWorkspaceId: Id; defaultPresetId: string; enabled: boolean }
export interface Room { id: Id; kind: 'direct' | 'group'; title: string; ownerPersonId: Id; historyVisibility: 'full'; seq: number; revision: number; createdAt: string; deletedAt?: string; readSeq?: number; unreadCount?: number; lastMessage?: string; pinned?: boolean; memberIds?: Id[]; running?: boolean }
export interface RoomMember { roomId: Id; personId: Id; role: 'owner' | 'member'; joinedAtRoomSeq: number; displayName: string; leftAtRoomSeq?: number }
export interface Binding { id: Id; roomId: Id; botId: Id; workspaceId: Id; sessionId: Id; generation: number; active: boolean; publishFromSessionSeq: number; projectionSeq: number }
export interface BindingGrant { bindingId: Id; personId: Id; canInvoke: boolean }
export type MessagePart = { type: 'text'; text: string } | { type: 'mention'; botId: Id; label: string };
/** Public transcript blocks. Hidden reasoning, tool arguments and arbitrary file bytes are excluded. */
export type TranscriptBlock = { type: 'text'; text: string } | { type: 'tool'; callId: string; name: string; status: 'running' | 'completed' | 'failed'; summary: string } | { type: 'attachment'; name: string; mediaType?: string };
export interface TranscriptTurn { id: string; number: number; status: InvocationStatus; startedAt?: string; endedAt?: string; finalMessageId?: string }
export interface Message { id: Id; roomId: Id; seq: number; authorKind: 'person' | 'bot' | 'system'; authorId: Id; authorName: string; parts: MessagePart[]; text: string; createdAt: string; clientMessageId?: Id; replyToMessageId?: Id; invocationId?: Id; bindingId?: Id; source?: 'chat' | 'desktop' | 'assistant' | 'tool'; sourceSeq?: number; toolName?: string; sessionId?: Id; sessionMessageId?: Id; blocks?: TranscriptBlock[]; turn?: TranscriptTurn }
export type InvocationStatus = 'queued' | 'dispatching' | 'accepted' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'recovery_required';
export interface Invocation { id: Id; roomId: Id; messageId: Id; bindingId: Id; bindingGeneration: number; initiatedByPersonId: Id; initiatedByDeviceId: Id; requestId: string; triggerRoomSeq: number; status: InvocationStatus; createdAt: string; updatedAt: string; error?: string; retryOf?: Id }
export interface ContextDelivery { id: Id; bindingId: Id; bindingGeneration: number; roomMessageId: Id; roomSeq: number; dshMessageId: Id; status: 'pending' | 'accepted' | 'consumed' | 'discarded' | 'omitted' | 'recovery_required'; content: string; error?: string }
export interface Interaction { id: Id; roomId: Id; bindingId: Id; invocationId?: Id; sessionId: Id; generation: number; kind: 'question' | 'approval'; title: string; description?: string; questions?: { id: string; question: string; options?: string[]; multiple?: boolean }[]; options?: string[]; status: 'pending' | 'answered' | 'expired'; revision: number; answeredBy?: Id; answer?: JsonValue }
export interface StreamSnapshot { roomId: Id; bindingId: Id; invocationId?: Id; messageId: Id; attemptId: Id; streamRevision: number; index: number; text: string; turn?: TranscriptTurn }
export interface RoomEvent { version: 1; kind: 'event'; roomId?: Id; seq?: number; type: string; payload: JsonValue; personId?: Id; deviceId?: Id }
export interface WorkspaceSummary { id: Id; name: string; path?: string }
export interface PresetSummary { id: string; name: string }
export interface SessionSummary { id: Id; title: string; workspaceId: Id; updatedAt?: number; active?: boolean; presetId?: string }
export interface RuntimeCapabilities { contextInjection: boolean; runningContextInjection: boolean; interactions: boolean; runtimeName?: string }
export interface Bootstrap { version: typeof PROTOCOL_VERSION; hostId: Id; hostName: string; storeEpoch: Id; person: Person; device: Device; rooms: Room[]; bots: Bot[]; bindings: Binding[]; people: Person[]; devices: Device[]; workspaces: WorkspaceSummary[]; presets: PresetSummary[]; sessions: SessionSummary[]; capabilities: RuntimeCapabilities; schedulerPaused: boolean }
export interface RoomSnapshot { room: Room; members: RoomMember[]; bindings: Binding[]; grants: BindingGrant[]; bots: Bot[]; messages: Message[]; invocations: Invocation[]; interactions: Interaction[]; streams: StreamSnapshot[]; contexts: ContextDelivery[]; cutoff: number; readSeq: number; syncSeq: number }
export interface Credentials { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string; principal: Principal; hostId: Id; storeEpoch: Id }
export interface Ticket { id: Id; token: string; expiresAt: string; roomId: Id; historyVisibility?: 'full' }
export interface InviteTicket extends Ticket { hostId: string; storeEpoch: string; protocol: 1; kind: 'invite'; addresses: string[]; fingerprint: string; qrPayload: string; uri: string }
export interface CommandPayloads {
  'person.update': { displayName: string };
  'person.revoke': { personId: Id };
  'device.revoke': { deviceId: Id };
  'scheduler.update': { paused: boolean };
  'bot.create': { name: string; sessionId: Id; avatar?: AvatarColor; instructions?: string };
  'bot.update': { botId: Id; name?: string; sessionId?: Id; avatar?: AvatarColor; instructions?: string; enabled?: boolean };
  'bot.delete': { botId: Id };
  'room.create': { kind: 'direct' | 'group'; title: string; botId?: Id; workspaceId?: Id; sessionId?: Id; acknowledgeSharedContext?: boolean; importHistory?: boolean };
  'room.update': { roomId: Id; title?: string; pinned?: boolean };
  'room.delete': { roomId: Id };
  'room.owner.transfer': { roomId: Id; personId: Id };
  'room.invite.create': { roomId: Id };
  'room.invite.revoke': { inviteId: Id };
  'room.leave': { roomId: Id };
  'room.member.remove': { roomId: Id; personId: Id };
  'binding.create': { roomId: Id; botId: Id; workspaceId?: Id; sessionId?: Id; acknowledgeSharedContext?: boolean; importHistory?: boolean };
  'binding.remove': { bindingId: Id };
  'binding.reset': { bindingId: Id; workspaceId?: Id };
  'binding.grant.update': { bindingId: Id; personId: Id; canInvoke: boolean };
  'message.send': { clientMessageId: Id; roomId: Id; parts: MessagePart[]; replyToMessageId?: Id };
  'invocation.cancel': { invocationId: Id };
  'invocation.retry': { invocationId: Id };
  'interaction.answer': { interactionId: Id; revision: number; answer: JsonValue };
  'sync.resume': { roomId: Id; afterSeq: number; storeEpoch?: string };
  'sync.ack': { roomId: Id; seq: number };
  'read.update': { roomId: Id; seq: number };
}
export type CommandType = keyof CommandPayloads;
export type Command = { [T in CommandType]: { version?: 1; kind?: 'command'; id?: string; type: T; payload: CommandPayloads[T] } }[CommandType];
export interface ProtocolError { code: string; message: string; retryable: boolean }
export class BotsError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); this.name = 'BotsError'; }
  toJSON(): ProtocolError { return { code: this.code, message: this.message, retryable: this.retryable }; }
}
export const LIMITS = { messageBytes: 32_768, messageParts: 64, historyPage: 100, eventPage: 500, contextMessages: 80, contextBytes: 48_000, queuedPerBinding: 50, subscriptions: 64 } as const;
export function parseCommand(value: unknown): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BotsError('INVALID_REQUEST', 'Expected command object');
  const c = value as Record<string, unknown>;
  if (c.version !== undefined && c.version !== 1) throw new BotsError('PROTOCOL_UNSUPPORTED', 'Unsupported protocol major');
  if (typeof c.type !== 'string' || !COMMAND_TYPES.includes(c.type as CommandType)) throw new BotsError('UNKNOWN_COMMAND', 'Unknown command');
  if (!c.payload || typeof c.payload !== 'object' || Array.isArray(c.payload)) throw new BotsError('INVALID_REQUEST', 'Expected command payload');
  const error = commandValidationError(value); if (error) throw new BotsError('INVALID_REQUEST', error);
  return c as unknown as Command;
}
export const COMMAND_TYPES: CommandType[] = ['person.update', 'person.revoke', 'device.revoke', 'scheduler.update', 'bot.create', 'bot.update', 'bot.delete', 'room.create', 'room.update', 'room.delete', 'room.owner.transfer', 'room.invite.create', 'room.invite.revoke', 'room.leave', 'room.member.remove', 'binding.create', 'binding.remove', 'binding.reset', 'binding.grant.update', 'message.send', 'invocation.cancel', 'invocation.retry', 'interaction.answer', 'sync.resume', 'sync.ack', 'read.update'];
