type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

interface TauriInternals {
  invoke?: TauriInvoke
}

function internals(): TauriInternals | null {
  if (typeof window === 'undefined') return null
  return ((window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? null)
}

export function isTauriRuntime(): boolean {
  return typeof internals()?.invoke === 'function'
}

export async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = internals()?.invoke
  if (!invoke) throw new Error('当前不是 Tauri 桌面运行时')
  return await invoke(command, args) as T
}
