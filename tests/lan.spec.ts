import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import { BotsService } from '../packages/core/src/service.ts';
import type { DshAdapter, NormalizedDshFrame } from '../packages/core/src/adapter.ts';
import type { Credentials, Room, Ticket } from '../packages/protocol/src/index.ts';
import { LanServer } from '../packages/dsh-plugin/src/lan.ts';

const adapter: DshAdapter = {
  async capabilities() { return { contextInjection: true, runningContextInjection: true, interactions: true }; },
  async listWorkspaces() { return [{ id: 'workspace', name: 'Test' }]; }, async listPresets() { return []; }, async listSessions() { return []; },
  async ensureBindingSession() {}, async sessionCutoff() { return 0; }, async injectContext() { return { accepted: true }; }, async inspectContext() { return { kind: 'absent' }; },
  async submit() { return { accepted: true }; }, async inspectRequest() { return { kind: 'absent' }; },
  async *observe(_session, _seq, signal): AsyncIterable<NormalizedDshFrame> { await new Promise<void>(done => { if (signal.aborted) done(); else signal.addEventListener('abort', () => done(), { once: true }); }); },
  async cancelInvocation() { return { cancelled: true }; }, async answerInteraction() { return { accepted: true }; },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { port?: number; lazy?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-bots-lan-'));
  const service = new BotsService({ databasePath: join(directory, 'bots.sqlite'), adapter }); await service.start();
  const lan = new LanServer({ service, stateDirectory: directory, hostName: 'Test DSH', listen: { address: '127.0.0.1', port: options.port ?? 0 } });
  const info = options.lazy ? await lan.start() : await lan.ensureListening();
  if (info.error) throw new Error(info.error);
  cleanups.push(async () => { await lan.dispose(); await service.dispose(); rmSync(directory, { recursive: true, force: true }); });
  return { service, lan, info, directory, origin: info.addresses[0]!, owner: service.ownerPrincipal };
}

async function http(origin: string, path: string, options: { token?: string; body?: unknown; origin?: string } = {}): Promise<{ status: number; data: any; fingerprint?: string }> {
  return await new Promise((done, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(`${origin}${path}`, { rejectUnauthorized: false, method: body ? 'POST' : 'GET', headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(options.origin ? { origin: options.origin } : {}) } }, response => {
      const raw = (response.socket as TLSSocket).getPeerCertificate().raw;
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.once('end', () => done({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()), fingerprint: raw ? createHash('sha256').update(raw).digest('hex') : undefined }));
    });
    req.once('error', reject); req.end(body);
  });
}
async function joinChat(f: Awaited<ReturnType<typeof fixture>>, room?: Room): Promise<Credentials> {
  room ??= await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'group', title: 'Shared' } }) as Room;
  const ticket = await f.service.command(f.owner, { type: 'room.invite.create', payload: { roomId: room.id } }) as Ticket;
  const response = await http(f.origin, '/v1/invite', { body: { token: ticket.token, displayName: 'Guest', deviceName: 'Phone', requestId: 'first-request', deviceChallenge: 'device-local-challenge' } });
  expect(response.status).toBe(200); return response.data as Credentials;
}
async function socket(f: Awaited<ReturnType<typeof fixture>>, token?: string) {
  const ws = new WebSocket(`${f.origin.replace('https:', 'wss:')}/v1/ws`, { rejectUnauthorized: false, headers: token ? { authorization: `Bearer ${token}` } : undefined });
  const messages: any[] = []; const waiters = new Set<() => void>();
  ws.on('message', raw => { messages.push(JSON.parse(raw.toString())); for (const wake of waiters) wake(); });
  const next = async (predicate: (value: any) => boolean): Promise<any> => {
    return await new Promise((done, reject) => {
      const check = () => { const index = messages.findIndex(predicate); if (index >= 0) { clearTimeout(timer); waiters.delete(check); done(messages.splice(index, 1)[0]); } };
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`No matching WebSocket frame; received ${JSON.stringify(messages)}`)); }, 4000);
      waiters.add(check); check();
    });
  };
  await new Promise<void>((done, reject) => { ws.once('open', done); ws.once('error', reject); });
  cleanups.push(async () => { ws.terminate(); }); return { ws, next, messages };
}

