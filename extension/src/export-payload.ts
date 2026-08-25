import type { ExportedConversation, ExportPayload, SessionEntry } from './types'

export type ExportSessionStatus = 'pending' | 'running' | 'success' | 'failed'

export interface ExportSessionState {
  entry: SessionEntry
  status: ExportSessionStatus
  error?: string
  conversation?: ExportedConversation
}

export function buildExportPayload(
  selectedIds: Iterable<string>,
  sessions: ReadonlyMap<string, ExportSessionState>,
  exportedAt = new Date().toISOString(),
): ExportPayload {
  const conversations: ExportedConversation[] = []
  const errors: ExportPayload['errors'] = []
  for (const id of selectedIds) {
    const item = sessions.get(id)
    if (!item) continue
    if (item.conversation) {
      conversations.push(item.conversation)
    } else if (item.status === 'failed') {
      errors.push({ external_session_id: id, title: item.entry.title, error: item.error ?? '未知原因' })
    }
  }
  return {
    schema_version: 1,
    platform: 'deepseek',
    exported_at: exportedAt,
    conversations,
    errors,
  }
}

export function exportPayloadDataUrl(content: string): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(content)}`
}
