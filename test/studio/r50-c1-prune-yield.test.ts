/**
 * R50-C-1（五十轮）回归：versions/prune 全书循环逐块让出。
 *
 * 修复前 prune 的 `for (const docId of ids)` 是整段同步循环（pruneSnapshots 内部
 * readdirSync + 逐 meta 读 + 逐 unlink），大书数百 docId 单 tick 冻结事件循环
 * （SSE 心跳/保存同停）；修复后 handler 改 async，每 SCAN_YIELD_EVERY（25）项
 * await yieldToEventLoop() 一次（口径对齐同文件 scanVersionsDirAsync R44-9 范式），
 * reply 在全部 prune 完成后发出。
 *
 * 断言两层：
 * 1. 让出点——透传 spy 包 progress.yieldToEventLoop（vi.mock passthrough，不改行为），
 *    60 个 docId 的 prune 至少触发 2 次让出（25/50 两档）；
 * 2. 全量正确性——超期清理/pinned 与近期保留/removed 计数与同步版逐位一致（大 ids
 *    集下 prune 完整跑完、无中途丢项），回复体在全部完成后才发出。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { decodeUlidTime } from '../../src/document/stable-id.js'
import { yieldToEventLoop } from '../../src/studio/server/api/progress.js'

// 透传式 spy：只计数不改行为（先例 static.test.ts readFile 透传 spy）——
// snapshots.ts 的 prune 循环让出经此模块，计数即让出点观测
vi.mock('../../src/studio/server/api/progress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/studio/server/api/progress.js')>()
  return { ...actual, yieldToEventLoop: vi.fn(actual.yieldToEventLoop) }
})
const yieldSpy = vi.mocked(yieldToEventLoop)

const DAY_MS = 86_400_000
/** Crockford base32 字母表（与 fs/id.ts 一致，同 snapshots-api.test.ts）。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 生成指定时间戳（毫秒）的 ULID 前 10 字符 + 16 字符合法随机部。 */
function ulidAt(ts: number): string {
  let v = BigInt(ts)
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[Number(v & 0x1fn)] + time
    v >>= 5n
  }
  return time + 'J'.repeat(16)
}

const BOOK = 'R50让出测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function request(method: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method, headers: { origin: baseUrl, 'x-studio-token': token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const api = (p: string) => `/api/books/${encodeURIComponent(BOOK)}${p}`

/** 手写一个超期（30 天前）非 pinned 编辑快照，返回其 id。 */
function writeExpiredSnapshot(versionsDir: string, docId: string): string {
  const dir = join(versionsDir, docId)
  mkdirSync(dir, { recursive: true })
  const id = ulidAt(Date.now() - 30 * DAY_MS)
  writeFileSync(
    join(dir, `${id}.md`),
    `---\n版本ID: ${id}\n时间: ${new Date(decodeUlidTime(id)).toISOString()}\n来源: manual\n---\n旧内容\n`,
  )
  return id
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r50-c1-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: R50让出测试书\n  genre: 玄幻\nhost: cc\n',
  )
  writeFileSync(join(bookRoot, '项目', '文档清单.jsonl'), '{"version":1,"type":"header"}\n')
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R50-C-1：versions/prune 逐块让出（scanVersionsDirAsync 同款口径）', () => {
  it('60 个 docId 超期快照 → 全量清理完成（removed=60）且 prune 循环让出 ≥ 2 次（每 25 项一档）', async () => {
    const versionsDir = join(workDir, BOOK, '工作区', '.版本')
    for (let i = 1; i <= 60; i++) {
      writeExpiredSnapshot(versionsDir, `doc_${String(i).padStart(3, '0')}`)
    }

    yieldSpy.mockClear()
    const r = await request('POST', api('/versions/prune'))
    // 回复体在全部 prune 完成后发出：removed 覆盖全部 60 个 docId（中途丢项即数不对）
    expect(r.status).toBe(200)
    expect((r.json as { removed: number }).removed).toBe(60)
    // 逐 docId 核对快照档确已删除（pruneVersions 不删空目录本身——按 .md 档断言）
    for (let i = 1; i <= 60; i++) {
      const dir = join(versionsDir, `doc_${String(i).padStart(3, '0')}`)
      const left = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('._')) : []
      expect(left, `doc_${i} 的超期快照应全部被清理`).toEqual([])
    }
    // 让出点：60 项 / 25 一档 → 至少 2 次（25、50）；同步版此处为 0
    expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('清理语义不回归：超期非 pinned 删、超期 pinned 留、近期留、removed 计数正确（含让出路径）', async () => {
    const versionsDir = join(workDir, BOOK, '工作区', '.版本')
    const vdir = join(versionsDir, 'doc_mix')
    mkdirSync(vdir, { recursive: true })
    const now = Date.now()
    const write = (id: string, pinned: boolean, content: string) =>
      writeFileSync(
        join(vdir, `${id}.md`),
        `---\n版本ID: ${id}\n时间: ${new Date(decodeUlidTime(id)).toISOString()}\n来源: manual\n${
          pinned ? '永久: true\n' : ''
        }---\n${content}`,
      )
    const oldId = ulidAt(now - 30 * DAY_MS) // 超期非 pinned → 删
    const oldPinnedId = ulidAt(now - 30 * DAY_MS - 1) // 超期 pinned → 留
    const recentId = ulidAt(now - 3600_000) // 近期 → 留
    write(oldId, false, '旧内容A\n')
    write(oldPinnedId, true, '定稿旧内容\n')
    write(recentId, false, '近期内容\n')

    const r = await request('POST', api('/versions/prune'))
    expect(r.status).toBe(200)
    expect((r.json as { removed: number }).removed).toBe(1)
    expect(existsSync(join(vdir, `${oldId}.md`))).toBe(false)
    expect(existsSync(join(vdir, `${oldPinnedId}.md`))).toBe(true)
    expect(existsSync(join(vdir, `${recentId}.md`))).toBe(true)
  })
})
