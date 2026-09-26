/**
 * R0916-7-P3-12（2026-09-25 源码质量评审 P3-12）：忙闸互斥矩阵表驱动回归。
 *
 * P3-12 前「哪类在途活动拦哪个端点、拦下说什么话」散在 7 处手写（stream 的 spawn/
 * auto-write、chat、audit 的清库族、books-lifecycle 的删/改名、documents-core 的结构
 * 操作、review 三审、task-gate 的编排闸），已见漂移（同一句文案一处半角一处全角、
 * review 书级闸文案与成因不符）。收敛后单源 = task-gate.ts 的 `busyReason(book, intent)`
 * （表 BUSY_MATRIX：行 = 意图，列 = 在途信号，表内顺序即判定顺序）。
 *
 * 本文件按「表格本人写」的方式做逐格验证：
 * - 期望矩阵是下方 EXP 的**独立字面量**（不引 src 的表）——src 漏格/多格/改序/改文案，红；
 * - 单元层逐格：单信号置位 → busyReason 返回该格文案；信号置在他书 → null（不同书不互斥）；
 *   行内缺格 → 不拦；全信号置位 → 按行内序命中首格（判定顺序钉定）；
 * - 端点层逐格：每个意图的真实端点在被拦时回 409 + 该格文案（证明端点确实走单源、没有
 *   自留手写闸）；放行臂逐格验证「信号置在他书 → 该端点照常落到后续校验」。
 *
 * 信号制造方式：self-heal / spawn / review / task-gate 走生产侧测试注入口或真实占闸；
 * 后台收尾用 registerBackgroundTask 真登记；chat 无注入口（ai 层不在本批改动面）→
 * vi.mock isChatRunning（按书判定，保证「不同书」可比）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootStudio, type StudioHarness, type StudioReqResult } from '../helpers/studio-server.js'
import { readManifest, upsertEntry, writeManifest } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import {
  acquireTaskGate,
  busyReason,
  __setReviewRunning,
  REVIEW_BUSY_TEXT,
  type BusyIntent,
  type BusySignal,
} from '../../src/studio/server/api/task-gate.js'
import { __setSelfHealRunningForTest } from '../../src/ai/orchestrate/self-heal.js'
import { __setSpawnRunning } from '../../src/ai/orchestrate/spawn-registry.js'
import { registerBackgroundTask, waitBackgroundTasks } from '../../src/ai/orchestrate/background.js'

const chatBooks = vi.hoisted(() => new Set<string>())
vi.mock('../../src/ai/orchestrate/chat.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/orchestrate/chat.js')>()
  return { ...orig, isChatRunning: (b: string) => chatBooks.has(b) }
})

const BOOK = '矩阵主书'
const OTHER = '矩阵旁书' // 不同书不互斥的对照书
const THROWAWAY_DEL = '矩阵一次性删书'
const THROWAWAY_RENAME = '矩阵一次性改名书'
const PROBE_DOC = 'doc_matrix0000000000000000000'

const SIGNAL_TEXT: Record<BusySignal, string> = {
  'self-heal': '本书正在全自动写章，先等它跑完或中断',
  chat: '本书对话进行中，先等它结束或中断',
  spawn: '本书正在手动写稿，先等它跑完或中断',
  'task-gate': '本书有任务在跑（outline），先等它完成或中断',
  review: '本书三审进行中，先等它完成',
  background: '本书有后台任务收尾中（如定稿摘要），稍等片刻',
}
const TAIL: Record<BusyIntent, string> = {
  spawn: '再手动写稿',
  'auto-write': '再自动写章',
  chat: '再对话',
  generate: '再生成',
  structure: '再做结构操作',
  'book-delete': '后再删',
  'book-rename': '后再改名',
  'clear-chat': '后再清空对话',
  'clear-events': '后再清除事件史',
  review: '再发起三审',
  rewrite: '再发起改写',
  'draft-save': '再保存草稿',
}
const ALL_SIGNALS: readonly BusySignal[] = ['self-heal', 'chat', 'spawn', 'task-gate', 'review', 'background']

/** 期望矩阵（独立字面量）：意图 → 行内有序格（信号 + 该格完整文案）。 */
const EXP: Array<{ intent: BusyIntent; cells: Array<{ signal: BusySignal; text: string }> }> = [
  {
    intent: 'spawn',
    cells: [
      // 自身面：写手在途的自查文案（不论述「等完之后再做什么」）
      { signal: 'spawn', text: '本书正在生成（手动写稿），先等它跑完或中断' },
      { signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL.spawn },
      { signal: 'chat', text: SIGNAL_TEXT.chat + TAIL.spawn },
      { signal: 'task-gate', text: SIGNAL_TEXT['task-gate'] + TAIL.spawn },
      { signal: 'review', text: SIGNAL_TEXT.review + TAIL.spawn },
    ],
  },
  {
    intent: 'auto-write',
    cells: [
      { signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL['auto-write'] },
      { signal: 'chat', text: SIGNAL_TEXT.chat + TAIL['auto-write'] },
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL['auto-write'] },
      { signal: 'task-gate', text: SIGNAL_TEXT['task-gate'] + TAIL['auto-write'] },
    ],
  },
  {
    intent: 'chat',
    cells: [
      { signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL.chat },
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL.chat },
      { signal: 'task-gate', text: SIGNAL_TEXT['task-gate'] + TAIL.chat },
    ],
  },
  {
    intent: 'generate',
    cells: [
      { signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL.generate },
      { signal: 'chat', text: SIGNAL_TEXT.chat + TAIL.generate },
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL.generate },
      { signal: 'background', text: SIGNAL_TEXT.background + TAIL.generate },
    ],
  },
  {
    intent: 'structure',
    cells: [
      { signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL.structure },
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL.structure },
      { signal: 'chat', text: SIGNAL_TEXT.chat + TAIL.structure },
      { signal: 'background', text: SIGNAL_TEXT.background + TAIL.structure },
      { signal: 'review', text: SIGNAL_TEXT.review + TAIL.structure },
    ],
  },
  {
    intent: 'book-delete',
    cells: [
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL['book-delete'] },
      { signal: 'review', text: SIGNAL_TEXT.review + TAIL['book-delete'] },
      { signal: 'task-gate', text: SIGNAL_TEXT['task-gate'] + TAIL['book-delete'] },
    ],
  },
  {
    intent: 'book-rename',
    cells: [
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL['book-rename'] },
      { signal: 'review', text: SIGNAL_TEXT.review + TAIL['book-rename'] },
      { signal: 'task-gate', text: SIGNAL_TEXT['task-gate'] + TAIL['book-rename'] },
    ],
  },
  {
    intent: 'clear-chat',
    cells: [
      { signal: 'chat', text: SIGNAL_TEXT.chat + TAIL['clear-chat'] },
      { signal: 'task-gate', text: SIGNAL_TEXT['task-gate'] + TAIL['clear-chat'] },
      { signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL['clear-chat'] },
      { signal: 'review', text: SIGNAL_TEXT.review + TAIL['clear-chat'] },
      { signal: 'background', text: SIGNAL_TEXT.background + TAIL['clear-chat'] },
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL['clear-chat'] },
    ],
  },
  {
    intent: 'clear-events',
    cells: [
      { signal: 'chat', text: SIGNAL_TEXT.chat + TAIL['clear-events'] },
      { signal: 'task-gate', text: SIGNAL_TEXT['task-gate'] + TAIL['clear-events'] },
      { signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL['clear-events'] },
      { signal: 'review', text: SIGNAL_TEXT.review + TAIL['clear-events'] },
      { signal: 'background', text: SIGNAL_TEXT.background + TAIL['clear-events'] },
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL['clear-events'] },
    ],
  },
  {
    intent: 'review',
    cells: [
      { signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL.review },
      { signal: 'chat', text: SIGNAL_TEXT.chat + TAIL.review },
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL.review },
      { signal: 'background', text: SIGNAL_TEXT.background + TAIL.review },
    ],
  },
  {
    intent: 'rewrite',
    cells: [
      { signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL.rewrite },
      { signal: 'spawn', text: SIGNAL_TEXT.spawn + TAIL.rewrite },
    ],
  },
  {
    intent: 'draft-save',
    cells: [{ signal: 'self-heal', text: SIGNAL_TEXT['self-heal'] + TAIL['draft-save'] }],
  },
]
const cellsOf = (intent: BusyIntent) => EXP.find((r) => r.intent === intent)!.cells

