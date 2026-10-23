import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { conversationEntries, turnContent } from '../packages/desktop-ui/src/transcript.ts'
import type { RoomSnapshot } from '../packages/protocol/src/index.ts'
const cases = JSON.parse(readFileSync(new URL('../apps/ios/Tests/DSHBotsCoreTests/Fixtures/transcript.json', import.meta.url), 'utf8')) as { name: string; room: RoomSnapshot; expected: unknown }[]
describe('iOS / desktop shared transcript contract', () => {
  for (const fixture of cases) it(fixture.name, () => {
    const actual = conversationEntries(fixture.room).map(entry => entry.kind === 'message'
      ? { id: entry.id, kind: 'message', text: entry.message.parts.map(p => p.type === 'mention' ? `@${p.label} ` : p.text).join('') || entry.message.text }
      : { id: entry.id, kind: 'turn', status: entry.status, process: turnContent(entry).process.map(m => m.id), answer: turnContent(entry).answer?.id ?? null, streams: entry.streams.map(s => s.messageId) })
    expect(actual).toEqual(fixture.expected)
  })
})
