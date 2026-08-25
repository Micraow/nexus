// Shared contracts between the export workbench and the DeepSeek adapter.

export interface ExportedMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
}

export interface ExportedConversation {
  external_session_id: string
  title: string
  model?: string
  created_at?: string
  messages: ExportedMessage[]
}

export interface ExportPayload {
  schema_version: 1
  platform: 'deepseek'
  exported_at: string
  conversations: ExportedConversation[]
  errors: ExportError[]
}

export interface ExportError {
  external_session_id: string
  title: string
  error: string
}

export interface SessionEntry {
  externalSessionId: string
  title: string
}

export type WorkbenchRequest =
  | { type: 'PING' }
  | { type: 'SOURCE_STATUS' }
  | { type: 'LIST_VISIBLE' }
  | { type: 'LIST_SCROLL_STEP' }
  | { type: 'CURRENT_SESSION_ID' }
  | { type: 'EXPORT_SESSION'; externalSessionId: string | null }

export type WorkbenchResponse =
  | { ok: true; kind: 'list'; sessions?: SessionEntry[]; progress?: ListProgress }
  | { ok: true; kind: 'current'; currentSessionId?: string | null }
  | { ok: true; kind: 'conversation'; conversation?: ExportedConversation }
  | { ok: false; error: string }

export interface ListProgress {
  discovered: number
  reachedEnd: boolean
  attempts: number
}