/** 置位一个信号（返回复位函数）。每例 try/finally 复位，防串味。 */
async function setSignal(signal: BusySignal, book: string): Promise<() => Promise<void>> {
  switch (signal) {
    case 'self-heal':
      __setSelfHealRunningForTest(book, true)
      return async () => __setSelfHealRunningForTest(book, false)
    case 'chat':
      chatBooks.add(book)
      return async () => {
        chatBooks.delete(book)
      }
    case 'spawn':
      __setSpawnRunning(book, true)
      return async () => __setSpawnRunning(book, false)
    case 'review':
      __setReviewRunning(book, true)
      return async () => __setReviewRunning(book, false)
    case 'background': {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      registerBackgroundTask(
        book,
        gate.then(
          () => undefined,
          () => undefined,
        ),
      )
      return async () => {
        release()
        await waitBackgroundTasks(book)
      }
    }
    case 'task-gate': {
      const release = acquireTaskGate(book, 'outline')
      expect(release, '占闸失败：上一用例未复位？').not.toBeNull()
      return async () => release!()
    }
  }
}

async function withSignal<T>(signal: BusySignal, book: string, fn: () => Promise<T>): Promise<T> {
  const off = await setSignal(signal, book)
  try {
    return await fn()
  } finally {
    await off()
  }
}

