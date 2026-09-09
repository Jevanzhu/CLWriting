/**
 * 清偿-伏笔接线×4（2026-09-09 残留清偿批）回归：PATCH fm / 新建 / 软删 / copy 四处
 * 「伏笔快照读在 per-book 伏笔串行链外」的接线收口——「快照读 → op → 差分落事件」
 * 整段入链（重评2-P3-① PUT content 同口径），并发交叠不重复计窗。
 *
 * 用例①：两并发 PATCH fm（op=fm 是伏笔状态变更最常用入口）交叠 → complete 各归各窗。
 * 用例②：软删+新建并发交叠（op 改 docId 集合的形态）→ clear/create 各归各窗——差分
 *         基线仍取「本单元 op 前的全域快照」，链内前继落库的增删必在基线中。
 * copy 单操作差分语义由 test/studio/foreshadow-events-api.test.ts（R-17 用例）锁定；
 * copy 与 create 同型入链（同一链、同快照-差分结构），并发行为由此两用例覆盖。
 *
 * 确定性手法与 test/studio/re2-foreshadow-delta-concurrency.test.ts 相同：vi.mock 把
 * openSessionStoreAsync 每测首次调用延迟 75ms——先完成 op 的一方被 park 在「已落盘、
 * 差分未落库」窗口，另一方必然在此窗口内做快照读（链外形态即重复计窗：双方基线同取
 * 变更前状态，后落库差分把先落库者的变更一并计入；入链后另一方整段等待，基线已含
 * 前者变更）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'

// park 闸按测重武装（vi.mock 工厂闭包经 vi.hoisted 共享；单测文件内串行执行无竞争）
const gate = vi.hoisted(() => ({ armed: false, parked: false }))
vi.mock('../../src/events/store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/events/store.js')>()
  return {
    ...mod,
    openSessionStoreAsync: async (...args: Parameters<typeof mod.openSessionStoreAsync>) => {
      if (gate.armed && !gate.parked) {
        gate.parked = true
        await new Promise((r) => setTimeout(r, 75))
      }
      return mod.openSessionStoreAsync(...args)
    },
  }
})

const BOOK = '伏笔接线书'
let workDir = ''
let userDataPath = ''
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
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: { 'content-type': 'application/json', origin: baseUrl, 'x-studio-token': token },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 留 null */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 读 workspace 会话里的 foreshadow/change 事件（按落库序）。 */
function foreshadowEvents(): { operation: string; title: string }[] {
  const store = openSessionStore(userDataPath, join(workDir, BOOK))!
  try {
    const sid = store.workspaceSession(bookHash(join(workDir, BOOK)))
    return store
      .listEvents(bookHash(join(workDir, BOOK)), sid)
      .filter((e) => e.type === 'foreshadow/change')
      .map((e) => ({ operation: String(e.data['operation']), title: String(e.data['title']) }))
  } finally {
    store.close()
  }
}

/** 伏笔条目 md。 */
function fsBody(title: string, status: string, word: string): string {
  return `---\n标题: ${title}\n状态: ${status}\n重要性: 高\n关联词: ${title}\n---\n\n${word}\n`
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-fs-wire-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-fs-wire-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 伏笔接线书\n  genre: 玄幻\nhost: cc\n',
  )
  // 清单登记三条伏笔：古剑/玉佩（用例① PATCH fm 各自变更）、铜镜（用例② 软删）
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_fs1","nodeType":"document","path":"设定/伏笔/古剑.md","parentId":null}',
      '{"id":"doc_fs2","nodeType":"document","path":"设定/伏笔/玉佩.md","parentId":null}',
      '{"id":"doc_fs3","nodeType":"document","path":"设定/伏笔/铜镜.md","parentId":null}',
    ].join('\n') + '\n',
  )
  mkdirSync(join(bookRoot, '设定', '伏笔'), { recursive: true })
  writeFileSync(join(bookRoot, '设定', '伏笔', '古剑.md'), fsBody('古剑', '未回收', '主角佩剑藏机关。'), 'utf-8')
  writeFileSync(join(bookRoot, '设定', '伏笔', '玉佩.md'), fsBody('玉佩', '未回收', '身世信物。'), 'utf-8')
  writeFileSync(join(bookRoot, '设定', '伏笔', '铜镜.md'), fsBody('铜镜', '未回收', '照出前世影。'), 'utf-8')

  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('清偿-伏笔接线×4：链外快照读残留收口后并发交叠不重复计窗', () => {
  it('① PATCH fm 两并发交叠（前者差分被 park 在落库窗内）→ complete 各归各窗', async () => {
    gate.armed = true
    gate.parked = false
    // 两请求同时发出：各自 op=fm「未回收 → 已回收」，独立条目各应恰好落 1 条 complete。
    // 链外形态：双方快照基线同取变更前状态，后落库差分把先落库者变更一并计入（4 事件）。
    const [ra, rb] = await Promise.all([
      request('PATCH', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_fs1`, {
        op: 'fm', meta: { 状态: '已回收' },
      }),
      request('PATCH', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_fs2`, {
        op: 'fm', meta: { 状态: '已回收' },
      }),
    ])
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)
    // 恰好 2 条事件（古剑/玉佩 各 1 次 complete）——重复计窗形态下任一条目会出现 2 次
    const events = foreshadowEvents()
    expect(events).toHaveLength(2)
    const sorted = events.slice().sort((a, b) => a.title.localeCompare(b.title))
    expect(sorted).toEqual([
      { operation: 'complete', title: '古剑' },
      { operation: 'complete', title: '玉佩' },
    ])
  })

  it('② 软删+新建并发交叠（docId 集合增减）→ clear/create 各归各窗', async () => {
    gate.armed = true
    gate.parked = false
    const before = foreshadowEvents().length
    // 软删铜镜（集合 −1，文件移出 设定/伏笔/）与新建珠钗（集合 +1）同时发出：
    // 各应恰好落 1 条事件；链外形态双方基线同取变更前全域状态，后落库差分重复计
    // 先落库者的增/删（3~4 事件）。
    const [rd, rc] = await Promise.all([
      request('DELETE', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_fs3`),
      request('POST', `/api/books/${encodeURIComponent(BOOK)}/documents`, {
        relPath: '设定/伏笔/珠钗.md',
        content: fsBody('珠钗', '未回收', '定情信物成谜。'),
      }),
    ])
    expect(rd.status).toBe(200)
    expect(rc.status).toBe(201)
    const delta = foreshadowEvents().slice(before)
    expect(delta).toHaveLength(2)
    const sorted = delta.sort((a, b) => a.title.localeCompare(b.title))
    expect(sorted).toEqual([
      { operation: 'create', title: '珠钗' },
      { operation: 'clear', title: '铜镜' },
    ])
  })
})
