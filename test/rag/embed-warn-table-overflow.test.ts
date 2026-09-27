/**
 * embed 失败留痕表的 FIFO 上限回归。
 *
 * src/rag/embed.ts 的 warnEmbedFailure 按端点去抖（60s 窗内同端点只留痕一次，分批
 * 索引失败不刷屏），去抖表的键 = 用户配置的端点串——作者增删 provider 后旧键永驻，
 * 故表设 64 键上限、超限丢最旧。本文件只以对外的 log.warn 次数为观测面钉住该上限：
 * 第 65 个端点进来时最旧键被挤出，它再次失败会重新留痕（不再被去抖吞）；表内最新键
 * 仍在窗内静默；被挤掉的是最旧而非最新（FIFO 而非 LIFO）。
 */
import { afterEach, expect, test, vi } from 'vitest'
import { embed } from '../../src/rag/embed.js'
import { log } from '../../src/log/index.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 第 i 个端点（各为独立去抖键） */
const endpointOf = (i: number): string => `https://fifo-${i}.example/embeddings`

test('去抖表满 64 键：第 65 个端点挤掉最旧键（再失败重新留痕），最新键仍在窗内静默', async () => {
  // 代理环境变量清空——本机环境自带 HTTPS_PROXY/HTTP_PROXY，不清会多出一条无关 warn
  //（按文案过滤已够，双保险让 warn 计数即全部留痕）
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(k, '')
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('boom', { status: 500 })),
  )
  const failureWarns = (): number =>
    warn.mock.calls.filter((c) => String(c[1]).includes('embedding 端点调用失败')).length
  const warnsOn = (endpoint: string): number =>
    warn.mock.calls.filter((c) => String(c[1]).includes(`endpoint=${endpoint}`)).length

  // 65 个互不相同的端点各失败一次：前 64 个各留痕一次，第 65 个插入时表已 65 键 → 丢最旧
  for (let i = 0; i < 65; i++) {
    await expect(embed(endpointOf(i), 'm', 'k', ['正文'])).resolves.toBeNull()
  }
  expect(failureWarns()).toBe(65)

  // 最旧键（#0）已被挤出 → 不再命中去抖，重新留痕（上限生效的对外证据）
  await expect(embed(endpointOf(0), 'm', 'k', ['正文'])).resolves.toBeNull()
  expect(failureWarns()).toBe(66)
  expect(warnsOn(endpointOf(0))).toBe(2)

  // 最新键（#64）仍在表内且落在 60s 窗内 → 静默（上限只丢最旧，不误伤新键）
  await expect(embed(endpointOf(64), 'm', 'k', ['正文'])).resolves.toBeNull()
  expect(failureWarns()).toBe(66)

  // #0 重插后挤掉的是次旧的 #1（FIFO 而非 LIFO）——#1 再次失败同样重新留痕
  await expect(embed(endpointOf(1), 'm', 'k', ['正文'])).resolves.toBeNull()
  expect(failureWarns()).toBe(67)
  expect(warnsOn(endpointOf(1))).toBe(2)
})
