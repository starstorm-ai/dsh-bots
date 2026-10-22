import inputCss from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.module.css'
/** DSH's exported source component, bundled against the pinned SDK. No Session draft is borrowed. */
import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import { DraftEditor } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/editor/DraftEditor.tsx'
import { $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $isTextNode, createEditor } from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'

export interface DraftHandle { focus(): void }
export const NativeDraft = forwardRef<DraftHandle, { value: string; placeholder: string; onChange(text: string, caret: number): void; onError(error: Error): void }>(function NativeDraft({ value, placeholder, onChange, onError }, ref) {
  const callbacks = useRef({ onChange, onError }); callbacks.current = { onChange, onError }
  const editor = useMemo(() => createEditor({ namespace: 'dsh-bots-room', onError: error => callbacks.current.onError(error) }), [])
  const scroll = useRef<HTMLDivElement>(null)
  const last = useRef(value)
  useImperativeHandle(ref, () => ({ focus: () => editor.focus(undefined, { defaultSelection: 'rootEnd' }) }), [editor])
  useLayoutEffect(() => {
    const plain = registerPlainText(editor)
    const history = registerHistory(editor, createEmptyHistoryState(), 300)
    const update = editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has('bots-external')) return
      editorState.read(() => {
        const root = $getRoot(); const text = root.getTextContent()
        const selection = $getSelection(); let caret = text.length
        if ($isRangeSelection(selection)) {
          const prefix = selection.clone(); const start = root.getFirstDescendant()
          if (start) { prefix.anchor.set(start.getKey(), 0, $isTextNode(start) ? 'text' : 'element'); caret = prefix.getTextContent().length }
        }
        last.current = text; callbacks.current.onChange(text, caret)
      })
    })
    return () => { update(); history(); plain() }
  }, [editor])
  useLayoutEffect(() => {
    if (value === last.current && editor.getEditorState().read(() => $getRoot().getTextContent()) === value) return
    last.current = value
    editor.update(() => {
      const root = $getRoot(); root.clear()
      const paragraph = $createParagraphNode()
      value.split('\n').forEach((line, index) => { if (index) paragraph.append($createLineBreakNode()); if (line) paragraph.append($createTextNode(line)) })
      root.append(paragraph)
      if (editor.getRootElement()?.contains(document.activeElement)) paragraph.selectEnd()
    }, { tag: 'bots-external', discrete: true })
  }, [editor, value])
  return <DraftEditor classNames={{ scroll: inputCss.scroll, grow: inputCss.grow, input: inputCss.input, placeholder: inputCss.placeholder }} editor={editor} scrollRef={scroll} editable editorDisabled={false} phase="plain" placeholderText={placeholder} ariaLabel={placeholder} workspaceTrigger={false} workspacePickerOpen={false} onWorkspaceKeyDown={() => {}} hint={null} showPlaceholder={!value} />
})
