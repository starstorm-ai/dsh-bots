/** Boots the installed desktop composition in a disposable home; no paid model calls. */
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-session-title-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { DshBotsController } from '../packages/dsh-plugin/src/index.ts';
import type { Bot, Room, RoomEvent } from '../packages/protocol/src/index.ts';
import { EMBEDDED_ROOT, ROOT } from './lib/paths.mts';

const sourceRoot = process.env.DSH_DESKTOP_SOURCE_ROOT ?? resolve(EMBEDDED_ROOT, '.tmp/desktop-source');
const installAnchor = resolve(sourceRoot, 'apps/cli/package.json');
const sdk = createRequire(installAnchor);
const { loadProfileDirectory } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-app-boot')).href) as typeof import('@deepseek-ai/dsh-app-boot');
const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-launch-environment')).href) as typeof import('@deepseek-ai/dsh-launch-environment');
const { LlmAdapter } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-llm')).href) as typeof import('@deepseek-ai/dsh-llm');
const { ToolCallId } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-llm')).href) as typeof import('@deepseek-ai/dsh-llm');
const { defineContentToolFixture } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-tools')).href) as typeof import('@deepseek-ai/dsh-tools');
const { SessionId } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-session')).href) as typeof import('@deepseek-ai/dsh-session');
const { runProfile } = await import(pathToFileURL(resolve(sourceRoot, 'apps/cli/lib/profile-boot.js')).href) as { runProfile(options: { environment: ReturnType<typeof createLaunchEnvironmentSnapshot>; profile: string; resolvedProfile: { profile: ReturnType<typeof loadProfileDirectory>; installAnchor: string }; patchFiles: string[]; args: string[] }): Promise<{ ctx: Context; shutdown: { shutdown(code: number): Promise<void> } }> };
const sourceProfile = resolve(process.env.DSH_BOTS_DEV_HOME ?? process.env.DSH_BOTS_DSH_HOME ?? resolve(EMBEDDED_ROOT, '.tmp/dsh-home'), 'profiles/desktop');
const manifest = JSON.parse(readFileSync(resolve(sourceProfile, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } };
assert(manifest.dsh?.profile?.bundles?.includes('dsh-bots'), 'Install and activate dsh-bots with dev:embedded-codex first');
const home = resolve(ROOT, '.tmp', `profile-smoke-${Date.now()}`);
const profileDirectory = resolve(home, 'profiles/desktop'); mkdirSync(profileDirectory, { recursive: true });
for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) if (existsSync(resolve(sourceProfile, name))) copyFileSync(resolve(sourceProfile, name), resolve(profileDirectory, name));
// Plugin realpaths must stay inside this profile so DSH's package resolver can
// supply one Host SDK identity. A junction of the whole node_modules would escape
// that scope and accidentally load a second SDK from an ancestor checkout.
mkdirSync(resolve(profileDirectory, 'node_modules'));
for (const entry of readdirSync(resolve(sourceProfile, 'node_modules'), { withFileTypes: true })) {
  const from = resolve(sourceProfile, 'node_modules', entry.name); const to = resolve(profileDirectory, 'node_modules', entry.name);
  if (entry.name === 'dsh-bots' || entry.name === 'dsh-embedded-codex') cpSync(from, to, { recursive: true });
  else if (entry.isDirectory()) symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir');
  else if (entry.isFile()) copyFileSync(from, to);
}
process.env.DSH_HOME = home; process.env.DSH_TELEMETRY_DISABLED = '1';
const profile = loadProfileDirectory('dsh-bots-smoke', profileDirectory, installAnchor);
assert.equal(profile.skippedBundles.length, 0, JSON.stringify(profile.skippedBundles));
assert(profile.layers.some(layer => layer.packageName === 'dsh-bots'));
const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) }]);
const overlay = resolve(home, 'smoke.patch.yml');
writeFileSync(overlay, '- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n');
console.log('Booting actual installed desktop profile in isolated home:', home);
const app = await runProfile({ environment, profile: 'desktop', resolvedProfile: { profile, installAnchor }, patchFiles: [overlay], args: ['--no-open', '--port', '0'] });
let success = false;
const lifetime = new AbortController(); const signal = lifetime.signal;
let observer: Promise<void> | undefined;
const controller = app.ctx.get('dshBots') as DshBotsController | undefined;
async function until<T>(fn: () => Promise<T>, predicate: (result: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  do { const result = await fn(); if (predicate(result)) return result; await delay(50); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
class FixtureModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  override async listModels(provider: string) { return [{ provider, id: 'fixture', name: 'Bots fixture (offline)' }]; }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: 'Bots fixture (offline)' }; }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Desktop also generates a session title through this adapter. It is a
    // separate utility call, not an Agent turn; inspect the documented source.
    const title = options.messages.some(message => message.source?.kind === 'dsh-session-title-llm');
    if (!title) this.requests.push(options);
    const uiTask = !title && JSON.stringify(options.messages).includes('UI_TASK_WITH_MENTION');
    if (uiTask && !options.messages.some(message => message.role === 'tool' && message.toolCallId === 'ui-smoke-call')) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Checking the requested task.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Checking the requested task.' } };
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('ui-smoke-call'), name: 'bots_ui_echo', arguments: '{}' } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const text = title ? 'Bots integration' : this.requests.length === 1 ? 'Background received exactly once. Task completed.' : 'Native continuation returned to the group.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: text.slice(0, 12) }; await delay(60);
    yield { type: 'text-delta', index: 0, text: text.slice(12) };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
