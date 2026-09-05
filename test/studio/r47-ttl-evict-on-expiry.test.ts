/**
 * R47-18（四十七轮）回归：书键 TTL 缓存族「过期即逐出」。
 *
 * 原实现命中检查发现过期只当 miss 用、不 delete（条目驻留至 FIFO 触顶/删书）。
 * 模块级缓存 Map 不导出，用行为间接断言（不改生产代码加导出）：挑两个「重算失败
 * 不落缓存」形态的家族成员——state.ts /state（500 错误路径不 set）与 health.ts
 * /health/style（async handler rejection → dispatch 500 不 set）——过期后触发一次
 * 必败重算：修复前过期死条目仍驻留（hasForTest=true），修复后随 miss 检查顺手逐出
 * （hasForTest=false）。既有观测钩子 __stateCacheHasForTest / __styleScanCacheHasForTest
 * 直接断言；失败注入走透传式 vi.mock（先例 static.test.ts 的 node:fs/promises spy），
 * 仅 mockImplementationOnce 单发生效，其余调用走真身。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { __setStateTtlForTest, __stateCacheHasForTest } from '../../src/studio/server/api/state.js'
import {
  __setStyleScanTtlForTest,
  __styleScanCacheHasForTest,
} from '../../src/studio/server/api/health.js'
import { readManifest } from '../../src/document/manifest.js'
import { scanChaptersAsync } from '../../src/metrics/style.js'

// 透传式 spy：默认行为不变，用例内 mockImplementationOnce 单发注入失败
vi.mock('../../src/document/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/document/manifest.js')>()
  return { ...actual, readManifest: vi.fn(actual.readManifest) }
})
const readManifestMock = vi.mocked(readManifest)
vi.mock('../../src/metrics/style.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/metrics/style.js')>()
  return { ...actual, scanChaptersAsync: vi.fn(actual.scanChaptersAsync) }
})
const scanChaptersAsyncMock = vi.mocked(scanChaptersAsync)

const STATE_BOOK = 'R47过期逐出判态书'
const HEALTH_BOOK = 'R47过期逐出体检书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

const CH_FM = (n: number, t: string) => `---\n章号: ${n}\n标题: ${t}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n`

async function get(path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { 'x-studio-token': token } })
  let json: any = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r47-evict-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: STATE_BOOK, path: STATE_BOOK, kind: 'short' }) + '\n' +
      JSON.stringify({ name: HEALTH_BOOK, path: HEALTH_BOOK, kind: 'long' }) + '\n',
  )
  // 判态书：短篇无布线，book.yaml 即可判态（态 7）
  const stateRoot = join(workDir, STATE_BOOK)
  mkdirSync(join(stateRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(stateRoot, '项目'), { recursive: true })
  writeFileSync(join(stateRoot, 'book.yaml'), `spec_version: 1\nkind: short\nbook:\n  title: ${STATE_BOOK}\n  genre: 玄幻\nhost: cc\n`)
  // 体检书：1 章定稿正文 → scanChapters 样本非空
  const healthRoot = join(workDir, HEALTH_BOOK)
  mkdirSync(join(healthRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(healthRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${HEALTH_BOOK}\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n`)
  writeFileSync(join(healthRoot, '写作', '正文', '0001-开篇.md'), CH_FM(1, '开篇') + '主角登场，初入宗门。\n')

  // TTL 注入短档（先例 r75-state-tree-issues-ttl：1000ms 档 + 到期侧睡 TTL+500）
  __setStateTtlForTest(1000)
  __setStyleScanTtlForTest(1000)
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  __setStateTtlForTest(null) // 恢复默认 TTL，避免污染同进程其它测试
  __setStyleScanTtlForTest(null)
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R47-18：过期条目随 miss 检查顺手逐出（行为间接断言）', () => {
  it('state：过期 → 重算 500（不落缓存）→ 条目已被逐出；恢复后可重建', async () => {
    const bookRoot = join(workDir, STATE_BOOK)
    // 首查：200 现算落缓存
    const first = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    expect(first.status).toBe(200)
    expect(__stateCacheHasForTest(bookRoot)).toBe(true)

    // TTL 到期 → 注入单发失败（readManifest 抛）→ 重算 500、不落缓存
    await new Promise((r) => setTimeout(r, 1000 + 500))
    readManifestMock.mockImplementationOnce(() => {
      throw new Error('R47-18 注入：清单读取失败')
    })
    const failed = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    expect(failed.status).toBe(500)
    // 逐出口径：修复前过期死条目仍驻留（true），修复后随 miss 检查删除（false）
    expect(__stateCacheHasForTest(bookRoot)).toBe(false)

    // 恢复（one-shot 已消费）：再次 200 现算并重建缓存
    const recovered = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    expect(recovered.status).toBe(200)
    expect(__stateCacheHasForTest(bookRoot)).toBe(true)
  })

  it('health/style：过期 → 扫描 rejection（dispatch 500、不落缓存）→ 条目已被逐出；恢复后可重建', async () => {
    const bookRoot = join(workDir, HEALTH_BOOK)
    const first = await get(`/api/books/${encodeURIComponent(HEALTH_BOOK)}/health/style`)
    expect(first.status).toBe(200)
    expect(__styleScanCacheHasForTest(bookRoot)).toBe(true)

    await new Promise((r) => setTimeout(r, 1000 + 500))
    scanChaptersAsyncMock.mockImplementationOnce(() => Promise.reject(new Error('R47-18 注入：全书扫描失败')))
    const failed = await get(`/api/books/${encodeURIComponent(HEALTH_BOOK)}/health/style`)
    expect(failed.status).toBe(500)
    expect(__styleScanCacheHasForTest(bookRoot)).toBe(false) // 逐出（修复前驻留为 true）

    const recovered = await get(`/api/books/${encodeURIComponent(HEALTH_BOOK)}/health/style`)
    expect(recovered.status).toBe(200)
    expect(__styleScanCacheHasForTest(bookRoot)).toBe(true)
  })
})
