import { describe, expect, it } from 'vitest'
import { buildExportPayload, exportPayloadDataUrl, type ExportSessionState } from '../extension/src/export-payload'

const conversation = (id: string) => ({
  external_session_id: id,
  title: `会话 ${id}`,
  messages: [{ role: 'user' as const, content: '你好' }],
})

describe('DeepSeek export payload', () => {
  it('keeps successful conversations and records selected failures', () => {
    const sessions = new Map<string, ExportSessionState>([
      ['ok', { entry: { externalSessionId: 'ok', title: '成功' }, status: 'success', conversation: conversation('ok') }],
      ['bad', { entry: { externalSessionId: 'bad', title: '失败' }, status: 'failed', error: '读取超时' }],
      ['pending', { entry: { externalSessionId: 'pending', title: '未读取' }, status: 'pending' }],
    ])
    expect(buildExportPayload(['ok', 'bad', 'pending'], sessions, '2026-01-01T00:00:00.000Z')).toEqual({
      schema_version: 1,
      platform: 'deepseek',
      exported_at: '2026-01-01T00:00:00.000Z',
      conversations: [conversation('ok')],
      errors: [{ external_session_id: 'bad', title: '失败', error: '读取超时' }],
    })
  })

  it('allows an errors-only payload so failed reads can be diagnosed', () => {
    const sessions = new Map<string, ExportSessionState>([
      ['bad', { entry: { externalSessionId: 'bad', title: '失败' }, status: 'failed' }],
    ])
    const payload = buildExportPayload(['bad'], sessions, '2026-01-01T00:00:00.000Z')
    expect(payload.conversations).toHaveLength(0)
    expect(payload.errors).toEqual([{ external_session_id: 'bad', title: '失败', error: '未知原因' }])
  })

  it('encodes JSON content for the downloads API', () => {
    const content = JSON.stringify({ ok: true, text: '中文' })
    expect(decodeURIComponent(exportPayloadDataUrl(content).split(',', 2)[1])).toBe(content)
  })
})