describe('TLS LAN transport', () => {
  it('falls back automatically when Windows excludes the preferred port', async () => {
    const f = await fixture({ lazy: true });
    const listen = vi.spyOn(f.lan as unknown as { listen(): Promise<void> }, 'listen').mockRejectedValueOnce(Object.assign(new Error('Reserved Windows port'), { code: 'EACCES' }));
    const info = await f.lan.ensureListening();
    expect(listen).toHaveBeenCalledTimes(2); expect(info.listening).toBe(true);
    expect((await http(info.addresses[0]!, '/v1/health')).status).toBe(200);
  });
  it('starts only when invited and automatically recovers from an occupied port', async () => {
    const occupied = await fixture(); const f = await fixture({ port: occupied.info.port, lazy: true });
    expect(f.info.listening).toBe(false); expect(f.info.addresses).toEqual([]);
    const [first, concurrent] = await Promise.all([f.lan.ensureListening(), f.lan.ensureListening()]);
    expect(first.listening).toBe(true); expect(first.port).not.toBe(occupied.info.port); expect(first).toEqual(concurrent);
    expect(first.error).toBeUndefined(); expect(first.addresses[0]).toBe(`https://127.0.0.1:${first.port}`);
    const saved = JSON.parse(readFileSync(join(f.directory, 'network.json'), 'utf8'));
    expect(saved).toEqual({ enabled: true, port: first.port });
    await f.lan.dispose();
    const restored = new LanServer({ service: f.service, stateDirectory: f.directory, hostName: 'Test' });
    cleanups.push(async () => restored.dispose());
    expect((await restored.start()).port).toBe(first.port);
  });
  it('persists a certificate and exposes only health without credentials', async () => {
    const f = await fixture(); const health = await http(f.origin, '/v1/health');
    expect(health.data).toEqual({ protocol: 1, status: 'ok' }); expect(health.fingerprint).toBe(f.info.fingerprint);
    expect((await http(f.origin, '/v1/bootstrap')).status).toBe(401);
    expect((await http(f.origin, '/v1/health?token=secret')).status).toBe(400);
    expect((await http(f.origin, '/v1/health', { origin: 'https://attacker.example' })).status).toBe(403);
    const identity = readFileSync(join(f.directory, 'tls-identity.json'), 'utf8');
    const restarted = await f.lan.ensureListening();
    expect(restarted.fingerprint).toBe(f.info.fingerprint); expect(readFileSync(join(f.directory, 'tls-identity.json'), 'utf8')).toBe(identity);
  });
  it('issues an iOS invitation, recovers a lost reply and rotates member credentials', async () => {
    const f = await fixture(); const room = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'group', title: 'Invite' } }) as Room;
    const ticket = await f.service.command(f.owner, { type: 'room.invite.create', payload: { roomId: room.id } }) as Ticket;
    const decorated = f.lan.decorateTicket(ticket); const qr = JSON.parse(decorated.qrPayload);
    expect(qr.fingerprint).toBe(f.info.fingerprint); expect(qr.token).toBe(ticket.token);
    expect(decorated.uri).toBe(`dshbots://invite?data=${encodeURIComponent(decorated.qrPayload)}`); expect(qr.roomId).toBe(room.id); expect(qr.kind).toBe('invite');
    const body = { token: ticket.token, displayName: 'Guest', deviceName: 'Phone', requestId: 'receipt', deviceChallenge: 'device-secret' };
    const first = await http(f.origin, '/v1/invite', { body }); const replay = await http(f.origin, '/v1/invite', { body });
    expect(first.status).toBe(200); expect(replay.data).toEqual(first.data);
    expect((await http(f.origin, '/v1/invite', { body: { ...body, deviceChallenge: 'stolen-ticket' } })).status).toBe(400);
    expect((await http(f.origin, '/v1/bootstrap', { token: first.data.accessToken })).data.person.hostRole).toBe('member');
    const rotated = await http(f.origin, '/v1/refresh', { body: { refreshToken: first.data.refreshToken } });
    expect(rotated.status).toBe(200); expect(rotated.data.accessToken).not.toBe(first.data.accessToken);
    expect((await http(f.origin, '/v1/bootstrap', { token: first.data.accessToken })).status).toBe(401);
    expect((await http(f.origin, '/v1/refresh', { body: { refreshToken: first.data.refreshToken } })).status).toBe(401);
  });
  it('replays missed events then streams live messages without duplicate durable delivery', async () => {
    const f = await fixture();
    const room = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'group', title: 'Team' } }) as Room;
    const credentials = await joinChat(f, room);
    const send = (id: string, value: string) => f.service.command(f.owner, { type: 'message.send', payload: { roomId: room.id, clientMessageId: id, parts: [{ type: 'text', text: value }] } });
    await send('one', 'Before connecting');
    const client = await socket(f); client.ws.send(JSON.stringify({ kind: 'auth', accessToken: credentials.accessToken })); await client.next(value => value.kind === 'ready');
    client.ws.send(JSON.stringify({ kind: 'subscribe', roomId: room.id, afterSeq: 0, storeEpoch: f.service.storeEpoch }));
    const replay = await client.next(value => value.type === 'message.created'); expect(replay.payload.text).toBe('Before connecting');
    await client.next(value => value.kind === 'subscribed');
    client.ws.send(JSON.stringify({ version: 1, kind: 'command', id: 'send-two', type: 'message.send', payload: { roomId: room.id, clientMessageId: 'two', parts: [{ type: 'text', text: 'Live message' }] } }));
    const live = await client.next(value => value.type === 'message.created'); expect(live.payload.text).toBe('Live message');
    const ack = await client.next(value => value.kind === 'response' && value.id === 'send-two'); expect(ack.result.messageId).toBe(live.payload.id);
    const reconnected = await socket(f, credentials.accessToken); await reconnected.next(value => value.kind === 'ready');
    reconnected.ws.send(JSON.stringify({ kind: 'subscribe', roomId: room.id, afterSeq: replay.seq }));
    expect((await reconnected.next(value => value.type === 'message.created')).payload.id).toBe(live.payload.id);
    await reconnected.next(value => value.kind === 'subscribed'); expect(reconnected.messages.filter(value => value.type === 'message.created')).toHaveLength(0);
  });
  it('enforces invite room boundaries and closes revoked device sockets immediately', async () => {
    const f = await fixture(); const room = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'group', title: 'Shared' } }) as Room;
    const other = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'group', title: 'Private' } }) as Room;
    const ticket = await f.service.command(f.owner, { type: 'room.invite.create', payload: { roomId: room.id } }) as Ticket;
    const redeemed = await http(f.origin, '/v1/invite', { body: { token: ticket.token, displayName: 'Alice', deviceName: 'Alice phone' } });
    expect(redeemed.status).toBe(200); const token = redeemed.data.accessToken;
    expect((await http(f.origin, '/v1/bootstrap', { token })).data.rooms.map((value: Room) => value.id)).toEqual([room.id]);
    expect((await http(f.origin, `/v1/snapshot?roomId=${other.id}`, { token })).status).toBe(403);
    const client = await socket(f, token); await client.next(value => value.kind === 'ready');
    const closed = new Promise<number>(done => client.ws.once('close', code => done(code)));
    await f.service.command(f.owner, { type: 'device.revoke', payload: { deviceId: redeemed.data.principal.deviceId } });
    expect(await closed).toBe(4401);
    expect((await http(f.origin, '/v1/bootstrap', { token })).status).toBe(401);
  });
  it('disposing the listener closes sockets and keeps local chats available', async () => {
    const f = await fixture(); const credentials = await joinChat(f); const client = await socket(f, credentials.accessToken); await client.next(value => value.kind === 'ready');
    const closed = new Promise<void>(done => client.ws.once('close', () => done()));
    await f.lan.dispose(); await closed;
    expect(f.lan.info().addresses).toEqual([]); expect(f.lan.info().listening).toBe(false);
    expect((await f.service.bootstrap(f.owner)).person.id).toBe(f.owner.personId);
    await expect(http(f.origin, '/v1/health')).rejects.toThrow();
  });
  it('sends room access revocation to its removed member and suppresses later room content', async () => {
    const f = await fixture(); const room = await f.service.command(f.owner, { type: 'room.create', payload: { kind: 'group', title: 'Shared' } }) as Room;
    const ticket = await f.service.command(f.owner, { type: 'room.invite.create', payload: { roomId: room.id } }) as Ticket;
    const guest = f.service.redeemInvite({ token: ticket.token, displayName: 'Guest', deviceName: 'Guest phone' });
    const client = await socket(f, guest.accessToken); await client.next(value => value.kind === 'ready');
    client.ws.send(JSON.stringify({ kind: 'subscribe', roomId: room.id, afterSeq: 0 })); await client.next(value => value.kind === 'subscribed');
    await f.service.command(f.owner, { type: 'room.member.remove', payload: { roomId: room.id, personId: guest.principal.personId } });
    expect((await client.next(value => value.type === 'room.access.revoked')).payload.roomId).toBe(room.id);
    await f.service.command(f.owner, { type: 'message.send', payload: { roomId: room.id, clientMessageId: 'after-removal', parts: [{ type: 'text', text: 'Private after removal' }] } });
    await f.service.command(f.owner, { type: 'person.update', payload: { displayName: 'New owner name' } });
    const global = await client.next(value => value.type === 'bootstrap.changed'); expect(global.payload).toEqual({});
    client.ws.send(JSON.stringify({ kind: 'ping', id: 'barrier' })); await client.next(value => value.kind === 'pong' && value.id === 'barrier');
    expect(client.messages.some(value => value.type === 'message.created' && value.payload.text === 'Private after removal')).toBe(false);
    expect((await http(f.origin, `/v1/history?roomId=${room.id}`, { token: guest.accessToken })).status).toBe(403);
  });
});
