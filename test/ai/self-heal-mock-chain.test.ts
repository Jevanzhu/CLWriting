/**
 * A2（五十九轮）回归：self-heal mock 快路补链路事件与记账口径。
 *
 * 修复背景：runGenerate 的本地 mock 快路（tryMockTool 短路）绕过 runTask——mock 回合
 * 零链路事件（step/start + llm/call + step/end，与 P3-6 目标矛盾）、零记账，是审计
 * 黑洞。修复后撤销本地短路，改走 runSpec——runTask 的 mockTool 快路与真实链路同口径
 * 记链路事件；流式预览改由成功产出后补发（观感口径不变）。
 */
import { test, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeDualTrackWorkdir, tempUserData, SHORT_BOOK } from '../studio/fixtures.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'

const dirs: string[] = []

const META: ChapterMeta = {
  章号: 1,
  标题: '测试章',
  钩子类型: '悬念钩',
  钩子强弱: '中',
  情绪定位: '铺垫',
}

function makeEmitDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      emitted.push(ev)
    },
  }
}

test('A2: mock 快路走 runSpec 统一通道——链路事件（step/llm）落库 + 流式预览补发', async () => {
  const workDir = makeDualTrackWorkdir()
  const ud = tempUserData()
  dirs.push(workDir, ud)
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  const emitted: DriverEvent[] = []
  const saves: string[] = []
  const save: typeof saveDraft = async (_root, _ch, content) => {
    saves.push(content)
    return { relPath: '工作区/草稿-1.md', docId: 'doc-短篇-1', words: content.length, snapshotted: false }
  }
  const check = (): CheckOutcome => ({ ok: true, report: { sections: [] }, hasRed: false, chapter: META, body: '正文' })

  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    const opts: SelfHealOpts = {
      driver: makeEmitDriver(emitted),
      mainSession: { id: 'main', cwd: bookRoot, closed: false },
      userDataPath: ud,
      cwd: bookRoot,
      bookRoot,
      bookName: SHORT_BOOK,
      chapter: 1,
      check,
      save,
      // 不传 genFn：走 runSpec → runTask 的 mockTool 快路（本次修复的通道）
    }
    const r = await runSelfHeal(opts)
    expect(r.outcome).toBe('pass')

    // ① 链路事件：mock 回合不再零事件——step/start + llm/call（model=mock）+ step/end 落库
    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents(bookHash(bookRoot))
      const types = evs.map((e) => e.type)
      expect(types).toContain('step/start')
      expect(types).toContain('step/end')
      const call = evs.find((e) => e.type === 'llm/call') as { data?: { model?: string } } | undefined
      expect(call).toBeDefined()
      expect(call!.data!.model).toBe('mock')
    } finally {
      store.close()
    }

    // ② 流式预览补发：前端仍能逐段看到 mock 产出（原本地快路的 emit 口径）
    const textDeltas = emitted.filter((e) => e.type === 'text').map((e) => (e as { text?: string }).text ?? '')
    expect(textDeltas.join('')).toContain('mock 自动写章产出的章节正文')
  } finally {
    delete process.env['CLWRITING_DRIVER']
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  }
})

// ── R65-8（总六十五轮）：persistFinal 无守卫 → goal 'active' 悬挂 ──
// 修复背景：exitPass/exitEscalateBlocked 的 persistFinal() 抛错（磁盘满/库锁）时
// writeTodos/writeGoal 永不执行，事件链上 goal 永远 'active'。修复后失败仍走
// writeGoal 终态（block/blocked + blockedReason='persist-failed'）再记 failed 出口。
test('R65-8: persistFinal 抛错 → 链上仍有 goal 终态（blocked/persist-failed），outcome=failed', async () => {
  const workDir = makeDualTrackWorkdir()
  const ud = tempUserData()
  dirs.push(workDir, ud)
  const bookRoot = join(workDir, '短篇', SHORT_BOOK)
  const emitted: DriverEvent[] = []
  // save 注入：首稿落盘成功（第 1 次），exitPass 的 persistFinal（第 2 次）抛错
  let saveCalls = 0
  const save: typeof saveDraft = async (_root, _ch, content) => {
    saveCalls++
    if (saveCalls >= 2) throw new Error('disk full (mock)')
    return { relPath: '工作区/草稿-1.md', docId: 'doc-短篇-1', words: content.length, snapshotted: false }
  }
  const check = (): CheckOutcome => ({ ok: true, report: { sections: [] }, hasRed: false, chapter: META, body: '正文' })

  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    const r = await runSelfHeal({
      driver: makeEmitDriver(emitted),
      mainSession: { id: 'main', cwd: bookRoot, closed: false },
      userDataPath: ud,
      cwd: bookRoot,
      bookRoot,
      bookName: SHORT_BOOK,
      chapter: 1,
      check,
      save,
    })
    // 终稿未落盘 → failed 出口（不假报 pass），错误文案带落盘失败语义
    expect(r.outcome).toBe('failed')
    if (r.outcome === 'failed') expect(r.error).toContain('终稿落盘失败')

    // 链上终态：最后一个 goal/change 是 block/blocked + blockedReason='persist-failed'
    //（修复前 persistFinal 裸穿，writeGoal 永不执行 → goal 悬挂 'active'）
    const store = openSessionStore(ud, bookRoot)!
    try {
      const goals = store.listEvents(bookHash(bookRoot)).filter((e) => e.type === 'goal/change')
      expect(goals.length).toBeGreaterThanOrEqual(2)
      const last = goals.at(-1)!.data as { operation?: string; goal?: { state?: string; blockedReason?: string } }
      expect(last.operation).toBe('block')
      expect(last.goal?.state).toBe('blocked')
      expect(last.goal?.blockedReason).toBe('persist-failed')
    } finally {
      store.close()
    }
  } finally {
    delete process.env['CLWRITING_DRIVER']
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  }
})
