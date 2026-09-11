/**
 * R0912-B-P2-1（2026-09-12 第十篇独立重评修复批）回归锚：五处 TTL 结果缓存的
 * 「TTL 窗从写入当刻起算」。
 *
 * 修复前五处端点均「捕获 now → await 秒级计算 → set(…, ts: now)」——ts 取计算**前**
 * 时刻，秒级计算时长被白白吃进有效缓存窗（大书 /state 判态 2s 即少 2s 缓存）；
 * 修复后 set 行改 ts: Date.now()（写入当刻），now 变量仅用于命中判断。
 *
 * 判别设计（先例 r75-state-tree-issues-ttl 的注入时钟，toFake:['Date'] + 真 HTTP/真 I/O）：
 * - 慢计算模拟：vi.mock 包裹各端点的重计算内核（detectState / collectTreeIssuesAsync /
 *   scanChaptersAsync / learnFromBook），进入时 advanceTimersByTime(6000)——推快发生在
 *   「捕获 now 之后、set 之前」，确定性强（不依赖真实竞态窗口）；
 * - 写后推进 500ms（< 各 TTL；overview 内层 stateCache 固定 TTL 5000，慢推 6000 已够
 *   翻转旧语义）：修复后 ts=写入当刻 → 500 < TTL 命中旧值；修复前 ts=捕获时刻 →
 *   6000+500 ≥ TTL 必 miss 重算见新值——断言命中旧值即钉死新语义；
 * - 到期臂再推进越过 TTL：重算见盘上新值（证明命中臂确为缓存而非盘上无变化）。
 * 五处覆盖：/state（state.ts）、/overview 内层 stateCache（overview.ts）、/tree-issues
 *（check.ts）、/health/style（health.ts）、/learn（knowledge.ts）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { __setStateTtlForTest } from '../../src/studio/server/api/state.js'
import { __setTreeIssuesTtlForTest } from '../../src/studio/server/api/check.js'
import { __setStyleScanTtlForTest } from '../../src/studio/server/api/health.js'
import { __setLearnTtlForTest } from '../../src/studio/server/api/knowledge.js'
import { __setOverviewCacheTtlForTest } from '../../src/studio/server/api/overview.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

// ── 慢计算注入门（vi.mock 工厂闭包引用；测试体执行前置零，用例内置位）────────
// >0 时被包裹内核进入即推快假钟——模拟「秒级计算吃掉缓存窗」的现场。
const slowAdvance: { state: number; tree: number; style: number; learn: number } = {
  state: 0,
  tree: 0,
  style: 0,
  learn: 0,
}

// 包裹四端点的重计算内核（spread 保其余导出原样；闭包只在调用时刻读 slowAdvance——
// 工厂执行于模块导入期，TDZ 安全）
vi.mock('../../src/state/state.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/state/state.js')>()
  return {
    ...mod,
    detectState: async (...args: Parameters<typeof mod.detectState>) => {
      if (slowAdvance.state > 0) vi.advanceTimersByTime(slowAdvance.state)
      return mod.detectState(...args)
    },
  }
})
vi.mock('../../src/check/run.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/check/run.js')>()
  return {
    ...mod,
    collectTreeIssuesAsync: async (...args: Parameters<typeof mod.collectTreeIssuesAsync>) => {
      if (slowAdvance.tree > 0) vi.advanceTimersByTime(slowAdvance.tree)
      return mod.collectTreeIssuesAsync(...args)
    },
  }
})
vi.mock('../../src/metrics/style.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/metrics/style.js')>()
  return {
    ...mod,
    scanChaptersAsync: async (...args: Parameters<typeof mod.scanChaptersAsync>) => {
      if (slowAdvance.style > 0) vi.advanceTimersByTime(slowAdvance.style)
      return mod.scanChaptersAsync(...args)
    },
  }
})
vi.mock('../../src/learn/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/learn/index.js')>()
  return {
    ...mod,
    learnFromBook: async (...args: Parameters<typeof mod.learnFromBook>) => {
      if (slowAdvance.learn > 0) vi.advanceTimersByTime(slowAdvance.learn)
      return mod.learnFromBook(...args)
    },
  }
})

const STATE_BOOK = 'R0912判态缓存书' // 短篇无布线 → 态 7
const OVERVIEW_BOOK = 'R0912总览缓存书' // 短篇（/overview 内层 stateCache）
const TREE_BOOK = 'R0912树红点缓存书' // 文风硬禁词红章
const STYLE_BOOK = 'R0912文风缓存书' // 无清单 → 全量口径（d3 先例）
const LEARN_BOOK = 'R0912收割缓存书' // 无清单 → 全量口径；金句特征句
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let treeBookRoot = ''
let redDocId = ''
let stateManifestPath = ''
let overviewManifestPath = ''

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) })
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function post(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) })
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

const CH_FM = (n: number, t: string) => `---\n章号: ${n}\n标题: ${t}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n`

/** 短篇判态书夹具（1 定稿章 → 态 7 / nextChapter=2；追加定稿章推 nextChapter） */
function makeShortStateBook(name: string): { manifestPath: string } {
  const root = join(workDir, name)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), `spec_version: 1\nkind: short\nbook:\n  title: ${name}\n  genre: 玄幻\nhost: cc\n`)
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), CH_FM(1, '开篇') + '主角登场。\n')
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null, finalizedRevision: 'sha256:' + 'a'.repeat(64), finalizedAt: '2026-08-29T00:00:00.000Z' })
  writeManifest(manifestPath, m)
  return { manifestPath }
}

