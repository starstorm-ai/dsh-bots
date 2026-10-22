import type { ComponentProps, ReactNode } from 'react'
import { ConversationSessionHeader } from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationSession.tsx'
import css from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.module.css'
import type { NativeTranslate } from './NativeTranscript.tsx'

export type BotsTab = 'chats' | 'assistants'
export interface HeaderTab { id: BotsTab; label: string }

/** Read-only header projection. These selectors never open or mutate a DSH Session. */
export function NativeHeader({ title, tabs, selected, select, corner, t }: {
  title: string; tabs: HeaderTab[]; selected: BotsTab; select(tab: BotsTab): void; corner?: ReactNode; t: NativeTranslate
}): ReactNode {
  const props = {
    sessionId: 'bots-header', hideChrome: false,
    useSessions: (selector: (state: unknown) => unknown) => selector({ byId: { 'bots-header': { id: 'bots-header', displayTitle: title, origin: 'user' } } }),
    useConversationViews: (selector: (value: HeaderTab[]) => unknown) => selector(tabs),
    useStore: (selector: (value: { view: string }) => unknown) => selector({ view: selected }),
    selectView: (value: BotsTab) => select(value), open: () => {}, t,
    renderSlot: (name: string) => name === 'conversation.session.header.corner' ? corner : null,
  }
  return <header className={css.header} data-native-dsh data-window-drag data-bots-header>
    <ConversationSessionHeader {...props as unknown as ComponentProps<typeof ConversationSessionHeader>} />
  </header>
}