let studio: StudioHarness
let userDataPath = ''
const enc = (s: string): string => encodeURIComponent(s)

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-busy-matrix-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-busy-matrix-',
    userDataPath,
    env: { CLWRITING_DRIVER: 'mock' }, // 放行臂落到 mock 快路（不起真实 provider）
    dirs: ['写作/正文'],
    bookYaml:
      ['spec_version: 1', 'kind: long', 'book:', `  title: ${BOOK}`, '  genre: 玄幻', 'host: cc'].join('\n') + '\n',
  })
  // 只预建对照书：一次性删/改名书由各自放行臂逐格现建（建-用-销，重复建会同名 400）
  const r = await studio.req('POST', '/api/books', { name: OTHER, kind: 'long', genre: '玄幻' })
  expect(r.status, `建书失败：${OTHER}`).toBe(200)
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

// ── 单元层：矩阵逐格 ────────────────────────────────────────────────
for (const row of EXP) {
  describe(`矩阵行 ${row.intent}`, () => {
    for (const cell of row.cells) {
      it(`信号 ${cell.signal} 单置位 → 该格文案`, async () => {
        await withSignal(cell.signal, BOOK, async () => {
          expect(busyReason(BOOK, row.intent)).toBe(cell.text)
        })
      })
      it(`信号 ${cell.signal} 置在他书 → 不互斥（null）`, async () => {
        await withSignal(cell.signal, OTHER, async () => {
          expect(busyReason(BOOK, row.intent)).toBeNull()
        })
      })
    }
    for (const signal of ALL_SIGNALS.filter((s) => !row.cells.some((c) => c.signal === s))) {
      it(`缺格：信号 ${signal} 不在本行 → 不拦（null）`, async () => {
        await withSignal(signal, BOOK, async () => {
          expect(busyReason(BOOK, row.intent)).toBeNull()
        })
      })
    }
    it('全信号置位 → 按行内序命中首格（判定顺序钉定）', async () => {
      const offs: Array<() => Promise<void>> = []
      for (const s of ALL_SIGNALS) offs.push(await setSignal(s, BOOK))
      try {
        expect(busyReason(BOOK, row.intent)).toBe(row.cells[0]!.text)
      } finally {
        for (const off of offs.reverse()) await off()
      }
    })
  })
}

