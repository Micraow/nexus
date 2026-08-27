import type { Message } from '@/types/domain'

export const FULLSCREEN_MESSAGE_PAGE_SIZE = 20

export function messagePageCount(messages: readonly Message[], pageSize = FULLSCREEN_MESSAGE_PAGE_SIZE): number {
  const normalizedSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : FULLSCREEN_MESSAGE_PAGE_SIZE
  return Math.max(1, Math.ceil(messages.length / normalizedSize))
}

export function paginateMessages(messages: readonly Message[], page: number, pageSize = FULLSCREEN_MESSAGE_PAGE_SIZE): Message[] {
  const normalizedSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : FULLSCREEN_MESSAGE_PAGE_SIZE
  const lastPage = messagePageCount(messages, normalizedSize) - 1
  const normalizedPage = Number.isInteger(page) ? Math.min(lastPage, Math.max(0, page)) : 0
  return messages.slice(normalizedPage * normalizedSize, (normalizedPage + 1) * normalizedSize)
}
