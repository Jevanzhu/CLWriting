/**
 * 伏笔差分事件并发保存的「不重复计窗」行为面——「快照读 → op → 差分落事件」整段入
 * per-book 串行链：
 * - PATCH fm / 新建 / 软删 / copy 四处「伏笔快照读在串行链外」的接线收口；
 * - PUT content 同口径（原 documents.ts 保存链的差分读在保存串行队列之外）。
 *
 * 用例①：两并发 PATCH fm（op=fm 是伏笔状态变更最常用入口）交叠 → complete 各归各窗。
 * 用例②：软删+新建并发交叠（op 改 docId 集合的形态）→ clear/create 各归各窗——差分
 *         基线仍取「本单元 op 前的全域快照」，链内前继落库的增删必在基线中。
 * copy 单操作差分语义由 test/studio/foreshadow-events-api.test.ts（R-17 用例）锁定；
 * copy 与 create 同型入链（同一链、同快照-差分结构），并发行为由此两用例覆盖。
 *
 * 确定性手法：vi.mock 把 openSessionStoreAsync 每测首次调用延迟 75ms——先完成 op 的
 * 一方被 park 在「已落盘、差分未落库」窗口，另一方必然在此窗口内做快照读（链外形态即
 * 重复计窗：双方基线同取变更前状态，后落库差分把先落库者的变更一并计入；入链后另一方
 * 整段等待，基线已含前者变更）。
 *
 * PUT content 用例自带书根夹具（清单登记两条独立伏笔，与上组三条目书根互不干扰：
 * 事件按「当刻全量状态」做差分，两组条目若同书会互相污染基线；组的 beforeAll/afterAll
 * 成对自建自清）。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（request 走裸 http.request，保留本地）。
 */
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../../helpers/studio-server.js'
import { openSessionStore, bookHash } from '../../../src/events/store.js'
import { computeRevision } from '../../../src/document/revision.js'

// park 闸按测重武装（vi.mock 工厂闭包经 vi.hoisted 共享；单测文件内串行执行无竞争）
const gate = vi.hoisted(() => ({ armed: false, parked: false }))
vi.mock('../../../src/events/store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/events/store.js')>()
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
let studio: StudioHarness
let userDataPath = ''

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: { 'content-type': 'application/json', origin: studio.baseUrl, 'x-studio-token': studio.token },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
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
  const store = openSessionStore(userDataPath, studio.bookRoot)!
  try {
    const sid = store.workspaceSession(bookHash(studio.bookRoot))
    return store
      .listEvents(bookHash(studio.bookRoot), sid)
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
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-fs-wire-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-fs-wire-',
    dirs: ['项目', '设定/伏笔'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 伏笔接线书\n  genre: 玄幻\nhost: cc\n',
    // 清单登记三条伏笔：古剑/玉佩（用例① PATCH fm 各自变更）、铜镜（用例② 软删）
    files: [
      {
        rel: '项目/文档清单.jsonl',
        content:
          [
            '{"version":1,"type":"header"}',
            '{"id":"doc_fs1","nodeType":"document","path":"设定/伏笔/古剑.md","parentId":null}',
            '{"id":"doc_fs2","nodeType":"document","path":"设定/伏笔/玉佩.md","parentId":null}',
            '{"id":"doc_fs3","nodeType":"document","path":"设定/伏笔/铜镜.md","parentId":null}',
          ].join('\n') + '\n',
      },
      { rel: '设定/伏笔/古剑.md', content: fsBody('古剑', '未回收', '主角佩剑藏机关。') },
      { rel: '设定/伏笔/玉佩.md', content: fsBody('玉佩', '未回收', '身世信物。') },
      { rel: '设定/伏笔/铜镜.md', content: fsBody('铜镜', '未回收', '照出前世影。') },
    ],
    userDataPath,
  })
})