// ── 端点层：真实端点走单源（被拦时 409 + 该格文案）────────────────────
interface ProbeRow {
  intent: BusyIntent
  /** 被拦臂：有效请求（必须真到达闸——不能被 parse/校验提前挡掉） */
  blocked: () => Promise<StudioReqResult>
  /** 被拦臂的状态码机器码（编排/任务闸一律 BUSY；三审书级闸 REVIEW_BUSY，见其语义用例） */
  code: string
  /** 放行臂：把信号置在他书后请求本书端点，期望落到后续校验（signal 供需唯一命名的臂用） */
  pass?: { run: (signal: BusySignal) => Promise<StudioReqResult>; status: number }
}

const PROBES: ProbeRow[] = [
  {
    intent: 'spawn',
    code: 'BUSY',
    blocked: () => studio.req('POST', `/api/books/${enc(BOOK)}/spawn`, { role: 'writer', prompt: '写第一章' }),
    // 放行臂用空 prompt 落 400（不真起写手）
    pass: {
      run: () => studio.req('POST', `/api/books/${enc(BOOK)}/spawn`, { role: 'writer', prompt: '' }),
      status: 400,
    },
  },
  {
    intent: 'auto-write',
    code: 'BUSY',
    blocked: () => studio.req('POST', `/api/books/${enc(BOOK)}/auto-write`, { chapter: 1 }),
    // 放行臂省 chapter 落 400（不真起 self-heal）
    pass: { run: () => studio.req('POST', `/api/books/${enc(BOOK)}/auto-write`, {}), status: 400 },
  },
  {
    intent: 'chat',
    code: 'BUSY',
    // 放行臂缺失：chat.send 走 defineRoute parse（parse 先于 handler），合法 body 缺一不可，
    // 而合法 body 在放行时会真起一轮 mock 对话——「不同书不互斥」面由上方单元层覆盖
    blocked: () => studio.req('POST', `/api/books/${enc(BOOK)}/chat`, { message: '你好' }),
  },
  {
    intent: 'generate',
    code: 'BUSY',
    blocked: () => studio.req('POST', `/api/books/${enc(BOOK)}/outline`, { chapter: 1 }),
    pass: { run: () => studio.req('POST', `/api/books/${enc(BOOK)}/outline`, { chapter: 1 }), status: 200 },
  },
  {
    intent: 'structure',
    code: 'BUSY',
    blocked: () =>
      studio.req('POST', `/api/books/${enc(BOOK)}/documents/x/structure-apply`, {
        op: 'merge',
        sourceDocId: 's',
        planHash: 'p',
      }),
    // 放行臂：dummy docId 越过忙闸 → 文档解析 404（忙闸不是这里的第一道门）
    pass: {
      run: () =>
        studio.req('POST', `/api/books/${enc(BOOK)}/documents/x/structure-apply`, {
          op: 'merge',
          sourceDocId: 's',
          planHash: 'p',
        }),
      status: 404,
    },
  },
  {
    intent: 'book-delete',
    code: 'BUSY',
    blocked: () => studio.req('DELETE', `/api/books/${enc(BOOK)}`),
    // 放行臂：每格新建一次性书再删（他书闸不该拦本书删除）
    pass: {
      run: async () => {
        expect(
          (await studio.req('POST', '/api/books', { name: THROWAWAY_DEL, kind: 'long', genre: '玄幻' })).status,
        ).toBe(200)
        return studio.req('DELETE', `/api/books/${enc(THROWAWAY_DEL)}`)
      },
      status: 200,
    },
  },
  {
    intent: 'book-rename',
    code: 'BUSY',
    blocked: () => studio.req('POST', `/api/books/${enc(BOOK)}/rename`, { name: '矩阵主书新名' }),
    // 放行臂：改名会搬目录且目标名已存在即 400——每格现建一次性书 + 逐格唯一目标名
    pass: {
      run: async (signal) => {
        expect(
          (await studio.req('POST', '/api/books', { name: THROWAWAY_RENAME, kind: 'long', genre: '玄幻' })).status,
        ).toBe(200)
        return studio.req('POST', `/api/books/${enc(THROWAWAY_RENAME)}/rename`, {
          name: `矩阵一次性改名新名-${signal}`,
        })
      },
      status: 200,
    },
  },
  {
    intent: 'clear-events',
    code: 'BUSY',
    blocked: () => studio.req('DELETE', `/api/books/${enc(BOOK)}/audit`),
    pass: { run: () => studio.req('DELETE', `/api/books/${enc(BOOK)}/audit`), status: 200 },
  },
  {
    intent: 'clear-chat',
    code: 'BUSY',
    blocked: () => studio.req('POST', `/api/books/${enc(BOOK)}/chat/clear`),
    pass: { run: () => studio.req('POST', `/api/books/${enc(BOOK)}/chat/clear`), status: 200 },
  },
  {
    intent: 'review',
    code: 'BUSY',
    blocked: () => studio.req('POST', `/api/books/${enc(BOOK)}/documents/${PROBE_DOC}/review`, {}),
    // 放行臂：越过忙闸 → 未登记 docId 404
    pass: { run: () => studio.req('POST', `/api/books/${enc(BOOK)}/documents/${PROBE_DOC}/review`, {}), status: 404 },
  },
  {
    intent: 'rewrite',
    code: 'BUSY',
    blocked: () => studio.req('POST', `/api/books/${enc(BOOK)}/documents/x/rewrite`, { instruction: '润色' }),
    // 放行臂：越过忙闸 → 空 instruction 落 400（不真起改写）
    pass: { run: () => studio.req('POST', `/api/books/${enc(BOOK)}/documents/x/rewrite`, {}), status: 400 },
  },
  {
    intent: 'draft-save',
    code: 'BUSY',
    blocked: () => studio.req('POST', `/api/books/${enc(BOOK)}/draft-save`, { chapter: 1, content: '正文' }),
    // 放行臂：越过忙闸 → chapter 非正整数落 400
    pass: { run: () => studio.req('POST', `/api/books/${enc(BOOK)}/draft-save`, {}), status: 400 },
  },
]

