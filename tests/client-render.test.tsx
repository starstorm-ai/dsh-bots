import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AVATAR_PALETTE, WhaleAvatar } from '../packages/desktop-ui/src/Avatar.tsx'
import { Markdown } from '../packages/desktop-ui/src/markdown.tsx'
import { Field } from '../packages/desktop-ui/src/components.tsx'
import { en, zh, translate } from '../packages/desktop-ui/src/locales.ts'

const renderer = vi.hoisted(() => ({ props: undefined as undefined | Record<string, unknown> }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ MarkdownText: (props: { text: string }) => { renderer.props = props; return <div>{props.text}</div> } }))

describe('desktop content rendering', () => {
  it('delegates intact Markdown and streaming state to the native safe renderer with localized chrome', () => {
    const text = '| GFM | table |\n| --- | --- |\n| *one* | **two** |'
    renderToStaticMarkup(<Markdown text={text} streaming t={translate('zh')} />)
    expect(renderer.props).toMatchObject({ text, streaming: true, labels: { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' } })
    expect(renderer.props).not.toHaveProperty('fileMentions')
    expect(renderer.props).not.toHaveProperty('pathImages')
  })
  it('names select fields from the label alone and describes help separately', () => {
    const html = renderToStaticMarkup(<Field label="Assistant" hint="Choose one"><select><option>Whale</option></select></Field>)
    const label = /<span id="([^"]+)">Assistant<\/span>/.exec(html)?.[1]
    const hint = /<small id="([^"]+)">Choose one<\/small>/.exec(html)?.[1]
    expect(label).toBeDefined(); expect(hint).toBeDefined()
    expect(html).toContain(`aria-labelledby="${label}"`); expect(html).toContain(`aria-describedby="${hint}"`)
  })
  it('selects every supplied whale color in a circular viewport without stretching the artwork', () => {
    const variants = Object.values(AVATAR_PALETTE).map(color => renderToStaticMarkup(<WhaleAvatar color={color} size={42} label="Research assistant" />))
    const sourceCrops = variants.map(html => [...html.matchAll(/viewBox="([^"]+)"/g)][1]?.[1])
    expect(new Set(sourceCrops).size).toBe(6)
    for (const html of variants) {
      expect(html).toContain('width="42" height="42"')
      expect(html).toContain('viewBox="0 0 512 512"')
      expect(html).toContain('<image'); expect(html).toContain('width="1536" height="1024"')
      expect(html).toContain('preserveAspectRatio="xMidYMid meet"')
      expect(html).toContain('<circle cx="256" cy="256" r="256"')
      expect(html).not.toContain('<rect'); expect(html).not.toContain('preserveAspectRatio="none"')
      expect(html).toContain('aria-label="Research assistant"')
    }
    // The first whale's tail extends beyond the nominal 512px grid cell.
    const first = sourceCrops[0]!.split(' ').map(Number)
    expect(first[0]! + first[2]!).toBeGreaterThan(524)
  })
  it('maintains a complete Chinese dictionary', () => { expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort()); expect(zh.noMention).toContain('上下文') })
})