afterAll(async () => {
  await studio.close()
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
        op: 'fm',
        meta: { 状态: '已回收' },
      }),
      request('PATCH', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_fs2`, {
        op: 'fm',
        meta: { 状态: '已回收' },
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
    // win←dev 合并批适配：localeCompare 走 ICU 拼音序（win zh 排「铜」<「珠」），dev 侧
    // runner 按码点位序（珠 U+73E0 < 铜 U+94DC）——断言排序改码点比较器，平台无关
    const sorted = delta.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
    expect(sorted).toEqual([
      { operation: 'create', title: '珠钗' },
      { operation: 'clear', title: '铜镜' },
    ])
  })
})

// ── PUT content 保存链的伏笔差分同口径：原 documents.ts PUT content 的
// foreshadowSnapshot 读在保存串行队列之外——两并发保存交叠时双方基线同取前者变更前的
// 状态，而 recordForeshadowDelta 的差分读「当刻」全量状态——后落库的一方把先落库者的
// 变更一并计入自己的差分窗（事件流重复计窗）。入链后两并发保存的事件各归各窗（总数 2）。
// 独立书根（两条独立伏笔，不与上组三条目书根互扰）；putContent 走裸 http.request 定制
// 形态（保留本地：需要 origin 头与 PUT 语义逐字）。──

const CC_BOOK = '伏笔并发书'
let ccStudio: StudioHarness
let ccUserDataPath = ''

/** 文件已存在时的 expectedRevision（sha256(现有内容)）。 */
function ccRevOf(relPath: string): `sha256:${string}` {
  return computeRevision(join(ccStudio.bookRoot, relPath))
}

function ccPutContent(docId: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(ccStudio.baseUrl)
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `/api/books/${encodeURIComponent(CC_BOOK)}/documents/${docId}/content`,
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ccStudio.baseUrl, 'x-studio-token': ccStudio.token },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
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
    req.write(payload)
    req.end()
  })
}

/** 读并发书根 workspace 会话里的 foreshadow/change 事件（按落库序）。 */
function ccForeshadowEvents(): { operation: string; title: string }[] {
  const store = openSessionStore(ccUserDataPath, ccStudio.bookRoot)!
  try {
    const sid = store.workspaceSession(bookHash(ccStudio.bookRoot))
    return store
      .listEvents(bookHash(ccStudio.bookRoot), sid)
      .filter((e) => e.type === 'foreshadow/change')
      .map((e) => ({ operation: String(e.data['operation']), title: String(e.data['title']) }))
  } finally {
    store.close()
  }
}

/** 伏笔条目 md（fm 状态可变）。 */
function ccFsBody(title: string, status: string, word: string): string {
  return `---\n标题: ${title}\n状态: ${status}\n重要性: 高\n关联词: ${title}\n---\n\n${word}\n`
}

describe('PUT content 保存链的伏笔差分并发不重复计窗', () => {
  beforeAll(async () => {
    ccUserDataPath = mkdtempSync(join(tmpdir(), 'clwriting-fs-cc-ud-'))
    ccStudio = await bootStudio({
      book: CC_BOOK,
      prefix: 'clwriting-fs-cc-',
      dirs: ['项目', '设定/伏笔'],
      bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 伏笔并发书\n  genre: 玄幻\nhost: cc\n',
      // 清单登记两条伏笔（各自独立变更，互不为同一文件的先后版本）
      files: [
        {
          rel: '项目/文档清单.jsonl',
          content:
            [
              '{"version":1,"type":"header"}',
              '{"id":"doc_fs1","nodeType":"document","path":"设定/伏笔/古剑.md","parentId":null}',
              '{"id":"doc_fs2","nodeType":"document","path":"设定/伏笔/玉佩.md","parentId":null}',
            ].join('\n') + '\n',
        },
        { rel: '设定/伏笔/古剑.md', content: ccFsBody('古剑', '未回收', '主角佩剑藏机关。') },
        { rel: '设定/伏笔/玉佩.md', content: ccFsBody('玉佩', '未回收', '身世信物。') },
      ],
      userDataPath: ccUserDataPath,
    })
  })

  afterAll(async () => {
    await ccStudio.close()
    if (ccUserDataPath) rmSync(ccUserDataPath, { recursive: true, force: true })
  })

  it('两并发伏笔保存交叠（前者差分被 park 在落库窗内）→ 事件各归各窗，不重复', async () => {
    gate.armed = true
    gate.parked = false
    // 两请求同时发出：各自「未回收 → 已回收」，独立条目各应恰好落 1 条 complete 事件。
    // 修复前后差异：后落库 delta 的基线是否被 park 的前者拉回到变更前状态。
    const [ra, rb] = await Promise.all([
      ccPutContent('doc_fs1', {
        content: ccFsBody('古剑', '已回收', '机关已开。'),
        expectedRevision: ccRevOf('设定/伏笔/古剑.md'),
        operationId: 'op-cc-fs1',
        origin: 'manual',
      }),
      ccPutContent('doc_fs2', {
        content: ccFsBody('玉佩', '已回收', '信物已认。'),
        expectedRevision: ccRevOf('设定/伏笔/玉佩.md'),
        operationId: 'op-cc-fs2',
        origin: 'manual',
      }),
    ])
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)
    // 恰好 2 条事件（古剑/玉佩 各 1 次 complete）——重复计窗形态下玉佩或古剑会出现 2 次
    const events = ccForeshadowEvents()
    expect(events).toHaveLength(2)
    const sorted = events.slice().sort((a, b) => a.title.localeCompare(b.title))
    expect(sorted).toEqual([
      { operation: 'complete', title: '古剑' },
      { operation: 'complete', title: '玉佩' },
    ])
  })
})
