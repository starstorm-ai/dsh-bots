import { createHash, createPrivateKey, randomBytes, webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, X509CertificateGenerator } from '@peculiar/x509';
import { WebSocketServer, WebSocket } from 'ws';
import type { BotsService } from '../../core/src/service.ts';
import { BotsError, LIMITS, parseCommand } from '../../protocol/src/index.ts';
import type { Principal, RoomEvent, Ticket, InviteTicket } from '../../protocol/src/index.ts';

interface LanState { enabled: boolean; port: number }
export interface ConnectionInfo extends LanState { addresses: string[]; listening: boolean; fingerprint?: string; error?: string }
interface SocketState { socket: WebSocket; token?: string; principal?: Principal; rooms: Map<string, number>; authTimer: ReturnType<typeof setTimeout>; queue: Promise<void>; pending: number; alive: boolean; remote: string }
const MAX_BODY = 64 * 1024;
const MAX_BUFFER = 2 * 1024 * 1024;
const DEFAULT_PORT = 49210;

function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BotsError('INVALID_REQUEST', 'Expected JSON object'); return value as Record<string, unknown>; }
function text(value: unknown, name: string, max = 512): string { if (typeof value !== 'string' || !value || value.length > max) throw new BotsError('INVALID_REQUEST', `Invalid ${name}`); return value; }
function optionalText(value: unknown, name: string): string | undefined { return value === undefined ? undefined : text(value, name); }
function number(value: unknown, name: string, fallback = 0): number { if (value === undefined || value === null) return fallback; const result = typeof value === 'number' ? value : Number(value); if (!Number.isSafeInteger(result) || result < 0) throw new BotsError('INVALID_REQUEST', `Invalid ${name}`); return result; }
function addresses(): string[] { return [...new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address))])]; }
function endpoint(address: string, port: number): string { return `https://${isIP(address) === 6 ? `[${address}]` : address}:${port}`; }
function writePrivate(path: string, value: unknown): void { const pending = `${path}.pending`; writeFileSync(pending, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(pending, path); chmodSync(path, 0o600); }
function safeError(error: unknown): BotsError { return error instanceof BotsError ? error : new BotsError('INTERNAL', 'The request could not be completed', true); }
function status(error: BotsError): number { if (/UNAUTHORIZED|REVOKED|EXPIRED/.test(error.code)) return 401; if (/FORBIDDEN|NOT_ROOM_MEMBER/.test(error.code)) return 403; if (/NOT_FOUND/.test(error.code)) return 404; if (error.code === 'RATE_LIMITED') return 429; if (error.code === 'PAYLOAD_TOO_LARGE') return 413; return error.code === 'INTERNAL' ? 500 : 400; }

/** Dedicated TLS LAN surface; never exposes the DSH administrative gateway. */
export class LanServer {
  private readonly service: BotsService;
  private readonly directory: string;
  private config: LanState;
  private readonly bindAddress: string;
  private server?: Server;
  private wss?: WebSocketServer;
  private fingerprint?: string;
  private error?: string;
  private listeningPort?: number;
  private eventCleanup?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly sockets = new Set<SocketState>();
  private readonly rates = new Map<string, { at: number; count: number }>();
  private lifecycle: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: { service: BotsService; stateDirectory: string; hostName: string; listen?: { address: string; port: number } }) {
    this.service = options.service; this.directory = options.stateDirectory;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = resolve(this.directory, 'network.json');
    const saved = existsSync(file) ? record(JSON.parse(readFileSync(file, 'utf8'))) : {};
    this.config = { enabled: saved.enabled === true, port: Number.isInteger(saved.port) && Number(saved.port) > 0 && Number(saved.port) <= 65535 ? Number(saved.port) : DEFAULT_PORT };
    // Network choices are automatic in production. Explicit loopback/ephemeral
    // settings exist only for an isolated transport host (including tests).
    this.bindAddress = options.listen?.address ?? '0.0.0.0';
    if (options.listen) this.config.port = options.listen.port;
    if (!isIP(this.bindAddress) || !['0.0.0.0', '::', '::1', ...addresses()].includes(this.bindAddress)) throw new BotsError('INVALID_REQUEST', 'Listener must bind a local interface');
    if (!Number.isInteger(this.config.port) || this.config.port < 0 || this.config.port > 65535) throw new BotsError('INVALID_REQUEST', 'Invalid listen port');
    // Discard the obsolete workspace and manual-interface configuration.
    if (existsSync(file)) writePrivate(file, this.config);
  }

  info(): ConnectionInfo {
    const port = this.listeningPort ?? this.config.port;
    const hosts = this.bindAddress === '0.0.0.0' || this.bindAddress === '::' ? addresses().filter(address => address !== '127.0.0.1') : [this.bindAddress];
    return { ...this.config, port, listening: this.listeningPort !== undefined, addresses: this.listeningPort !== undefined ? [...new Set(hosts)].map(address => endpoint(address, port)) : [], ...(this.fingerprint ? { fingerprint: this.fingerprint } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  async start(): Promise<ConnectionInfo> { return this.config.enabled ? this.ensureListening() : this.info(); }

  /** Lazy, serialized activation. Closing a QR never interrupts joined devices. */
  async ensureListening(): Promise<ConnectionInfo> {
    const task = this.lifecycle.catch(() => {}).then(async () => {
      if (this.disposed) throw new BotsError('UNAVAILABLE', 'LAN server has been disposed');
      if (this.listeningPort !== undefined) return this.info();
      this.error = undefined;
      try {
        try { await this.listen(); }
        catch (error) {
          await this.stop();
          // Windows excluded port ranges report EACCES instead of EADDRINUSE.
          // Retry once on an OS-assigned port; genuine listener failures still surface.
          if (!error || typeof error !== 'object' || !('code' in error) || !['EADDRINUSE', 'EACCES'].includes(String(error.code))) throw error;
          this.config.port = 0; await this.listen();
        }
        this.config = { enabled: true, port: this.listeningPort! };
        writePrivate(resolve(this.directory, 'network.json'), this.config);
      } catch (error) {
        await this.stop(); this.error = error instanceof Error ? error.message : 'Unable to listen';
        throw new BotsError('LAN_UNAVAILABLE', this.error, true);
      }
      return this.info();
    });
    this.lifecycle = task; return task;
  }

  decorateTicket(ticket: Ticket): InviteTicket {
    const info = this.info();
    if (!this.server || !info.fingerprint) throw new BotsError('NETWORK_DISABLED', 'LAN listener is not running');
    if (!info.addresses.length) throw new BotsError('NO_LAN_INTERFACE', 'Connect this computer to Wi-Fi or a hotspot before inviting another device');
    const payload = { protocol: 1 as const, kind: 'invite' as const, hostId: this.service.hostId, storeEpoch: this.service.storeEpoch, addresses: info.addresses, fingerprint: info.fingerprint, token: ticket.token, expiresAt: ticket.expiresAt, roomId: ticket.roomId, historyVisibility: 'full' as const };
    const qrPayload = JSON.stringify(payload);
    return { ...ticket, ...payload, qrPayload, uri: `dshbots://invite?data=${encodeURIComponent(qrPayload)}` };
  }

  async dispose(): Promise<void> { this.disposed = true; await this.lifecycle.catch(() => {}); await this.stop(); }

  private async identity(): Promise<{ key: string; cert: string }> {
    const path = resolve(this.directory, 'tls-identity.json');
    if (existsSync(path)) {
      const saved = record(JSON.parse(readFileSync(path, 'utf8')));
      const key = text(saved.key, 'TLS private key', 32000); const cert = text(saved.cert, 'TLS certificate', 32000);
      return { key, cert };
    }
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const certificate = await X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(16).toString('hex'), name: 'CN=DSH Bots',
      notBefore: new Date(Date.now() - 300_000), notAfter: new Date(Date.now() + 10 * 365 * 86400_000), signingAlgorithm: algorithm, keys: keys as CryptoKeyPair,
      extensions: [new BasicConstraintsExtension(false), new KeyUsagesExtension(KeyUsageFlags.digitalSignature), new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), new SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }, ...addresses().map(value => ({ type: 'ip' as const, value }))])],
    }, webcrypto as unknown as Crypto);
    const key = createPrivateKey({ key: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)), format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }).toString();
    const result = { key, cert: certificate.toString('pem') }; writePrivate(path, result); return result;
  }

  private async listen(): Promise<void> {
    const identity = await this.identity();
    const pemBody = identity.cert.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    this.fingerprint = createHash('sha256').update(Buffer.from(pemBody, 'base64')).digest('hex');
    const server = createServer({ ...identity, minVersion: 'TLSv1.2', maxHeaderSize: 16 * 1024 }, (request, response) => { void this.http(request, response); });
    this.server = server; server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000; server.maxConnections = 256;
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY, perMessageDeflate: false }); this.wss = wss;
    server.on('upgrade', (request, socket, head) => {
      try {
        const url = this.requestUrl(request); this.checkOrigin(request);
        if (url.pathname !== '/v1/ws' || url.search) throw new BotsError('INVALID_REQUEST', 'Invalid WebSocket endpoint');
        this.rate(request.socket.remoteAddress ?? 'unknown', 120);
        if (this.sockets.size >= 64) throw new BotsError('RATE_LIMITED', 'Too many connections');
        const token = this.bearer(request, false); if (token) this.service.authenticate(token);
        wss.handleUpgrade(request, socket, head, ws => this.openSocket(ws, request, token));
      } catch (error) { const problem = safeError(error); socket.end(`HTTP/1.1 ${status(problem)} Rejected\r\nConnection: close\r\n\r\n`); }
    });
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(this.config.port, this.bindAddress, () => { server.off('error', reject); done(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No LAN listen address'); this.listeningPort = address.port;
    server.on('error', error => { this.error = error.message; });
    this.eventCleanup = this.service.onEvent(event => this.broadcast(event));
    this.heartbeat = setInterval(() => {
      for (const state of this.sockets) {
        try { if (!state.alive) { state.socket.terminate(); continue; } if (state.token) state.principal = this.service.authenticate(state.token); state.alive = false; state.socket.ping(); }
        catch { state.socket.close(4401, 'Credentials expired or revoked'); }
      }
      for (const [key, rate] of this.rates) if (Date.now() - rate.at > 60_000) this.rates.delete(key);
    }, 15_000); this.heartbeat.unref();
  }

  private async stop(): Promise<void> {
    this.eventCleanup?.(); this.eventCleanup = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined;
    for (const state of this.sockets) { clearTimeout(state.authTimer); state.socket.terminate(); } this.sockets.clear();
    this.wss?.close(); this.wss = undefined;
    const server = this.server; this.server = undefined; this.listeningPort = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  }

  private rate(key: string, limit: number): void {
    const current = this.rates.get(key); const value = current && Date.now() - current.at < 60_000 ? current : { at: Date.now(), count: 0 };
    if (++value.count > limit) throw new BotsError('RATE_LIMITED', 'Request rate exceeded', true);
    if (this.rates.size > 4096 && !this.rates.has(key)) throw new BotsError('RATE_LIMITED', 'Too many clients', true);
    this.rates.set(key, value);
  }
  private requestUrl(request: IncomingMessage): URL { const value = new URL(request.url ?? '/', 'https://dsh.invalid'); if (value.origin !== 'https://dsh.invalid') throw new BotsError('INVALID_REQUEST', 'Absolute request targets are not accepted'); if (value.searchParams.has('token') || value.searchParams.has('accessToken')) throw new BotsError('INVALID_REQUEST', 'Credentials must not be sent in URLs'); return value; }
  private checkOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin; if (!origin) return;
    if (!this.info().addresses.includes(origin)) throw new BotsError('FORBIDDEN_ORIGIN', 'Cross-origin requests are not allowed');
  }
  private bearer(request: IncomingMessage, required = true): string | undefined { const header = request.headers.authorization; if (!header && !required) return; if (!header?.startsWith('Bearer ')) throw new BotsError('UNAUTHORIZED', 'Bearer credentials required'); return text(header.slice(7), 'access token', 256); }
  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new BotsError('INVALID_REQUEST', 'Content-Type must be application/json');
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY) throw new BotsError('PAYLOAD_TOO_LARGE', 'Request body too large');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { const bytes = Buffer.from(chunk as Uint8Array); length += bytes.length; if (length > MAX_BODY) throw new BotsError('PAYLOAD_TOO_LARGE', 'Request body too large'); chunks.push(bytes); }
    try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { if (error instanceof BotsError) throw error; throw new BotsError('INVALID_REQUEST', 'Malformed JSON'); }
  }
  private json(response: ServerResponse, code: number, value: unknown): void { if (response.destroyed || response.writableEnded) return; response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); }
  private async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.checkOrigin(request); const url = this.requestUrl(request); const method = request.method;
      const remote = request.socket.remoteAddress ?? 'unknown'; this.rate(`http:${remote}`, 600);
      if (method === 'GET' && url.pathname === '/v1/health') { this.json(response, 200, { protocol: 1, status: 'ok', features: ['receipt-only'] }); return; }
      if (method === 'POST' && ['/v1/invite', '/v1/refresh'].includes(url.pathname)) {
        this.rate(`credential:${remote}`, 30); const body = await this.body(request);
        const token = optionalText(body.token, 'token');
        const common = { token: token ?? '', deviceName: optionalText(body.deviceName, 'deviceName') ?? '', requestId: optionalText(body.requestId, 'requestId'), deviceChallenge: optionalText(body.deviceChallenge, 'deviceChallenge') };
        const existing = this.bearer(request, false);
        const result = url.pathname === '/v1/refresh' ? this.service.refresh(text(body.refreshToken, 'refreshToken')) : this.service.redeemInvite({ ...common, displayName: optionalText(body.displayName, 'displayName') ?? '', receiptOnly: body.receiptOnly === true }, existing ? this.service.authenticate(existing) : undefined);
        this.json(response, 200, result); return;
      }
      const principal = this.service.authenticate(this.bearer(request)!);
      let result: unknown;
      if (method === 'GET' && url.pathname === '/v1/bootstrap') result = await this.service.bootstrap(principal);
      else if (method === 'GET' && url.pathname === '/v1/snapshot') result = this.service.snapshot(principal, text(url.searchParams.get('roomId'), 'roomId'));
      else if (method === 'GET' && url.pathname === '/v1/history') result = this.service.history(principal, text(url.searchParams.get('roomId'), 'roomId'), { beforeSeq: url.searchParams.has('beforeSeq') ? number(url.searchParams.get('beforeSeq'), 'beforeSeq') : undefined, limit: number(url.searchParams.get('limit'), 'limit', 100), search: url.searchParams.get('search') ?? undefined });
      else if (method === 'GET' && url.pathname === '/v1/events') result = this.service.events(principal, text(url.searchParams.get('roomId'), 'roomId'), number(url.searchParams.get('afterSeq'), 'afterSeq'), number(url.searchParams.get('limit'), 'limit', 500));
      else if (method === 'POST' && url.pathname === '/v1/command') result = await this.command(principal, await this.body(request));
      else throw new BotsError('NOT_FOUND', 'Unknown endpoint');
      this.json(response, 200, result);
    } catch (error) { const problem = safeError(error); this.json(response, status(problem), { error: problem.toJSON() }); }
  }

  private async command(principal: Principal, input: unknown): Promise<unknown> {
    const command = parseCommand(input); const result = await this.service.command(principal, command);
    return command.type === 'room.invite.create' ? this.decorateTicket(result as Ticket) : result;
  }
  private send(state: SocketState, value: unknown): void { if (state.socket.readyState !== WebSocket.OPEN) return; if (state.socket.bufferedAmount > MAX_BUFFER) { state.socket.close(4408, 'Slow consumer; reconnect with last durable cursor'); return; } state.socket.send(JSON.stringify(value)); }
  private openSocket(socket: WebSocket, request: IncomingMessage, token?: string): void {
    const state: SocketState = { socket, token, ...(token ? { principal: this.service.authenticate(token) } : {}), rooms: new Map(), authTimer: setTimeout(() => { if (!state.principal) socket.close(4401, 'Authentication timeout'); }, 5_000), queue: Promise.resolve(), pending: 0, alive: true, remote: request.socket.remoteAddress ?? 'unknown' };
    this.sockets.add(state); socket.on('pong', () => { state.alive = true; });
    socket.on('close', () => { clearTimeout(state.authTimer); this.sockets.delete(state); }); socket.on('error', () => socket.terminate());
    if (state.principal) this.send(state, { version: 1, kind: 'ready', hostId: this.service.hostId, storeEpoch: this.service.storeEpoch });
    socket.on('message', (raw, binary) => {
      if (binary || ++state.pending > 32) { socket.close(4408, 'Invalid frame or command backlog'); return; }
      state.queue = state.queue.then(async () => {
        let input: Record<string, unknown> = {};
        try {
          this.rate(`ws:${state.remote}`, 600); input = record(JSON.parse(raw.toString()));
          if (input.kind === 'auth') { state.token = text(input.accessToken, 'accessToken', 256); state.principal = this.service.authenticate(state.token); clearTimeout(state.authTimer); this.send(state, { version: 1, kind: 'ready', hostId: this.service.hostId, storeEpoch: this.service.storeEpoch }); return; }
          if (!state.token) throw new BotsError('UNAUTHORIZED', 'Authenticate before subscribing');
          state.principal = this.service.authenticate(state.token);
          if (input.kind === 'subscribe') {
            const roomId = text(input.roomId, 'roomId'); if (state.rooms.size >= LIMITS.subscriptions && !state.rooms.has(roomId)) throw new BotsError('RATE_LIMITED', 'Too many subscriptions');
            if (input.storeEpoch !== undefined && input.storeEpoch !== this.service.storeEpoch) throw new BotsError('SNAPSHOT_REQUIRED', 'Host store changed');
            let cursor = number(input.afterSeq, 'afterSeq'); let page = this.service.events(state.principal, roomId, cursor);
            state.rooms.set(roomId, cursor);
            for (;;) { for (const event of page.events) { this.send(state, event); cursor = event.seq!; } if (!page.hasMore) break; page = this.service.events(state.principal, roomId, cursor); }
            state.rooms.set(roomId, cursor); this.send(state, { version: 1, kind: 'subscribed', id: input.id, roomId, cutoff: page.cutoff }); return;
          }
          if (input.kind === 'unsubscribe') { state.rooms.delete(text(input.roomId, 'roomId')); return; }
          if (input.kind === 'ping') { this.send(state, { version: 1, kind: 'pong', id: input.id }); return; }
          const result = await this.command(state.principal, input); this.send(state, { version: 1, kind: 'response', id: input.id, result });
        } catch (error) { const problem = error instanceof SyntaxError ? new BotsError('INVALID_REQUEST', 'Malformed JSON') : safeError(error); this.send(state, { version: 1, kind: 'error', id: input.id, error: problem.toJSON() }); if (status(problem) === 401) state.socket.close(4401, 'Credentials expired or revoked'); }
      }).finally(() => { state.pending--; });
    });
  }
  private broadcast(event: RoomEvent): void {
    for (const state of this.sockets) {
      if (!state.token) continue;
      try {
        const principal = this.service.authenticate(state.token); state.principal = principal;
        if (event.personId && event.personId !== principal.personId && principal.hostRole !== 'owner') continue;
        if (event.deviceId && event.deviceId !== principal.deviceId && principal.hostRole !== 'owner') continue;
        if (event.roomId) {
          if (event.type === 'room.access.revoked' && event.personId === principal.personId) { state.rooms.delete(event.roomId); this.send(state, event); continue; }
          if (!this.service.canAccess(principal, event.roomId)) { state.rooms.delete(event.roomId); continue; }
          if (!state.rooms.has(event.roomId)) continue;
          const cursor = state.rooms.get(event.roomId)!; if (event.seq !== undefined && event.seq <= cursor) continue;
          if (event.seq !== undefined) state.rooms.set(event.roomId, event.seq);
          this.send(state, event);
        } else {
          this.send(state, { version: 1, kind: 'event', type: 'bootstrap.changed', payload: {} });
        }
      } catch { state.socket.close(4401, 'Credentials expired or revoked'); }
    }
  }
}
