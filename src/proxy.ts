/**
 * Proxy support — route all fetch() calls through HTTP/HTTPS proxy.
 *
 * Priority: --proxy flag > HTTPS_PROXY > HTTP_PROXY > no proxy
 *
 * Uses Node 20+ built-in undici ProxyAgent to patch global fetch dispatcher.
 * Must be called before any fetch() calls.
 */

export async function setupProxy(proxyUrl?: string): Promise<string | null> {
  const url = proxyUrl
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy

  if (!url) return null

  try {
    // Node 20+ ships undici as internal module
    // @ts-ignore — undici types may not be available, but runtime import works
    const { ProxyAgent, setGlobalDispatcher } = await import('undici') as any
    const agent = new ProxyAgent(url)
    setGlobalDispatcher(agent)
    return url
  } catch {
    // Fallback: if undici not available, just log warning
    console.warn(`⚠ Proxy configured (${url}) but undici not available. Proxy may not work.`)
    return url
  }
}
