/**
 * T2-3 测试基建：全局 fetch 注入 studio token。
 *
 * 服务端 GET /api/* 读端点已要求 token（T2-3）——存量测试大量直接 `fetch(url)` 打
 * GET 端点无凭据，逐个补头改动面巨大。这里在 vitest setup 阶段统一包装 globalThis.fetch：
 * 对 GET /api/*（boot 豁免端点除外）自动按 origin 缓存取 /api/boot 的 token 并注入
 * x-studio-token 头（已有该头或 query token 的请求不动）。显式测 token 闸本身的用例
 * （api-token.test.ts）走 node:http 原生请求，不受本包装影响。
 */
;(() => {
  const origFetch = globalThis.fetch.bind(globalThis)
  /** origin → token（空串 = boot 未返回 token，短路不再重复探） */
  const tokenCache = new Map<string, string>()

  const resolveUrl = (input: RequestInfo | URL): URL | null => {
    try {
      return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    } catch {
      return null // 相对路径等非绝对 URL：与本包装无关，原样放行
    }
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = resolveUrl(input)
    const shouldInject =
      u !== null &&
      u.pathname.startsWith('/api/') &&
      u.pathname !== '/api/boot' &&
      !u.searchParams.has('token') && // SSE 等 query 凭据通道：不动
      (init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method) ?? 'GET').toUpperCase() === 'GET'
    if (!shouldInject) return origFetch(input as RequestInfo, init)

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (headers.has('x-studio-token')) return origFetch(input as RequestInfo, init)
    let token = tokenCache.get(u.origin)
    if (token === undefined) {
      const r = await origFetch(`${u.origin}/api/boot`)
      const d = r.ok ? ((await r.json()) as { token?: string }) : null
      token = typeof d?.token === 'string' ? d.token : ''
      tokenCache.set(u.origin, token)
    }
    if (!token) return origFetch(input as RequestInfo, init)
    headers.set('x-studio-token', token)
    const resp = await origFetch(input as RequestInfo, { ...init, headers })
    // 端口复用换 server（token 代际不同）→ 403：清缓存重试一次
    if (resp.status === 403) {
      tokenCache.delete(u.origin)
      const r = await origFetch(`${u.origin}/api/boot`)
      const d = r.ok ? ((await r.json()) as { token?: string }) : null
      if (typeof d?.token === 'string' && d.token !== token) {
        tokenCache.set(u.origin, d.token)
        const h2 = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        h2.set('x-studio-token', d.token)
        return origFetch(input as RequestInfo, { ...init, headers: h2 })
      }
    }
    return resp
  }) as typeof fetch
})()
