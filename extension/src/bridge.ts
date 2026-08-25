// Runs in the MAIN world before page scripts. It wraps fetch and XHR so every
// JSON response is mirrored to content scripts through a CustomEvent. This
// keeps message extraction resilient to DeepSeek DOM/CSS changes while never
// modifying what the page receives.
(() => {
  const EVENT_NAME = 'nexus:captured-json'
  if ((window as unknown as { __nexusBridgeReady?: boolean }).__nexusBridgeReady) return
  ;(window as unknown as { __nexusBridgeReady?: boolean }).__nexusBridgeReady = true

  const dispatch = (body: string, url: string): void => {
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { body, url } }))
    } catch {
      // Cloning must never break the original request pipeline.
    }
  }

  const looksLikeJson = (contentType: string | null | undefined, body: string): boolean =>
    !!contentType && contentType.includes('json') || (!!body && (body.startsWith('{') || body.startsWith('[')))

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await originalFetch(...args)
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0])
      const parsedUrl = new URL(url, window.location.href)
      if (parsedUrl.origin === window.location.origin) {
        const cloned = response.clone()
        void cloned.text().then((body) => {
          if (looksLikeJson(cloned.headers.get('content-type'), body)) dispatch(body, url)
        })
      }
    } catch {
      // Never surface capture errors to the page.
    }
    return response
  }

  type XhrLike = XMLHttpRequest & { __nexusUrl?: string }
  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function open(this: XhrLike, method: string, url: string | URL, ...rest: unknown[]) {
    this.__nexusUrl = String(url)
    return (originalOpen as (...openArgs: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open

  const originalSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function send(this: XhrLike, ...sendArgs: unknown[]) {
    this.addEventListener('load', () => {
      try {
        const url = this.__nexusUrl ?? ''
        const parsedUrl = new URL(url, window.location.href)
        if (parsedUrl.origin !== window.location.origin) return
        const contentType = this.getResponseHeader('content-type')
        const body = typeof this.responseText === 'string' ? this.responseText : ''
        if (looksLikeJson(contentType, body)) dispatch(body, url)
      } catch {
        // Ignore capture failures.
      }
    })
    return (originalSend as (...sendArgs: unknown[]) => void).apply(this, sendArgs)
  } as typeof XMLHttpRequest.prototype.send
})()