/** 追加定稿章并登记清单（判态 nextChapter 前推的前提，r75 先例） */
function addFinalizedChapter(manifestPath: string, bookRoot: string, no: number, title: string, content: string): void {
  writeFileSync(join(bookRoot, '写作', '正文', `000${no}-${title}.md`), CH_FM(no, title) + content + '\n')
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: `写作/正文/000${no}-${title}.md`, parentId: null, finalizedRevision: 'sha256:' + 'b'.repeat(64), finalizedAt: '2026-08-29T00:00:00.000Z' })
  writeManifest(manifestPath, m)
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clw-r0912-ttl-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    [
      { name: STATE_BOOK, path: STATE_BOOK, kind: 'short' },
      { name: OVERVIEW_BOOK, path: OVERVIEW_BOOK, kind: 'short' },
      { name: TREE_BOOK, path: TREE_BOOK, kind: 'long' },
      { name: STYLE_BOOK, path: STYLE_BOOK, kind: 'long' },
      { name: LEARN_BOOK, path: LEARN_BOOK, kind: 'long' },
    ]
      .map((b) => JSON.stringify(b))
      .join('\n') + '\n',
  )

  const st = makeShortStateBook(STATE_BOOK)
  stateManifestPath = st.manifestPath
  const ov = makeShortStateBook(OVERVIEW_BOOK)
  overviewManifestPath = ov.manifestPath

  // 树红点书：硬禁词「玉佩」红章（造法同 tree-issues-api.test.ts / r75：标点夹持防
  // R29-1 汉字边界拦截）
  treeBookRoot = join(workDir, TREE_BOOK)
  mkdirSync(join(treeBookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(treeBookRoot, '项目'), { recursive: true })
  mkdirSync(join(treeBookRoot, '文风'), { recursive: true })
  writeFileSync(join(treeBookRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${TREE_BOOK}\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n`)
  writeFileSync(join(treeBookRoot, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n')
  writeFileSync(join(treeBookRoot, '写作', '正文', '0001-红章.md'), CH_FM(1, '红章') + '主角登场，玉佩，通体发亮。\n')
  const tm = readManifest(join(treeBookRoot, '项目', '文档清单.jsonl'))
  redDocId = generateDocId()
  upsertEntry(tm, { id: redDocId, nodeType: 'document', path: '写作/正文/0001-红章.md', parentId: null })
  writeManifest(join(treeBookRoot, '项目', '文档清单.jsonl'), tm)

  // 文风书（d3 先例：不建清单 → finalizedPathSet null 全量口径，章文件直接进样本）
  const styleRoot = join(workDir, STYLE_BOOK)
  mkdirSync(join(styleRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(styleRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${STYLE_BOOK}\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n`)
  writeFileSync(join(styleRoot, '写作', '正文', '0001-开篇.md'), CH_FM(1, '开篇') + '主角登场，初入宗门，一切由此开始。\n')

  // 收割书：金句特征句（hasHook 忽然/竟然 + hasEmotion 泪/恨；10-50 字单句各 1 条）
  const learnRoot = join(workDir, LEARN_BOOK)
  mkdirSync(join(learnRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(learnRoot, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${LEARN_BOOK}\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n`)
  writeFileSync(join(learnRoot, '写作', '正文', '0001-开篇.md'), CH_FM(1, '开篇') + '主角登场。\n他忽然停住脚步，泪水落了下来。\n')

  // 注入时钟（r75/R0911-G-P1-1c 先例：只接管 Date；TTL 全注短档）
  vi.useFakeTimers({ toFake: ['Date'] })
  __setStateTtlForTest(1000)
  __setTreeIssuesTtlForTest(1000)
  __setStyleScanTtlForTest(1000)
  __setLearnTtlForTest(1000)
  __setOverviewCacheTtlForTest(1000)
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  vi.useRealTimers()
  __setStateTtlForTest(null)
  __setTreeIssuesTtlForTest(null)
  __setStyleScanTtlForTest(null)
  __setLearnTtlForTest(null)
  __setOverviewCacheTtlForTest(null)
  const prevDriver = process.env['CLWRITING_DRIVER']
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === 'mock') delete process.env['CLWRITING_DRIVER']
})

// 慢推 6000（> 注入 TTL 1000，> overview 内层 stateCache 固定 TTL 5000）：
// 修复前 ts=捕获时刻 → 写后 6500 ≥ 任一 TTL 必 miss；修复后 ts=写入当刻 → 500 < TTL 命中。
const SLOW_MS = 6000
const HIT_ADVANCE_MS = 500

describe('R0912-B-P2-1：TTL 窗从写入当刻起算（五处）', () => {
  it('① /state：慢判态写缓存后 500ms 内命中（盘上新章不可见），过期后重算可见', async () => {
    slowAdvance.state = SLOW_MS
    const first = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    slowAdvance.state = 0
    expect(first.status).toBe(200)
    expect(first.json.nextChapter).toBe(2)

    // 盘上变更：新增定稿章（重算应见 nextChapter=3）
    addFinalizedChapter(stateManifestPath, join(workDir, STATE_BOOK), 2, '次章', '第二章登场。')

    // 写后 500ms（<TTL 1000）：命中缓存——nextChapter 仍 2（修复前 6500≥1000 必重算见 3）
    vi.advanceTimersByTime(HIT_ADVANCE_MS)
    const second = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    expect(second.status).toBe(200)
    expect(second.json.nextChapter).toBe(2)

    // 过期臂：再推 600ms（自写入起 1100 ≥ 1000）→ 重算见新章
    vi.advanceTimersByTime(600)
    const third = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    expect(third.status).toBe(200)
    expect(third.json.nextChapter).toBe(3)
  })

  it('② /overview 内层 stateCache：慢判态写缓存后 500ms 内命中旧判态（< 固定 TTL 5000）', async () => {
    slowAdvance.state = SLOW_MS
    const first = await get(`/api/books/${encodeURIComponent(OVERVIEW_BOOK)}/overview`)
    slowAdvance.state = 0
    expect(first.status).toBe(200)
    // 判态变体（态 3 handEdits / 态 7 nextChapter）随夹具确定，不钉具体形态——
    // 命中臂比整段恒等、重算臂比整段相异即可判别缓存行为
    expect(first.json.state).toBeTruthy()

    // 盘上变更（外层 sig 随之失效，内层 stateCache 是本测对象）
    addFinalizedChapter(overviewManifestPath, join(workDir, OVERVIEW_BOOK), 2, '次章', '第二章登场。')

    // 写后 500ms（< 内层固定 TTL 5000）：内层命中——判态段与首查逐字段相同
    //（修复前 6500 ≥ 5000 内层重算，新章会进 detail，判态段相异）
    vi.advanceTimersByTime(HIT_ADVANCE_MS)
    const second = await get(`/api/books/${encodeURIComponent(OVERVIEW_BOOK)}/overview`)
    expect(second.status).toBe(200)
    expect(second.json.state).toEqual(first.json.state)

    // 过期臂：推 5001（自写入起 5501 ≥ 5000）→ 内层重算见新章（判态段相异）
    vi.advanceTimersByTime(5001)
    const third = await get(`/api/books/${encodeURIComponent(OVERVIEW_BOOK)}/overview`)
    expect(third.status).toBe(200)
    expect(third.json.state).not.toEqual(first.json.state)
  })

  it('③ /tree-issues：慢聚合写缓存后 500ms 内命中（改净正文不可见），过期后重算可见', async () => {
    slowAdvance.tree = SLOW_MS
    const first = await get(`/api/books/${encodeURIComponent(TREE_BOOK)}/tree-issues`)
    slowAdvance.tree = 0
    expect(first.status).toBe(200)
    expect(first.json.issues[redDocId]).toEqual(expect.objectContaining({ hasRed: true }))

    // 盘上变更：正文洗净禁词
    writeFileSync(join(treeBookRoot, '写作', '正文', '0001-红章.md'), CH_FM(1, '红章') + '主角登场，霞光流转。\n')

    vi.advanceTimersByTime(HIT_ADVANCE_MS)
    const second = await get(`/api/books/${encodeURIComponent(TREE_BOOK)}/tree-issues`)
    expect(second.status).toBe(200)
    expect(second.json.issues[redDocId]).toEqual(expect.objectContaining({ hasRed: true }))

    vi.advanceTimersByTime(600)
    const third = await get(`/api/books/${encodeURIComponent(TREE_BOOK)}/tree-issues`)
    expect(third.status).toBe(200)
    expect(third.json.issues[redDocId]).toBeUndefined()
  })

  it('④ /health/style：慢扫描写缓存后 500ms 内命中（新增章不可见），过期后重算可见', async () => {
    slowAdvance.style = SLOW_MS
    const first = await get(`/api/books/${encodeURIComponent(STYLE_BOOK)}/health/style`)
    slowAdvance.style = 0
    expect(first.status).toBe(200)
    expect(first.json.count).toBe(1)

    // 盘上变更：新增 0002（重扫 count=2）
    writeFileSync(
      join(workDir, STYLE_BOOK, '写作', '正文', '0002-次章.md'),
      CH_FM(2, '次章') + '第二章正文登场。\n',
      'utf8',
    )

    vi.advanceTimersByTime(HIT_ADVANCE_MS)
    const second = await get(`/api/books/${encodeURIComponent(STYLE_BOOK)}/health/style`)
    expect(second.status).toBe(200)
    expect(second.json.count).toBe(1)

    vi.advanceTimersByTime(600)
    const third = await get(`/api/books/${encodeURIComponent(STYLE_BOOK)}/health/style`)
    expect(third.status).toBe(200)
    expect(third.json.count).toBe(2)
  })

  it('⑤ /learn：慢收割写缓存后 500ms 内命中（新增金句章不可见），过期后重算可见', async () => {
    slowAdvance.learn = SLOW_MS
    const first = await post(`/api/books/${encodeURIComponent(LEARN_BOOK)}/learn`)
    slowAdvance.learn = 0
    expect(first.status).toBe(200)
    expect(first.json.quotes).toHaveLength(1)

    // 盘上变更：新增带金句特征句的第 2 章（重割 quotes=2）
    writeFileSync(
      join(workDir, LEARN_BOOK, '写作', '正文', '0002-次章.md'),
      CH_FM(2, '次章') + '第二章推进。\n她竟然笑了，眼中却满是恨意。\n',
      'utf8',
    )

    vi.advanceTimersByTime(HIT_ADVANCE_MS)
    const second = await post(`/api/books/${encodeURIComponent(LEARN_BOOK)}/learn`)
    expect(second.status).toBe(200)
    expect(second.json.quotes).toHaveLength(1)

    vi.advanceTimersByTime(600)
    const third = await post(`/api/books/${encodeURIComponent(LEARN_BOOK)}/learn`)
    expect(third.status).toBe(200)
    expect(third.json.quotes).toHaveLength(2)
  })
})
