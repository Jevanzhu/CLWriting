/**
 * R42-14 / R42-41（四十二轮）回归：删书墓地并发双删 + rename 新书名 NFC 归一。
 *
 * R42-14：墓地名 `${Date.now()}-${basename}` 同毫秒并发双删同一书撞出同一路径 →
 * 第二请求 rename 落 ENOTEMPTY → 500「书未受影响，可重试」（与事实矛盾）。修复后：
 * - 墓名追加 ULID 后缀（26 字符 Crockford）——两次删除（无论是否同毫秒）墓地副本
 *   名恒唯一；
 * - catch 里 ENOTEMPTY/EEXIST 与 ENOENT 同口径按「已被并发删除」收口 404（双保险）。
 *
 * R42-41：rename 的新书名 normalize('NFC')——与建书（init.ts 平台规范化批）同口径；
 * mac 侧 NFD 形态名直接落目录/登记，跨机到 NFC 惯例卷即「找不到文件」。修复后
 * 落盘目录 / books.jsonl 登记名 / 响应 path 均为 NFC 形。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { __setGraveyardCleanupForTest, __waitForGraveyardCleanupForTest } from '../../src/studio/server/api/books.js'

const GRAVEYARD = '.删书墓地'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function bookYaml(title: string): string {
  return `spec_version: 1\nkind: long\nbook:\n  title: ${title}\n  genre: 玄幻\nhost: cc\n`
}

/** 登记并落盘一本书仓库（覆盖式写 books.jsonl——每用例自管登记面）。 */
function registerBooks(names: string[]): void {
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    names
      .map((n) => JSON.stringify({ name: n, path: `长篇/${n}`, kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }))
      .join('\n') + '\n',
    'utf-8',
  )
  for (const n of names) {
    const bookAbs = join(workDir, '长篇', n)
    mkdirSync(join(bookAbs, '写作', '正文'), { recursive: true })
    writeFileSync(join(bookAbs, 'book.yaml'), bookYaml(n), 'utf-8')
    writeFileSync(join(bookAbs, '写作', '正文', '0001-开篇.md'), '# 开篇\n\n正文。\n', 'utf-8')
  }
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 响应留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r42-books-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R42-14：删书墓地名唯一 + 并发双删收口', () => {
  it('并发双删同一书：一次 200 一次 404，无 500；书目录消失、登记移除', async () => {
    const NAME = '并发双删书'
    registerBooks([NAME])
    const bookAbs = join(workDir, '长篇', NAME)
    const [a, b] = await Promise.all([
      req('DELETE', `/api/books/${encodeURIComponent(NAME)}`),
      req('DELETE', `/api/books/${encodeURIComponent(NAME)}`),
    ])
    // 修复前：双删同毫秒撞墓地名 → 第二 rename ENOTEMPTY → 500（文案误导）；
    // 修复后无论怎么交错：先到者 200，后到者 404（登记已被移除或 rename ENOENT），
    // 绝无 500。
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 404])
    expect(bookAbs.startsWith(workDir)).toBe(true)
    expect(existsSync(bookAbs)).toBe(false)
    const registry = readFileSync(join(workDir, '.clwriting', 'books.jsonl'), 'utf-8')
    expect(registry.includes(NAME)).toBe(false)
  })

  it('墓地名带 26 字符 Crockford ULID 后缀：两次删除副本名互异（同毫秒亦不撞）', async () => {
    // 先等上一用例的在途墓地后台清理收尾，避免其副本残留在本用例的 readdir 断言里
    await __waitForGraveyardCleanupForTest()
    // 暂停墓地后台清理，留副本供断言（finally 还原 + 手工清场）
    __setGraveyardCleanupForTest(async () => {})
    try {
      registerBooks(['墓地甲书', '墓地乙书'])
      const d1 = await req('DELETE', `/api/books/${encodeURIComponent('墓地甲书')}`)
      const d2 = await req('DELETE', `/api/books/${encodeURIComponent('墓地乙书')}`)
      expect(d1.status).toBe(200)
      expect(d2.status).toBe(200)
      const graveDir = join(workDir, GRAVEYARD)
      const entries = readdirSync(graveDir)
      // 两副本各自落位且名互异——Date.now() 前缀 + basename + ULID 后缀
      expect(entries).toHaveLength(2)
      expect(new Set(entries).size).toBe(2)
      // ULID 后缀形态：26 字符 Crockford base32（无 I/L/O/U）
      for (const e of entries) {
        expect(e).toMatch(/[0-9A-HJKMNP-TV-Z]{26}$/)
        expect(e.startsWith('墓地')).toBe(false) // 前缀仍是时间戳，肉眼排序语义不变
        expect(e).toMatch(/^\d{4,}-墓地[甲乙]书-[0-9A-HJKMNP-TV-Z]{26}$/)
      }
    } finally {
      __setGraveyardCleanupForTest(null)
      rmSync(join(workDir, GRAVEYARD), { recursive: true, force: true })
    }
  })
})

describe('R42-41：rename 新书名 NFC 归一', () => {
  it('NFD 形态新书名 → 落盘目录 / 登记名 / 响应 path 均为 NFC 形', async () => {
    const OLD = '原名书'
    // café 合成形（NFC）与分解形（NFD：e + U+0301）——mac 输入法惯存分解形
    const nfd = 'cafe\u0301'
    const nfc = 'caf\u00e9'
    expect(nfd).not.toBe(nfc) // 码位层面确为两形态
    registerBooks([OLD])
    const r = await req('POST', `/api/books/${encodeURIComponent(OLD)}/rename`, { name: nfd })
    expect(r.status).toBe(200)
    const body = r.json as { name: string; path: string }
    expect(body.name).toBe(nfc)
    expect(body.path).toBe(`长篇/${nfc}`)
    // 落盘目录名为 NFC 形（APFS 归一不敏感但保留写入形；posix 敏感卷即字面 NFC）
    expect(readdirSync(join(workDir, '长篇')).includes(nfc)).toBe(true)
    expect(existsSync(join(workDir, '长篇', nfc, 'book.yaml'))).toBe(true)
    // 登记名/path 同为 NFC 形
    const entries = readFileSync(join(workDir, '.clwriting', 'books.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(entries.some((e) => e.name === nfc)).toBe(true)
    expect(entries.some((e) => e.name === nfd)).toBe(false)
  })
})
