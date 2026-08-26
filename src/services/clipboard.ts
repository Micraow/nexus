import { writeText as writeTauriText } from '@tauri-apps/plugin-clipboard-manager'
import { invokeTauri, isTauriRuntime } from '@/services/tauri'

/**
 * Write text without claiming success until one of the available clipboard
 * backends has accepted it. Linux desktop sessions often expose both a
 * browser clipboard and a native Wayland clipboard, so each backend is kept
 * independent and failures are allowed to fall through.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (isTauriRuntime()) {
    // The native helper is especially useful on Wayland, where WebKit's
    // navigator.clipboard may be unavailable and arboard can report success
    // before a compositor has taken ownership of the selection.
    try {
      if (await invokeTauri<boolean>('system_copy_text', { text: value })) return true
    } catch {
      // Older installations do not have the helper command yet; continue with
      // the plugin and browser fallbacks below.
    }

    try {
      await writeTauriText(value)
      return true
    } catch {
      // Continue to WebKit/browser fallbacks.
    }
  }

  if (await writeWithBrowserApi(value)) return true
  return writeWithSelection(value)
}

async function writeWithBrowserApi(value: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard || typeof clipboard.writeText !== 'function') return false
    await clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

/** Legacy copy path for WebKit builds without a Clipboard API permission. */
function writeWithSelection(value: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  Object.assign(textarea.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  })

  const active = document.activeElement as HTMLElement | null
  const selection = window.getSelection()
  const ranges: Range[] = []
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) ranges.push(selection.getRangeAt(index))
  }

  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, value.length)
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  textarea.remove()

  // Do not leave the user's selection or focus in the temporary element.
  if (selection) {
    selection.removeAllRanges()
    ranges.forEach((range) => selection.addRange(range))
  }
  active?.focus({ preventScroll: true })
  return copied
}
