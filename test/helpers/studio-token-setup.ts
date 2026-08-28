/**
 * T2-3 测试基建：全局 fetch 注入 studio token。
 *
 * 服务端 GET /api/* 读端点已要求 token（T2-3）——存量测试大量直接 `fetch(url)` 打
 * GET 端点无凭据，逐个补头改动面巨大。这里在 vitest setup 阶段统一包装 globalThis.fetch：
 * 对 GET /api/*（服务端 token 豁免路径表除外，见下方 GET_TOKEN_EXEMPT）自动按 origin
 * 缓存取 /api/boot 的 token 并注入
 * x-studio-token 头（已有该头或 query token 的请求不动）。显式测 token 闸本身的用例
 * （api-token.test.ts）走 node:http 原生请求，不受本包装影响。
 */
;(() => {
  const origFetch = globalThis.fetch.bind(globalThis)
  /** origin → token（空串 = boot 未返回 token，短路不再重复探） */
  const tokenCache = new Map<string, string>()

  // R73-73（批 F-5）：低成本告警防线——「注入 token 后仍 403」的响应有两种来历：
  // ①业务语义确为 403；②该用例本想断「无凭据 → 403」，被本包装的自动注入救活成
  // 「带凭据 403」（X-35 约定正是为防后者：token 闸断言必须走 node:http rawRequest，
  // 见 test/studio/api-token.test.ts 头注）。命中时进程级 warn 一次提示排障方向，
  // 不改写响应、不打断既有测试语义。
  let warnedInjected403 = false
  const warnInjected403 = (pathname: string): void => {
    if (warnedInjected403) return
    warnedInjected403 = true
    console.warn(
      `[studio-token-setup] GET ${pathname} 注入 x-studio-token 后仍返回 403。` +
        '若该用例意图是断言「无凭据 → 403」，它可能已被本包装的自动注入改写（假绿风险）；' +
        'token 闸断言请走 node:http rawRequest（约定见 test/studio/api-token.test.ts 头注）。',
    )
  }

  const resolveUrl = (input: RequestInfo | URL): URL | null => {
    try {
      return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    } catch {
      return null // 相对路径等非绝对 URL：与本包装无关，原样放行
    }
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = resolveUrl(input)
    // R72-20（二十轮 G-6）：与服务端 GET token 豁免路径表（src/studio/server/index.ts
    // GET_TOKEN_EXEMPT_PATHS，唯一事实源）保持同步——stream 端点走自身 ticket/query
    // token 双凭据闸、不读本头，注入属无害空转；显式跳过后，未来「豁免路径上断言
    // 403」类用例不被包装器的注入行为误导排障。
    const GET_TOKEN_EXEMPT = [/^\/api\/boot$/, /^\/api\/books\/[^/]+\/stream$/]
    const shouldInject =
      u !== null &&
      u.pathname.startsWith('/api/') &&
      !GET_TOKEN_EXEMPT.some((re) => re.test(u.pathname)) &&
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
      warnInjected403(u.pathname)
      tokenCache.delete(u.origin)
      const r = await origFetch(`${u.origin}/api/boot`)
      const d = r.ok ? ((await r.json()) as { token?: string }) : null
      if (typeof d?.token === 'string' && d.token !== token) {
        tokenCache.set(u.origin, d.token)
        const h2 = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        h2.set('x-studio-token', d.token)
        const resp2 = await origFetch(input as RequestInfo, { ...init, headers: h2 })
        // 换代 token 重试后仍 403：同属「注入后 403」面，同样告警（进程级一次）
        if (resp2.status === 403) warnInjected403(u.pathname)
        return resp2
      }
    }
    return resp
  }) as typeof fetch
})()
