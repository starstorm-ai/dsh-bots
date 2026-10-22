import { useState, type ComponentProps, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { AssistantMarkdown } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx'
import { UserMessageNodeView } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/MessageItem.tsx'
import { TurnProcessNodeView } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/TurnProcessNodeView.tsx'
import { ChatGroupSeat } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/ChatGroupSeat.tsx'
import { MessageIconActions } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/MessageIconActions.tsx'
import { RunningStatus } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/RunningStatus.tsx'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { presentationPolicyFor } from '@deepseek-ai/dsh-client-ui-chat/src/client/presentation-policy.ts'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import assistantCss from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/AssistantMarkdown.module.css'
import flowCss from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/ChatView.module.css'
import type { Message } from '../../protocol/src/index.ts'
import { activeStatuses, turnContent, type AssistantTurn } from './transcript.ts'

export type NativeTranslate = (key: string, params?: Record<string, unknown>) => string
const policy = presentationPolicyFor('standard')
const usePresentation = <T,>(selector: (value: typeof policy) => T): T => selector(policy)
const noOp = (): void => {}
const noImages = (): ReactNode => null

/** The room store owns updates. Native components receive read-only render
 * snapshots, not access to a raw Session controller or filesystem operations. */
export function NativeMarkdown({ text, streaming = false, t }: { text: string; streaming?: boolean; t: NativeTranslate }): ReactNode {
  return <AssistantMarkdown blocks={[{ kind: 'text', text }]} streaming={streaming} useDisclosure={useDisclosure} usePresentation={usePresentation} renderMessageImages={noImages} t={t} />
}

export function NativeUserMessage({ message, t }: { message: Message; t: NativeTranslate }): ReactNode {
  const text = message.parts.map(part => part.type === 'mention' ? `@${part.label} ` : part.text).join('') || message.text
  const props = { node: { data: { content: [{ type: 'text', text }], time: Date.parse(message.createdAt) } }, renderMessageImages: noImages, openFile: noOp, openSkill: noOp, t }
  return <UserMessageNodeView {...props as unknown as ComponentProps<typeof UserMessageNodeView>} />
}

function NativeBody({ message, t }: { message: Message; t: NativeTranslate }): ReactNode {
  const [open, setOpen] = useState(false)
  const tool = message.blocks?.find(block => block.type === 'tool')
  return <div data-message-id={message.id}>
    {message.source === 'tool'
      ? <DisclosureRow icon={<span aria-hidden>◇</span>} title={message.toolName ?? tool?.name ?? 'Tool'} open={open} expandable expandOnRowClick onToggle={() => setOpen(!open)} running={tool?.status === 'running'}><NativeMarkdown text={tool?.summary || message.text} t={t} /></DisclosureRow>
      : <NativeMarkdown text={message.text} t={t} />}
    {message.blocks?.filter(block => block.type === 'attachment').map((block, index) => <div className="bots-attachment" key={index}>{block.name}</div>)}
  </div>
}

function turnLocation(group: AssistantTurn) {
  const start = group.turn?.startedAt ?? group.task?.createdAt
  const end = group.turn?.endedAt ?? group.task?.updatedAt
  const reason = group.status === 'cancelled' || group.status === 'interrupted' ? 'aborted' : group.status === 'failed' || group.status === 'recovery_required' ? 'error' : 'completed'
  return { turn: group.turn?.number ?? Math.floor(group.seq), status: activeStatuses.has(group.status) ? 'open' : 'closed',
    ...(start ? { start: { time: Date.parse(start) } } : {}),
    ...(!activeStatuses.has(group.status) ? { end: { ...(end ? { time: Date.parse(end) } : {}), data: { reason: { kind: reason } } } } : {}) }
}

/** Reuse the actual DSH process group: same labels, disclosure, scroll and spacing. */
function NativeProcess({ group, messages, t }: { group: AssistantTurn; messages: Message[]; t: NativeTranslate }): ReactNode {
  const location = { kind: 'turn', turn: turnLocation(group) }
  const nodes = new Map(messages.map(message => [message.id, { key: message.id, kind: 'assistant-step', anchorSeq: message.sourceSeq ?? message.seq, data: { message }, location }]))
  const closed = !activeStatuses.has(group.status)
  const tools = messages.filter(message => message.source === 'tool')
  const snapshot = { members: messages.map(message => ({ kind: 'node', key: message.id })), data: { turn: location.turn.turn, closed, summary: { counts: tools.length ? [{ kind: 'tools', count: tools.length }] : [], running: tools.some(message => message.blocks?.some(block => block.type === 'tool' && block.status === 'running')) ? 'tools' : undefined, runningDetail: '' } } }
  const props = {
    groupKey: `${group.id}/process`, nodeStore: nodes,
    useChatGroup: (_key: string, selector: (value: typeof snapshot) => unknown) => selector(snapshot),
    useChatNode: (key: string, selector?: (value: ReturnType<typeof nodes.get>) => unknown) => selector ? selector(nodes.get(key)) : nodes.get(key),
    useChatNodeProcess: () => undefined,
    useStore: (selector: (value: { turnProcesses: never[] }) => unknown) => selector({ turnProcesses: [] }),
    usePresentation, actions: { setTurnProcessOpen: noOp },
    openFile: noOp, openSkill: noOp, forkAt: noOp, loadImage: noOp, renderMessageImages: noImages,
    renderSlot: (_name: string, owner: { node: { data: { message: Message } } }) => <NativeBody message={owner.node.data.message} t={t} />,
    t,
  }
  return <ChatGroupSeat {...props as unknown as ComponentProps<typeof ChatGroupSeat>} />
}

export function NativeAssistantTurn({ group, t, children }: { group: AssistantTurn; t: NativeTranslate; children?: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false)
  const { process, answer } = turnContent(group)
  const running = activeStatuses.has(group.status)
  const alwaysOpen = running || group.status !== 'completed'
  const location = turnLocation(group)
  const spec = { turn: location.turn, controlAnchorSeq: Math.floor(group.seq), processStartSeq: Math.floor(group.seq), answerAnchorSeq: answer?.sourceSeq ?? null, answerStep: null, inlineReasoning: false, messageCount: process.filter(message => message.source !== 'tool').length, toolCallCount: process.filter(message => message.source === 'tool').length, subagentCount: 0 }
  const control = { node: { kind: 'turn-process', location: { kind: 'turn', turn: location }, data: spec }, turnProcess: { spec, foldable: true, hasContent: process.length > 0, open, setOpen }, t }
  return <div className={`${flowCss.column} bots-native-turn`} data-native-dsh data-bots-turn={group.id} data-turn-status={group.status}>
    {!running && <div className={flowCss.flowItem} data-chat-flow-kind="turn-process"><TurnProcessNodeView {...control as unknown as ComponentProps<typeof TurnProcessNodeView>} /></div>}
    {process.length > 0 && <div hidden={!alwaysOpen && !open} data-bots-turn-process><NativeProcess group={group} messages={process} t={t} /></div>}
    {answer && <div className={flowCss.flowItem} data-chat-group-part="response" data-turn-process-answer><NativeBody message={answer} t={t} /><MessageIconActions text={answer.text} time={Date.parse(answer.createdAt)} clock="end" className={assistantCss.actions} t={t} /></div>}
    {group.streams.map(stream => <div key={stream.messageId} data-chat-group-part="response"><NativeMarkdown text={stream.text} streaming t={t} /></div>)}
    {running && <RunningStatus startTime={location.start?.time} t={t} />}
    {children}
  </div>
}
