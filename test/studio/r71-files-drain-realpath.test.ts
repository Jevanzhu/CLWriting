/**
 * R71-10（总七十一轮）drainFilePutChainsUnder 口径分叉回归：
 * PUT 链键是 resolveWithinRoot 的 realpath（目标存在时，safe-path.ts），而 drain 调用方
 * （books.ts 删书/改名）传入的书根是 join(workDir, entry.path) 词法口径——workDir 含
 * symlink 组件（macOS /var→/private/var、测试显式 symlink）时词法前缀永不匹配 →
 * drain no-op、R69-25 守卫失效。修复后 drain 对书根补 realpath 前缀双匹配。
 *
 * 手法：symlink workDir + 大文件设定（临界段 readFileHashed+sha256 有足量在途窗），
 * 断言 drain(词法根) 真正等到链排空（修复前 no-op 立即返回）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, sep } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { drainFilePutChainsUnder, __filePutChainKeysForTest } from '../../src/studio/server/api/files.js'

const BOOK = 'R71排空书'
let realRoot = ''
let linkRoot = '' // symlink workDir（词法口径）
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      origin: baseUrl,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  realRoot = mkdtempSync(join(tmpdir(), 'clw-r71-drain-real-'))
  linkRoot = join(dirname(realRoot), basename(realRoot) + '-link')
  symlinkSync(realRoot, linkRoot) // 词法 workDir 与 realpath 分叉的确定源（mac/linux 均生效）
  mkdirSync(join(realRoot, '.clwriting'), { recursive: true })
  writeFileSync(
    join(realRoot, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(realRoot, BOOK)
  mkdirSync(join(bookRoot, '设定'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: R71排空书\n  genre: 玄幻\nhost: cc\n')
  server = startServer({ port: 0, workDir: linkRoot })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = boot.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (linkRoot) rmSync(linkRoot, { force: true })
  if (realRoot) rmSync(realRoot, { recursive: true, force: true })
})

describe('R71-10: symlink workDir 下 PUT 链能被 drain', () => {
  // Windows 建 symlink 需特权——平台门跳过（mac/linux 覆盖词法/realpath 分叉场景）。
  // F-10（二十九轮批 F）：三元 `(platform === 'win32' ? it.skip : it)(...)` 形态改
  // `it.skipIf(...)` 家规形态；check-counts 的 skip 检出正则（findOnlyOrSkipViolations）
  // 只认 `.skip(`，`.skipIf(` 不会被误判为无条件 skip。
  it.skipIf(process.platform === 'win32')(
    '链键为 realpath 时 drain(词法书根) 真正等待链排空（修复前 no-op）',
    { timeout: 30_000 },
    async () => {
      const lexicalBookRoot = join(linkRoot, BOOK) // 调用方（books.ts）口径
      const realBookRoot = realpathSync(lexicalBookRoot)
      // 前置：symlink 确实造成两口径分叉（否则本用例无意义）
      expect(realBookRoot).not.toBe(lexicalBookRoot)

      // 大文件设定：临界段 readFileHashed + sha256 提供足量在途窗
      const filePath = join(realBookRoot, '设定', '总纲.md')
      writeFileSync(filePath, 'x'.repeat(96 * 1024 * 1024))

      // 发出 PUT（不等响应）；轮询观测钩子直到链键出现（= 已入列且临界段在途）
      const putP = req('PUT', `/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('设定/总纲.md')}`, {
        content: '新总纲内容',
      })
      let keys: readonly string[] = []
      for (let i = 0; i < 2000; i++) {
        keys = __filePutChainKeysForTest()
        if (keys.length > 0) break
        await new Promise((r) => setTimeout(r, 1))
      }
      // 链键口径断言：realpath 形（词法前缀不匹配——这正是修复前 drain no-op 的现场）
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.some((k) => k.startsWith(realBookRoot + sep))).toBe(true)
      expect(keys.every((k) => !k.startsWith(lexicalBookRoot + sep))).toBe(true)

      let drainDone = false
      const drainP = drainFilePutChainsUnder(lexicalBookRoot).then(() => {
        drainDone = true
      })
      // 一拍宏任务后：临界段仍在读 96MB → 链未排空 → drain 必须仍挂起。
      // 修复前词法前缀不匹配 realpath 链键 → pending 为空 → drainDone 已 true
      await new Promise((r) => setTimeout(r, 0))
      expect(drainDone).toBe(false)

      await drainP
      expect(drainDone).toBe(true)
      // 链已排空并自清理
      expect(__filePutChainKeysForTest()).toHaveLength(0)
      // PUT 本身完成且写入生效（经 realpath 侧验证盘上内容）
      const put = await putP
      expect(put.status).toBe(200)
      expect(readFileSync(join(realBookRoot, '设定', '总纲.md'), 'utf8')).toBe('新总纲内容')
      // 词法/realpath 前缀互不包含（同书两口径确实分叉，双覆盖缺一不可）
      expect((realBookRoot + sep).startsWith(lexicalBookRoot + sep)).toBe(false)
    },
  )
})
