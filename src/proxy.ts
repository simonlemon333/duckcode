/**
 * Proxy support — route fetch() calls through HTTP/HTTPS proxy, respecting NO_PROXY.
 *
 * Priority for proxy URL: --proxy flag > HTTPS_PROXY > HTTP_PROXY
 * NO_PROXY is always honored — comma-separated list of hosts/suffixes/CIDR-prefixes
 * that bypass the proxy (e.g. "localhost,127.0.0.1,172.31.,.internal").
 *
 * Uses undici's EnvHttpProxyAgent which natively understands NO_PROXY.
 * Must be called before any fetch() calls.
 */

export async function setupProxy(proxyUrl?: string): Promise<string | null> {
  // If user passed --proxy explicitly, set it as HTTPS_PROXY so EnvHttpProxyAgent picks it up
  if (proxyUrl) {
    process.env.HTTPS_PROXY = proxyUrl
    process.env.HTTP_PROXY = proxyUrl
  }

  const url = process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy

  if (!url) return null

  try {
    // @ts-ignore — undici may lack types in some setups
    const undici = await import('undici') as any
    // EnvHttpProxyAgent reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY automatically
    // and bypasses the proxy for hosts matching NO_PROXY
    if (undici.EnvHttpProxyAgent) {
      undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent())
    } else {
      // Fallback to plain ProxyAgent (older undici, no NO_PROXY support)
      undici.setGlobalDispatcher(new undici.ProxyAgent(url))
    }
    return url
  } catch {
    console.warn(`⚠ Proxy configured (${url}) but undici not available. Proxy may not work.`)
    return url
  }
}
