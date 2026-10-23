/** Real Host transport + Swift client integration; isolated state and a non-model test adapter. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { BotsService } from '../packages/core/src/service.ts'
import { LanServer } from '../packages/dsh-plugin/src/lan.ts'
import type { DshAdapter, NormalizedDshFrame } from '../packages/core/src/adapter.ts'
import type { Room, Ticket } from '../packages/protocol/src/index.ts'
const adapter: DshAdapter = {
  async capabilities() { return { contextInjection: true, runningContextInjection: true, interactions: true } },
  async listWorkspaces() { return [] }, async listPresets() { return [] }, async listSessions() { return [] },
  async ensureBindingSession() {}, async sessionCutoff() { return 0 }, async injectContext() { return { accepted: true } }, async inspectContext() { return { kind: 'absent' } },
  async submit() { return { accepted: true } }, async inspectRequest() { return { kind: 'absent' } },
  async *observe(_session, _seq, signal): AsyncIterable<NormalizedDshFrame> { await new Promise<void>(done => { if (signal.aborted) done(); else signal.addEventListener('abort', () => done(), { once: true }) }) },
  async cancelInvocation() { return { cancelled: true } }, async answerInteraction() { return { accepted: true } },
}
const directory = mkdtempSync(join(tmpdir(), 'dsh-bots-swift-'))
const service = new BotsService({ databasePath: join(directory, 'bots.sqlite'), adapter })
const lan = new LanServer({ service, stateDirectory: directory, hostName: 'Swift test Host', listen: { address: '127.0.0.1', port: 0 } })
try {
  await service.start(); await lan.ensureListening()
  const room = await service.command(service.ownerPrincipal, { type: 'room.create', payload: { kind: 'group', title: 'Swift transport test' } }) as Room
  const ticket = await service.command(service.ownerPrincipal, { type: 'room.invite.create', payload: { roomId: room.id } }) as Ticket
  const privateRoom = await service.command(service.ownerPrincipal, { type: 'room.create', payload: { kind: 'group', title: 'Unauthorized room' } }) as Room
  const invite = lan.decorateTicket(ticket)
  const child = spawn('swift', ['test', '--package-path', 'apps/ios', '--scratch-path', '.tmp/ios-swift'], { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit', env: { ...process.env, DSH_BOTS_IOS_TEST_INVITE: invite.qrPayload, DSH_BOTS_IOS_PRIVATE_ROOM: privateRoom.id } })
  const code = await new Promise<number>((done, reject) => { child.once('error', reject); child.once('exit', code => done(code ?? 1)) })
  process.exitCode = code
} finally { await lan.dispose(); await service.dispose(); rmSync(directory, { recursive: true, force: true }) }
