/**
 * 快照端点集成测（单章版本回滚）：
 * 启动 studio server + 临时长篇书，走真实保存链路产生快照，
 * 验证列表 / 读取 / 恢复（含恢复后当前内容自动留底 → 可再退回）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { decodeUlidTime } from '../../src/document/stable-id.js'

const DAY_MS = 86_400_000
/** Crockford base32 字母表（与 fs/id.ts 一致）。 */
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

const BOOK = '快照测试书'
const CHAPTER = '写作/正文/0001-开篇.md'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = { origin: baseUrl, 'x-studio-token': token }
    if (payload) headers['content-type'] = 'application/json'
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c.toString('utf-8')))
      res.on('end', () => {
        let json: unknown = null
        try {
          json = JSON.parse(data)
        } catch {
          /* 非 JSON 响应留 null */
        }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const api = (p: string) => `/api/books/${encodeURIComponent(BOOK)}${p}`

/** 走真实保存端点（产生快照要经 DocumentService）。 */
function save(content: string, expectedRevision: string | null, op: string) {
  return request('PUT', api(`/documents/doc_1/content`), {
    content,
    expectedRevision,
    operationId: op,
    origin: 'manual',
  })
}

async function revisionOf(r: { json: unknown }): Promise<string> {
  return (r.json as { revision: string }).revision
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-snap-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 快照测试书\n  genre: 玄幻\nhost: cc\n',
  )
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      `{"id":"doc_1","nodeType":"document","path":"${CHAPTER}","parentId":null,"status":"draft"}`,
    ].join('\n') + '\n',
  )
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('快照端点（单章版本回滚）', () => {
  it('首次保存无快照；再次保存留下前一版', async () => {
    const first = await save('第一版正文', null, 'op1')
    expect(first.status).toBe(200)
    // 新建保存（文件原本不存在）不留底
    let list = await request('GET', api('/documents/doc_1/snapshots'))
    expect((list.json as { entries: unknown[] }).entries).toHaveLength(0)

    // 第二次保存 → 前一版进快照
    const second = await save('第二版正文', await revisionOf(first), 'op2')
    expect(second.status).toBe(200)
    list = await request('GET', api('/documents/doc_1/snapshots'))
    const entries = (list.json as { entries: { id: string; origin: string; words: number }[] }).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.origin).toBe('manual')
    expect(entries[0]!.words).toBeGreaterThan(0)
  })

  it('读单个版本 → 拿到当时的正文', async () => {
    const list = await request('GET', api('/documents/doc_1/snapshots'))
    const id = (list.json as { entries: { id: string }[] }).entries[0]!.id
    const r = await request('GET', api(`/documents/doc_1/snapshots/${id}`))
    expect(r.status).toBe(200)
    expect((r.json as { content: string }).content).toBe('第一版正文')
  })

  it('恢复 → 正文回到该版本，且当前内容自动留底', async () => {
    const before = await request('GET', api('/documents/doc_1/snapshots'))
    const id = (before.json as { entries: { id: string }[] }).entries[0]!.id
    expect(readFileSync(join(workDir, BOOK, CHAPTER), 'utf-8')).toBe('第二版正文')

    const r = await request('POST', api(`/documents/doc_1/snapshots/${id}/restore`), {
      expectedRevision: await computeCurrentRevision(),
    })
    expect(r.status).toBe(200)
    expect(readFileSync(join(workDir, BOOK, CHAPTER), 'utf-8')).toBe('第一版正文')

    // 恢复前的内容进了快照 → 可再退回
    const after = await request('GET', api('/documents/doc_1/snapshots'))
    const entries = (after.json as { entries: { id: string; origin: string }[] }).entries
    expect(entries.length).toBeGreaterThan(1)
    expect(entries[0]!.origin).toBe('restore')
    const restored = await request('GET', api(`/documents/doc_1/snapshots/${entries[0]!.id}`))
    expect((restored.json as { content: string }).content).toBe('第二版正文')
  })

  it('expectedRevision 不符 → 409', async () => {
    const list = await request('GET', api('/documents/doc_1/snapshots'))
    const id = (list.json as { entries: { id: string }[] }).entries[0]!.id
    const r = await request('POST', api(`/documents/doc_1/snapshots/${id}/restore`), {
      expectedRevision: 'sha256:deadbeef',
    })
    expect(r.status).toBe(409)
  })

  it('缺 expectedRevision → 400', async () => {
    const list = await request('GET', api('/documents/doc_1/snapshots'))
    const id = (list.json as { entries: { id: string }[] }).entries[0]!.id
    const r = await request('POST', api(`/documents/doc_1/snapshots/${id}/restore`), {})
    expect(r.status).toBe(400)
  })

  it('版本不存在 → 404', async () => {
    const r = await request('GET', api('/documents/doc_1/snapshots/0000000000ZZZZZZZZZZZZZZZZ'))
    expect(r.status).toBe(404)
  })

  it('未登记 docId → 404', async () => {
    const r = await request('GET', api('/documents/doc_unknown/snapshots'))
    expect(r.status).toBe(404)
  })

  it('prune：超期编辑快照清理、pinned 定稿保留、计数正确', async () => {
    // 手写一批版本文件：超期非 pinned ×2、超期 pinned ×1、近期非 pinned ×1
    const vdir = join(workDir, BOOK, '工作区', '.版本', 'doc_1')
    mkdirSync(vdir, { recursive: true })
    const now = Date.now()
    const old = now - 30 * DAY_MS // 30 天前，超 maxDays(14)
    const recent = now - 1 * 3600_000 // 1 小时前，属于细粒度保留窗口
    const write = (id: string, pinned: boolean, content: string) =>
      writeFileSync(
        join(vdir, `${id}.md`),
        `---\n版本ID: ${id}\n时间: ${new Date(decodeUlidTime(id)).toISOString()}\n来源: manual\n${
          pinned ? '永久: true\n' : ''
        }---\n${content}`,
      )
    const oldId = ulidAt(old)
    const oldPinnedId = ulidAt(old - 1)
    const recentId = ulidAt(recent)
    write(oldId, false, '旧内容A\n')
    write(oldPinnedId, true, '定稿旧内容\n')
    write(recentId, false, '近期内容\n')

    const r = await request('POST', api('/versions/prune'))
    expect(r.status).toBe(200)
    expect((r.json as { removed: number }).removed).toBe(1)
    // 超期非 pinned 被删；pinned 与近期保留
    expect(existsSync(join(vdir, `${oldId}.md`))).toBe(false)
    expect(existsSync(join(vdir, `${oldPinnedId}.md`))).toBe(true)
    expect(existsSync(join(vdir, `${recentId}.md`))).toBe(true)
  })

  it('prune：无版本目录 → 空操作', async () => {
    const r = await request('POST', api('/versions/prune'))
    expect(r.status).toBe(200)
    expect((r.json as { removed: number }).removed).toBe(0)
  })

  // R-15（第十六轮）：walk 对 symlink 目录环的防护——version-stats 的 scanVersionsDir
  // 此前 statSync 跟随 symlink，指向祖先目录的 symlink 造成无限递归（挂死端点/栈溢出）；
  // 修复后 lstatSync 判定 + symlink 条目跳过（M-9 同族口径）。
  it('R-15: 版本目录含指向祖先的 symlink → version-stats 正常返回（不死循环）', async () => {
    const vdir = join(workDir, BOOK, '工作区', '.版本')
    mkdirSync(join(vdir, 'doc_loop'), { recursive: true })
    writeFileSync(join(vdir, 'doc_loop', 'a.md'), '---\n来源: manual\n---\n环内容\n')
    // symlink 指向祖先目录：修复前 statSync 跟随 → walk 无限递归
    symlinkSync(vdir, join(vdir, 'doc_loop', 'loop'))
    const r = await request('GET', api('/version-stats'))
    expect(r.status).toBe(200)
    expect((r.json as { snapshotCount: number }).snapshotCount).toBeGreaterThanOrEqual(1)
    // 清理本用例的环构造，避免影响后续（同文件各用例共享书目录）
    rmSync(join(vdir, 'doc_loop'), { recursive: true, force: true })
  }, 10_000)
})

/** 当前磁盘内容的 revision（服务端乐观锁基线，按文件字节算）。 */
async function computeCurrentRevision(): Promise<string> {
  const { computeRevision } = await import('../../src/document/revision.js')
  return computeRevision(join(workDir, BOOK, CHAPTER))
}
