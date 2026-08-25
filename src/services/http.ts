import { fetch as pluginFetch } from '@tauri-apps/plugin-http'
import { isTauriRuntime } from '@/services/tauri'

export type HttpRequestInit = RequestInit & { body?: BodyInit | null }

/**
 * Perform HTTP requests through the Tauri http plugin inside the desktop app
 * so user-configured OpenAI-compatible endpoints are reachable despite webview
 * CORS. Browser dev builds fall back to regular fetch.
 */
export function httpRequest(url: string, init: HttpRequestInit = {}): Promise<Response> {
  if (isTauriRuntime()) return pluginFetch(url, init) as Promise<Response>
  return fetch(url, init)
}
