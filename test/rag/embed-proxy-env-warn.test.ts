/**
 * 0918二轮修复批（G102）：出站代理环境变量一次性检测 warn 回归。
 *
 * 背景：Node 内置 fetch（bundled undici）不读 HTTPS_PROXY 系环境变量，配了系统/
 * 环境代理也直连。代理真修按缓办处置（依据见 src/rag/embed.ts 的 G102 注释块：
 * Node 全局面不暴露 dispatcher 符号——v26 实证；npm undici 属新增运行时依赖且其
 * setGlobalDispatcher 管不到内置 global fetch；打包链与配置面属产品决策）。本文件
 * 锁定缓办留痕行为：代理环境变量非空时首次出站 warn 恰一次、不回显代理地址值。
 */
import { afterEach, expect, test, vi } from 'vitest'
import { embed } from '../../src/rag/embed.js'
import { log } from '../../src/log/index.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const OK_RESP = (): Response =>
  new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

test('HTTPS_PROXY 已设：首次出站前 warn 恰一次（人话提示 + 不回显代理地址），重复调用不刷屏', async () => {
  vi.stubEnv('HTTPS_PROXY', 'http://user:secret@127.0.0.1:7890')
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => OK_RESP()),
  )

  await expect(embed('https://proxy-env.example/embeddings', 'm', 'k', ['正文'])).resolves.toEqual([[1, 2, 3]])
  await expect(embed('https://proxy-env.example/embeddings', 'm', 'k', ['正文'])).resolves.toEqual([[1, 2, 3]])

  const hits = warn.mock.calls.filter((c) => String(c[1]).includes('不支持经代理'))
  expect(hits).toHaveLength(1) // 一次性标志：第二次出站不再 warn
  expect(String(hits[0]![1])).toContain('HTTPS_PROXY')
  expect(String(hits[0]![1])).toContain('中转端点可直连')
  // 不回显代理地址（user:pass@host 形态含凭据，连 host 都不进日志）
  expect(String(hits[0]![1])).not.toContain('127.0.0.1')
  expect(String(hits[0]![1])).not.toContain('secret')
})

test('无任何代理环境变量：正常出站零代理 warn', async () => {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(k, '')
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => OK_RESP()),
  )

  await expect(embed('https://no-proxy.example/embeddings', 'm', 'k', ['正文'])).resolves.toEqual([[1, 2, 3]])
  expect(warn.mock.calls.filter((c) => String(c[1]).includes('不支持经代理'))).toHaveLength(0)
})
