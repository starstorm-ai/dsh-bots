import { describe, expect, it } from 'vitest';
import { COMMAND_SCHEMA, COMMAND_TYPES, parseCommand } from '../packages/protocol/src/index.ts';
import fixture from '../packages/protocol/fixtures/round-trip.json' with { type: 'json' };

describe('wire command schema', () => {
  it('covers every public command type exactly once', () => {
    expect(COMMAND_SCHEMA.allOf.map(branch => branch.if.properties.type.const).sort()).toEqual([...COMMAND_TYPES].sort());
    expect(COMMAND_SCHEMA.properties.type.enum).toEqual(COMMAND_TYPES);
  });
  it('round-trips Unicode, Markdown and safe integer cursors without changing content', () => {
    for (const command of fixture.commands) expect(parseCommand(JSON.parse(JSON.stringify(command)))).toEqual(command);
    expect(JSON.parse(JSON.stringify(fixture.events))).toEqual(fixture.events);
  });
  it.each([
    { type: 'message.send', payload: { clientMessageId: 'x', roomId: 'y', parts: [null] } },
    { type: 'message.send', payload: { clientMessageId: 'x', roomId: 'y', parts: [{ type: 'text', text: 'Hi', sessionId: '/arbitrary' }] } },
    { type: 'message.send', payload: { clientMessageId: 'x', roomId: 'y', parts: [{ type: 'text', text: 'Hi' }], personId: 'owner' } },
    { type: 'sync.ack', payload: { roomId: 'y', seq: 9007199254740992 } },
    { type: 'sync.ack', payload: { roomId: 'y', seq: -1 } },
    { type: 'bot.update', payload: { botId: 'x', enabled: 'false' } },
    { type: 'bot.delete', payload: {} },
    { type: 'bot.delete', payload: { botId: 'x', deleteSession: true } },
    { type: 'bot.create', payload: { name: 'Whale' } },
    { type: 'bot.create', payload: { name: 'Whale', defaultWorkspaceId: 'ws' } },
    { type: 'bot.create', payload: { name: 'Whale', sessionId: 'session', defaultPresetId: 'preset' } },
    { type: 'interaction.answer', payload: { interactionId: 'x', revision: 1 } },
    { type: 'workspace.grant.update', payload: { workspaceId: 'x' } },
    { type: 'room.create', payload: { kind: 'secret', title: 'x' } },
  ])('rejects invalid or authority-forging payload %#', command => { expect(() => parseCommand(command)).toThrow(); });
  it('rejects incompatible versions and unsupported commands', () => {
    expect(() => parseCommand({ version: 2, type: 'person.update', payload: { displayName: 'A' } })).toThrow(/major/);
    expect(() => parseCommand({ type: 'shell.execute', payload: { command: 'whoami' } })).toThrow(/Unknown command/);
  });
  it('accepts an existing Session as the assistant execution target', () => {
    const command = { type: 'bot.create', payload: { name: 'Whale', avatar: 'blue', sessionId: 'existing-session' } };
    expect(parseCommand(command)).toEqual(command);
  });
});
