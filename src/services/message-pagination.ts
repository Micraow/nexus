import type { Message } from '@/types/domain'

export const FULLSCREEN_MESSAGE_PAGE_SIZE = 20

/**
 * A full-screen page is a complete Session transcript. The old fixed-size
 * pagination split long conversations in the middle, which made the viewer
 * lose the conversational boundary users rely on when moving between pages.
 */
export interface MessageSessionPage {
  sessionId: string
  messages: Message[]
}

export function messageSessionPages(messages: readonly Message[]): MessageSessionPage[] {
  const pages = new Map<string, MessageSessionPage>()
  const order: string[] = []
  messages.forEach((message) => {
    let page = pages.get(message.sessionId)
    if (!page) {
      page = { sessionId: message.sessionId, messages: [] }
      pages.set(message.sessionId, page)
      order.push(message.sessionId)
    }
    page.messages.push(message)
  })
  return order.map((sessionId) => {
    const page = pages.get(sessionId)!
    page.messages.sort((left, right) => left.orderInSession - right.orderInSession || left.id.localeCompare(right.id))
    return page
  })
}

/**
 * Kept as a small compatibility wrapper for callers that only need the page
 * count. `pageSize` is intentionally ignored; Session boundaries are the
 * pagination contract now.
 */
export function messagePageCount(messages: readonly Message[], _pageSize = FULLSCREEN_MESSAGE_PAGE_SIZE): number {
  return Math.max(1, messageSessionPages(messages).length)
}

export function paginateMessages(messages: readonly Message[], page: number, _pageSize = FULLSCREEN_MESSAGE_PAGE_SIZE): Message[] {
  const pages = messageSessionPages(messages)
  const lastPage = pages.length - 1
  const normalizedPage = Number.isInteger(page) ? Math.min(lastPage, Math.max(0, page)) : 0
  return pages[normalizedPage]?.messages ?? []
}
