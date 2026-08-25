import { isTauriRuntime } from '@/services/tauri'

export interface SaveFileRequest {
  filename: string
  content: string
  /** 文件选择器中的类型过滤描述与扩展名，浏览器回退时仅用于决定 MIME。 */
  kind?: 'json' | 'yaml' | 'markdown' | 'text'
}

const mimeByKind: Record<NonNullable<SaveFileRequest['kind']>, string> = {
  json: 'application/json',
  yaml: 'text/yaml;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  text: 'text/plain',
}

const filterNameByKind: Record<NonNullable<SaveFileRequest['kind']>, { name: string; extensions: string[] }> = {
  json: { name: 'JSON', extensions: ['json'] },
  yaml: { name: 'YAML', extensions: ['yaml', 'yml'] },
  markdown: { name: 'Markdown', extensions: ['md', 'markdown'] },
  text: { name: '文本', extensions: ['txt'] },
}

function downloadInBrowser(request: SaveFileRequest): void {
  const blob = new Blob([request.content], { type: mimeByKind[request.kind ?? 'text'] })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = request.filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * 把导出内容写到用户选择的文件。桌面端弹出系统保存对话框；
 * 浏览器运行时（开发/验收）退回为触发下载。用户取消返回 false。
 */
export async function saveTextFile(request: SaveFileRequest): Promise<boolean> {
  if (!isTauriRuntime()) {
    downloadInBrowser(request)
    return true
  }
  const [{ save }, { writeTextFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')])
  const target = await save({
    defaultPath: request.filename,
    filters: [filterNameByKind[request.kind ?? 'text']],
  })
  if (!target) return false
  await writeTextFile(target, request.content)
  return true
}