for (const row of PROBES) {
  describe(`端点接线 ${row.intent}`, () => {
    for (const cell of cellsOf(row.intent)) {
      it(`信号 ${cell.signal} 置位 → 409 + 该格文案`, async () => {
        await withSignal(cell.signal, BOOK, async () => {
          const r = await row.blocked()
          expect(r.status, JSON.stringify(r.json)).toBe(409)
          expect((r.json as { code: string }).code).toBe(row.code)
          expect((r.json as { error: string }).error).toBe(cell.text)
        })
      })
    }
    if (row.pass) {
      it('逐格：信号置在他书 → 不互斥（落到后续校验）', async () => {
        const passRow = row.pass!
        for (const cell of cellsOf(row.intent)) {
          await withSignal(cell.signal, OTHER, async () => {
            const r = await passRow.run(cell.signal)
            expect(r.status, `${cell.signal}: ${JSON.stringify(r.json)}`).toBe(passRow.status)
          })
        }
      })
    }
  })
}

// ── 三审的按文档闸 / 书级闸语义（P3-12 文案修正面）────────────────────
describe('三审闸语义（按文档闸先于书级闸）', () => {
  const reviewUrl = (doc: string): string => `/api/books/${enc(BOOK)}/documents/${doc}/review`
  let docA = ''
  let docB = ''

  beforeAll(() => {
    // 三审端点的按文档闸在 docId 解析（清单登记 + 文件存在）之后——用例须用真登记的稿
    // （未登记 docId 会先落 404，压根到不了闸，钉不住闸的响应形状）
    mkdirSync(join(studio.bookRoot, '定稿', '正文'), { recursive: true })
    const drafts: Array<[string, number, string]> = [
      ['定稿/正文/0001-开篇.md', 1, '开篇'],
      ['定稿/正文/0002-次章.md', 2, '次章'],
    ]
    for (const [file, ch, title] of drafts) {
      writeFileSync(
        join(studio.bookRoot, file),
        `---\n章号: ${ch}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。\n`,
        'utf8',
      )
    }
    const m = readManifest(join(studio.bookRoot, '项目', '文档清单.jsonl'))
    docA = generateDocId()
    docB = generateDocId()
    upsertEntry(m, { id: docA, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
    upsertEntry(m, { id: docB, nodeType: 'document', path: '定稿/正文/0002-次章.md', parentId: null })
    writeManifest(join(studio.bookRoot, '项目', '文档清单.jsonl'), m)
  })

  it('同文档三审在跑 → 409 REVIEW_RUNNING（文档级文案，点名该文档）', async () => {
    __setReviewRunning(BOOK, true, docA)
    try {
      const r = await studio.req('POST', reviewUrl(docA), {})
      expect(r.status, JSON.stringify(r.json)).toBe(409)
      expect((r.json as { code: string }).code).toBe('REVIEW_RUNNING')
      expect((r.json as { error: string }).error).toContain('该文档三审进行中')
    } finally {
      __setReviewRunning(BOOK, false, docA)
    }
  })

  it('同书另一文档三审在跑 → 409 REVIEW_BUSY，文案点名「三审在跑」不再说「其他任务在跑」', async () => {
    // 在途三审的真实形态：按文档登记（另一文档）+ 占 (book,'review') 闸
    __setReviewRunning(BOOK, true, docB)
    const release = acquireTaskGate(BOOK, 'review')
    expect(release).not.toBeNull()
    try {
      const r = await studio.req('POST', reviewUrl(docA), {})
      expect(r.status, JSON.stringify(r.json)).toBe(409)
      expect((r.json as { code: string }).code).toBe('REVIEW_BUSY')
      expect((r.json as { error: string }).error).toBe(REVIEW_BUSY_TEXT)
      expect((r.json as { error: string }).error).toContain('三审在跑')
      expect((r.json as { error: string }).error).not.toContain('其他任务在跑')
    } finally {
      release!()
      __setReviewRunning(BOOK, false, docB)
    }
  })

  it('他进程持 (book,review) 锁（本进程无登记）→ 同码同文案（跨进程持有者只在此路径可见）', async () => {
    const release = acquireTaskGate(BOOK, 'review')
    expect(release).not.toBeNull()
    try {
      const r = await studio.req('POST', reviewUrl(docA), {})
      expect(r.status, JSON.stringify(r.json)).toBe(409)
      expect((r.json as { code: string }).code).toBe('REVIEW_BUSY')
      expect((r.json as { error: string }).error).toBe(REVIEW_BUSY_TEXT)
    } finally {
      release!()
    }
  })

  it('别的 action 的闸在持 → 不拦三审（矩阵 review 行不含「任意任务闸」列）', async () => {
    const release = acquireTaskGate(BOOK, 'rag-build')
    expect(release).not.toBeNull()
    try {
      // 未登记 docId：越过忙闸即落 404（若 rag-build 闸误拦会是 409）
      const r = await studio.req('POST', `/api/books/${enc(BOOK)}/documents/${PROBE_DOC}/review`, {})
      expect(r.status, JSON.stringify(r.json)).toBe(404)
    } finally {
      release!()
    }
  })
})
