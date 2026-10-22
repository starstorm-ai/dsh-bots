import { useMemo, type ReactNode } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './locales.ts'

/** Use the same safe GFM/math and incremental renderer as native DSH messages. */
export function Markdown({ text, t, streaming = false }: { text: string; t: Translate; streaming?: boolean }): ReactNode {
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: { codeLabel: t('markdownCode'), wrapLabel: t('markdownWrap'), unwrapLabel: t('markdownUnwrap') } },
    footnotes: t('markdownFootnotes'),
  }), [t])
  // No local-file opener is installed here: chat participants cannot turn
  // authored paths into access to the desktop filesystem.
  return <div className="bots-markdown"><MarkdownText text={text} streaming={streaming} labels={labels} /></div>
}
