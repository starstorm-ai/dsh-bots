import { hostname } from 'node:os';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-cmdline';
import { BotsService } from '../../core/src/service.ts';
import { BotsError, parseCommand, toJsonValue, type Bootstrap, type Command, type JsonValue, type Message, type RoomEvent, type RoomSnapshot, type Ticket } from '../../protocol/src/index.ts';
import { HostDshAdapter } from './adapter/dsh-adapter.ts';
import { LanServer } from './lan.ts';
import { AsyncQueue } from './async-queue.ts';

export interface Config { dataDirectory?: string; hostName?: string }
export type DesktopBootstrap = Bootstrap;
export interface RoomRequest { roomId: string }
export interface HistoryRequest extends RoomRequest { beforeSeq?: number; limit?: number; search?: string }
export interface StreamRequest { roomId?: string; afterSeq?: number }
export type DesktopCommand = Command;

declare module '@deepseek-ai/cordis' { interface Context { dshBots: DshBotsController } }

/** Host-authoritative chat and device management for the DSH operator desktop. */
export class DshBotsController extends TypertRemoteService {
  static inject = ['sessionController', 'agents', 'sessions', 'workspaceRegistry', 'agentPresets', 'userQuestions', 'connection', 'typertGateway', 'typert'];
  static Config: Schema<Config> = Schema.object({ dataDirectory: Schema.string(), hostName: Schema.string() });
  private readonly service: BotsService;
  private readonly adapter: HostDshAdapter;
  private readonly lan: LanServer;
  private initialization?: Promise<void>;
  private stopped = false;
  private readonly streams = new Set<AsyncQueue<RoomEvent>>();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'dshBots', { namespace: 'dshBots' });
    const directory = config.dataDirectory ? resolve(config.dataDirectory) : dshHomePath('data', 'dsh-bots');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.adapter = new HostDshAdapter(ctx);
    this.service = new BotsService({ databasePath: resolve(directory, 'bots.sqlite'), adapter: this.adapter, hostName: config.hostName ?? hostname() });
    this.lan = new LanServer({ service: this.service, stateDirectory: directory, hostName: this.service.hostName });
    ctx.on('agent/status', () => { if (!this.stopped) this.service.notifyRuntimeChanged(); });
    ctx.effect(() => {
      const begin = () => { if (!this.stopped) void this.initialize().catch(error => console.error('[dsh-bots] Startup failed:', error)); };
      const ready = ctx.get('appReady');
      if (ready) return ready.onReady(begin);
      queueMicrotask(begin);
      return () => {};
    }, 'dsh-bots: application readiness');
    ctx.effect(() => async () => {
      this.stopped = true; for (const stream of this.streams) stream.close();
      await this.initialization?.catch(() => {});
      await this.lan.dispose(); await this.adapter.dispose(); await this.service.dispose();
    }, 'dsh-bots: database, observers, interactions and LAN transport');
  }
  private initialize(): Promise<void> {
    if (this.stopped) return Promise.reject(new BotsError('UNAVAILABLE', 'DSH Bots is stopped'));
    return this.initialization ??= (async () => { this.adapter.start(); await this.service.start(); await this.lan.start(); })();
  }
  @Remote('bootstrap')
  async bootstrap(_request: Record<string, never>, signal: AbortSignal): Promise<DesktopBootstrap> {
    signal.throwIfAborted(); await this.initialize(); return this.service.bootstrap(this.service.ownerPrincipal);
  }
  @Remote('command')
  async command(request: DesktopCommand, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted(); await this.initialize(); this.service.assertPrincipal(this.service.ownerPrincipal);
    const command = parseCommand(request);
    if (command.type === 'room.invite.create') {
      await this.lan.ensureListening();
      const ticket = await this.service.command(this.service.ownerPrincipal, command) as Ticket;
      return toJsonValue(this.lan.decorateTicket(ticket));
    }
    return toJsonValue(await this.service.command(this.service.ownerPrincipal, command));
  }
  @Remote('snapshot')
  async snapshot(request: RoomRequest, signal: AbortSignal): Promise<RoomSnapshot> { signal.throwIfAborted(); await this.initialize(); return this.service.snapshot(this.service.ownerPrincipal, request.roomId); }
  @Remote('history')
  async history(request: HistoryRequest, signal: AbortSignal): Promise<{ messages: Message[]; hasMore: boolean }> { signal.throwIfAborted(); await this.initialize(); return this.service.history(this.service.ownerPrincipal, request.roomId, request); }
  @Remote({ mode: 'stream' })
  async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<RoomEvent> {
    await this.initialize(); const principal = this.service.ownerPrincipal;
    const queue = new AsyncQueue<RoomEvent>(); this.streams.add(queue); const abort = () => queue.close();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) queue.close();
    const off = this.service.onEvent(event => {
      if (request.roomId && event.roomId && event.roomId !== request.roomId) return;
      if (event.personId && event.personId !== principal.personId) return;
      if (event.deviceId && event.deviceId !== principal.deviceId) return;
      if (event.roomId && !this.service.canAccess(principal, event.roomId)) { queue.push({ version: 1, kind: 'event', type: 'bootstrap.changed', payload: {} }); return; }
      queue.push(event);
    });
    try {
      let cursor = request.afterSeq ?? 0;
      if (request.roomId) {
        let more = true;
        while (more) { const page = this.service.events(principal, request.roomId, cursor); for (const event of page.events) { yield event; cursor = event.seq ?? cursor; } more = page.hasMore; }
      }
      for await (const event of queue) { if (signal.aborted || this.stopped) break; if (request.roomId && event.seq !== undefined) { if (event.seq <= cursor) continue; cursor = event.seq; } yield event; }
    } finally { off(); signal.removeEventListener('abort', abort); queue.close(); this.streams.delete(queue); }
  }
}

export default DshBotsController;