try {
  assert(controller, 'DSH Bots service must be active');
  const boot = await controller.bootstrap({}, signal);
  writeFileSync(resolve(ROOT, '.tmp/profile-smoke-latest.json'), JSON.stringify({ home, profileDirectory, url: app.ctx.connection.authenticatedUrl(`http://127.0.0.1:${app.ctx.webServer.port}`), checks: [] }, null, 2));
  assert(boot.capabilities.contextInjection);
  const workspaceDirectory = resolve(home, 'fixture-workspace'); mkdirSync(workspaceDirectory);
  const workspace = await app.ctx.workspaceRegistry.create(workspaceDirectory, 'Bots integration workspace');
  const fixture = new FixtureModel(); app.ctx.llm.registerAdapter(['bots-fixture'], fixture);
  app.ctx.tools.register(defineContentToolFixture({ name: 'bots_ui_echo', description: 'Offline browser regression fixture', parameters: {}, async execute() { await delay(100); return [{ type: 'text', text: 'UI fixture tool completed.' }]; } }));
  // Assistants adopt an existing native Session, including its runtime/model
  // configuration. Creating the assistant or room must retain this exact ID.
  const nativeSession = await app.ctx.sessionController.create({ workspaceId: workspace.id, agentPreset: 'standard' });
  await app.ctx.sessionController.selectModel({ sessionId: nativeSession.sessionId, provider: 'bots-fixture', model: 'fixture' });
  await app.ctx.sessionController.rename({ sessionId: nativeSession.sessionId, title: 'Existing Session title check' });
  const listedSession = (await controller.bootstrap({}, signal)).sessions.find(session => session.id === nativeSession.sessionId);
  assert.equal(listedSession?.title, 'Existing Session title check');
  assert.equal(listedSession.workspaceId, workspace.id);
  assert(typeof listedSession.updatedAt === 'number' && listedSession.updatedAt > 0);
  const bot = await controller.command({ type: 'bot.create', payload: { name: 'Whale', avatar: 'blue', sessionId: nativeSession.sessionId } }, signal) as unknown as Bot;
  assert.equal(bot.sessionId, nativeSession.sessionId);
  const room = await controller.command({ type: 'room.create', payload: { kind: 'group', title: 'Integration group', botId: bot.id, acknowledgeSharedContext: true } }, signal) as unknown as Room;
  const observedEvents: RoomEvent[] = [];
  observer = (async () => { for await (const event of controller.stream({ roomId: room.id }, signal)) observedEvents.push(event); })();
  void observer.catch(() => {});
  const binding = (await controller.snapshot({ roomId: room.id }, signal)).bindings[0]!;
  assert.equal(binding.sessionId, nativeSession.sessionId);
  assert.equal(binding.workspaceId, workspace.id);
  await controller.command({ type: 'message.send', payload: { clientMessageId: 'smoke-background', roomId: room.id, parts: [{ type: 'text', text: 'The integration marker is BOTS_BACKGROUND_ONCE.' }] } }, signal);
  await until(() => controller.snapshot({ roomId: room.id }, signal), s => s.contexts.some(c => c.status === 'accepted'), 'durable idle context admission');
  const resolved = await app.ctx.sessionController.resolveAgent(SessionId(binding.sessionId)); assert(!('error' in resolved));
  assert.equal(resolved.agent.status, 'idle'); assert.equal(fixture.requests.length, 0);
  await controller.command({ type: 'message.send', payload: { clientMessageId: 'smoke-task', roomId: room.id, parts: [{ type: 'mention', botId: bot.id, label: bot.name }, { type: 'text', text: 'Confirm the background.' }] } }, signal);
  const final = await until(() => controller.snapshot({ roomId: room.id }, signal), s => s.invocations.some(i => i.status === 'completed'), 'task completion and projection');
  assert(final.messages.some(m => m.source === 'assistant' && m.text.includes('Task completed')));
  assert.equal(fixture.requests.length, 1);
  assert.equal(resolved.agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 1);
  assert(observedEvents.some(event => event.type === 'stream.updated' && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && typeof event.payload.text === 'string' && event.payload.text.length > 0), 'Live assistant text must arrive before final projection');
  assert.equal(JSON.stringify(fixture.requests[0]!.messages).split('BOTS_BACKGROUND_ONCE').length - 1, 1);
  assert.equal(final.contexts.find(c => c.content.includes('BOTS_BACKGROUND_ONCE'))?.status, 'consumed');
  await app.ctx.sessionController.prompt({ sessionId: SessionId(binding.sessionId), requestId: 'native-smoke' as Parameters<typeof app.ctx.sessionController.prompt>[0]['requestId'], mode: 'queue', content: [{ type: 'text', text: 'Native desktop continuation' }] }, signal);
  await until(() => controller.snapshot({ roomId: room.id }, signal), s => s.messages.some(m => m.source === 'desktop' && m.text.includes('Native desktop continuation')) && s.messages.some(m => m.text.includes('Native continuation returned')), 'native continuation to room');
  await until(async () => resolved.agent.status, status => status === 'idle', 'native turn settled');
  await controller.command({ type: 'message.send', payload: { clientMessageId: 'smoke-discarded-background', roomId: room.id, parts: [{ type: 'text', text: 'BOTS_DISCARDED_BACKGROUND' }] } }, signal);
  const beforeDiscard = await until(() => controller.snapshot({ roomId: room.id }, signal), s => s.contexts.some(c => c.content.includes('BOTS_DISCARDED_BACKGROUND') && c.status === 'accepted'), 'background before runtime discard');
  const discarded = beforeDiscard.contexts.find(c => c.content.includes('BOTS_DISCARDED_BACKGROUND'))!;
  // Graceful Runtime shutdown can discard an unconsumed inbox entry. Exercise
  // that same durable mutation without stopping the rest of this UI fixture.
  assert(resolved.agent.inbox.remove(discarded.dshMessageId as Parameters<typeof resolved.agent.inbox.remove>[0]));
  assert(await app.ctx.sessions.flush(resolved.agent.session));
  await controller.command({ type: 'message.send', payload: { clientMessageId: 'smoke-after-discard', roomId: room.id, parts: [{ type: 'mention', botId: bot.id, label: bot.name }, { type: 'text', text: 'Use the recoverable background.' }] } }, signal);
  const recovered = await until(() => controller.snapshot({ roomId: room.id }, signal), s => s.invocations.filter(i => i.status === 'completed').length === 2, 'explicit task recovers discarded context');
  assert.equal(JSON.stringify(fixture.requests.at(-1)!.messages).split('BOTS_DISCARDED_BACKGROUND').length - 1, 1);
  assert.equal(recovered.contexts.find(c => c.content.includes('BOTS_DISCARDED_BACKGROUND'))?.status, 'consumed');
  await until(() => controller.bootstrap({}, signal), b => b.capabilities.interactions, 'Gateway interaction bridge');
  const question = app.ctx.userQuestions.ask({ agent: resolved.agent, questions: [{ id: 'choice', question: 'Integration choice', options: [{ label: 'A' }, { label: 'B' }] }], signal });
  void question.catch(() => {});
  const questionState = await until(() => controller.snapshot({ roomId: room.id }, signal), s => s.interactions.some(i => i.status === 'pending' && i.kind === 'question'), 'question projected into room');
  const card = questionState.interactions.find(i => i.status === 'pending' && i.kind === 'question')!;
  await controller.command({ type: 'interaction.answer', payload: { interactionId: card.id, revision: card.revision, answer: { answers: { choice: ['A'] } } } }, signal);
  assert.deepEqual(await question, { answers: [{ id: 'choice', selected: ['A'] }] });
  const updated = await controller.bootstrap({}, signal);
  assert(updated.presets.some(p => p.id === 'embedded-codex'), 'Embedded Codex preset remains installed');
  const nativeCodexSession = await app.ctx.sessionController.create({ workspaceId: workspace.id, agentPreset: 'embedded-codex' });
  const codexBot = await controller.command({ type: 'bot.create', payload: { name: 'Codex whale', avatar: 'teal', sessionId: nativeCodexSession.sessionId } }, signal) as unknown as Bot;
  const codexRoom = await controller.command({ type: 'room.create', payload: { kind: 'group', title: 'Embedded Codex context check', botId: codexBot.id, acknowledgeSharedContext: true } }, signal) as unknown as Room;
  const codexBinding = (await controller.snapshot({ roomId: codexRoom.id }, signal)).bindings[0]!;
  assert.equal(codexBinding.sessionId, nativeCodexSession.sessionId);
  assert.equal(codexBinding.workspaceId, workspace.id);
  await controller.command({ type: 'message.send', payload: { clientMessageId: 'smoke-codex-background', roomId: codexRoom.id, parts: [{ type: 'text', text: 'BOTS_CODEX_IDLE_BACKGROUND' }] } }, signal);
  await until(() => controller.snapshot({ roomId: codexRoom.id }, signal), s => s.contexts.some(c => c.status === 'accepted'), 'Embedded Codex durable idle context admission');
  const codexAgent = await app.ctx.sessionController.resolveAgent(SessionId(codexBinding.sessionId)); assert(!('error' in codexAgent));
  assert.equal(codexAgent.agent.status, 'idle');
  assert.equal(codexAgent.agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length, 0);
  assert.equal((await app.ctx.sessionController.projections({ sessionId: SessionId(codexBinding.sessionId) }, signal))?.values.agentPreset, 'embedded-codex');
  let uiSessionId: string | undefined;
  if (process.argv.includes('--serve')) {
    const uiSession = await app.ctx.sessionController.create({ workspaceId: workspace.id, agentPreset: 'standard' });
    await app.ctx.sessionController.selectModel({ sessionId: uiSession.sessionId, provider: 'bots-fixture', model: 'fixture' });
    await app.ctx.sessionController.rename({ sessionId: uiSession.sessionId, title: '现有会话标题验证' });
    uiSessionId = uiSession.sessionId;
  }
  const web = app.ctx.webServer;
  const baseUrl = `http://127.0.0.1:${web.port}`;
  const info = { home, profileDirectory, roomId: room.id, sessionId: binding.sessionId, ...(uiSessionId ? { uiSessionId } : {}), url: app.ctx.connection.authenticatedUrl(baseUrl), checks: ['real-profile', 'native-session-title', 'existing-session-adoption', 'idle-context', 'one-wakeup', 'context-exactly-once', 'stream-and-final', 'native-bidirectional', 'discarded-context-requeue', 'question-answer-gateway', 'embedded-preset-preserved', 'embedded-codex-idle-context'] };
  writeFileSync(resolve(ROOT, '.tmp/profile-smoke-latest.json'), JSON.stringify(info, null, 2));
  console.log('Real profile smoke passed:', info.checks.join(', '));
  success = true;
  if (process.argv.includes('--serve')) {
    // An optional browser-only fixture exercises a real custom answer end to
    // end. Ordinary test:profile remains unattended and does not need this.
    const browserQuestion = app.ctx.userQuestions.ask({ agent: resolved.agent, questions: [{ id: 'browser-choice', question: 'Browser custom answer check', options: [{ label: 'Preset option' }] }], signal });
    void browserQuestion.then(answer => writeFileSync(resolve(home, 'browser-answer.json'), JSON.stringify(answer, null, 2))).catch(() => {});
    console.log('UI smoke host is ready. Connection details: .tmp/profile-smoke-latest.json');
    const stop = resolve(home, 'stop'); while (!existsSync(stop)) await delay(1000);
  }
} finally { lifetime.abort(); await observer?.catch(() => {}); await app.shutdown.shutdown(success ? 0 : 1); }
