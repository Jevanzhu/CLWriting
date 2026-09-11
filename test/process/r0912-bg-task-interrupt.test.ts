/**
 * R0912-1（2026-09-11 修复批）回归：后台 AI 任务独立中断通道。
 *
 * 背景：两类后台任务（定稿摘要钩子 afterFinalizeGenerateSummary[Batch]；self-heal
 * pass 后账本推进草稿 self-heal exitPass）的 AI 调用没有可被 /interrupt 命中的在册
 * ctrl——前者根本不持 ctrl；后者持编排级 state.ctrl，而编排收尾后 running Map 已删
 * （self-heal.ts runSelfHealInner finally）、ctrl 已在 stream.ts unregister，/interrupt
 * 既找不到编排闸也无在册 ctrl，调用只能跑到 10min 总超时。
 *
 * 修复后统一走 summary.runRegisteredBgTask：启动处新建独立 AbortController 并
 * driver.registerCtrl(session, ctrl, 'bg-*:<bookName>')，settle（成功/失败/中断）
 * finally unregister；中断沿 ctrl.signal 即时收口（失败/中断按既有后台任务口径
 * 落账/落日志，不 crash）。本文件锁定：
 * 1. helper：登记（owner/session 逐项）→ ctrl.abort() → 后台任务尽快退出且 unregister；
 * 2. helper：真实 ccDriver + interrupt(session)（= /interrupt 端点同路径）→ 同上；
 * 3. helper：成功/失败 settle 均注销；失败拒绝传播（交调用方既有留痕口径）；
 * 4. 三个生产入口接线：定稿摘要单发/批量（owner 'bg-summary:<book>'）、self-heal
 *    exitPass（owner 'bg-lead-draft:<book>'）均以独立 ctrl 登记，settle 后注销且
 *    per-book 后台表清空。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runRegisteredBgTask,
  afterFinalizeGenerateSummary,
  afterFinalizeGenerateSummaryBatch,
} from '../../src/process/summary.js'
import { ccDriver } from '../../src/driver/cc.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import { hasBackgroundTasks, waitBackgroundTasks } from '../../src/ai/orchestrate/background.js'
import { runSelfHeal, type SelfHealOpts } from '../../src/ai/orchestrate/self-heal.js'
import { makeDualTrackWorkdir, tempUserData, LONG_BOOK } from '../studio/fixtures.js'
import { trackTempDir } from '../helpers/temp-dir.js'
import { waitFor } from '../helpers/wait-for.js'
import type { CheckOutcome } from '../../src/studio/server/api/check.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { saveDraft } from '../../src/studio/server/api/draft.js'

/** 挂在 signal 上的后台任务体：abort 前永不 settle（制造在途窗口），中断即退出 */
function hangingUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('已中断'))
      return
    }
    signal.addEventListener('abort', () => reject(new Error('已中断')), { once: true })
  })
}

/** 记录型 driver：register/unregister 逐笔留痕（供「注销的是同一把 ctrl」断言） */
function makeRecordingDriver(): {
  driver: StudioDriver
  registered: Array<{ session: Session; ctrl: AbortController; owner?: string }>
  unregistered: AbortController[]
} {
  const registered: Array<{ session: Session; ctrl: AbortController; owner?: string }> = []
  const unregistered: AbortController[] = []
  const driver: StudioDriver = {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'rec', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s: Session, _ev: DriverEvent): void {},
    registerCtrl(session, ctrl, owner) {
      registered.push({ session, ctrl, owner })
    },
    unregisterCtrl(_session, ctrl) {
      unregistered.push(ctrl)
    },
  }
  return { driver, registered, unregistered }
}

test('R0912-1: helper 登记 → ctrl.abort() → 后台任务尽快退出且 unregister（同一把 ctrl）', async () => {
  const { driver, registered, unregistered } = makeRecordingDriver()
  const session: Session = { id: 'r0912-bg-a', cwd: '/tmp', closed: false }
  const p = runRegisteredBgTask(driver, session, 'bg-lead-draft:测试书', hangingUntilAbort)
  await waitFor(() => registered.length === 1, 2000, 5, '后台 ctrl 登记')
  expect(registered[0]!.owner).toBe('bg-lead-draft:测试书')
  expect(registered[0]!.session).toBe(session)

  // 等价 /interrupt：对在册 ctrl abort
  registered[0]!.ctrl.abort()
  await expect(p).rejects.toThrow('已中断')
  // settle（中断）即注销，注销的是同一把 ctrl（晚到注销不抹他人登记的契约另行由 cc 测锁）
  expect(unregistered).toEqual([registered[0]!.ctrl])
})

test('R0912-1: 真实 ccDriver——interrupt(session)（/interrupt 同路径）中断后台任务并注销（isRunning 归 false）', async () => {
  const session: Session = { id: 'r0912-bg-b', cwd: '/tmp', closed: false }
  const unregistered: AbortController[] = []
  // register/unregister 桥接到真实 ccDriver（生产登记面），注销另留痕供断言
  const driver: StudioDriver = {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'bridge', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s: Session, _ev: DriverEvent): void {},
    registerCtrl: (s, c, o) => ccDriver.registerCtrl?.(s, c, o),
    unregisterCtrl: (s, c) => {
      unregistered.push(c)
      ccDriver.unregisterCtrl?.(s, c)
    },
  }
  const p = runRegisteredBgTask(driver, session, 'bg-summary:测试书', hangingUntilAbort)
  await waitFor(() => ccDriver.isRunning?.(session) === true, 2000, 5, '后台 ctrl 在册（isRunning 判真）')

  // /interrupt 端点对 session 调 driver.interrupt——abort 全部在册 ctrl
  ccDriver.interrupt?.(session)
  await expect(p).rejects.toThrow('已中断')
  await waitFor(() => unregistered.length === 1, 2000, 5, 'settle 注销')
  expect(ccDriver.isRunning?.(session)).toBe(false)
})

test('R0912-1: helper 成功/失败 settle 均注销；失败拒绝传播（调用方既有留痕口径消费）', async () => {
  const { driver, registered, unregistered } = makeRecordingDriver()
  const session: Session = { id: 'r0912-bg-c', cwd: '/tmp', closed: false }

  const okp = runRegisteredBgTask(driver, session, 'bg-summary:书A', async () => 'ok')
  await expect(okp).resolves.toBe('ok')
  expect(unregistered.length).toBe(1)

  const failp = runRegisteredBgTask(driver, session, 'bg-summary:书B', async () => {
    throw new Error('boom')
  })
  await expect(failp).rejects.toThrow('boom')
  expect(unregistered.length).toBe(2)
  expect(unregistered).toEqual(registered.map((r) => r.ctrl))
})

test('R0912-1: 定稿摘要钩子（单发/批量）以 bg-summary:<book> 独立登记，settle 后注销且后台表清空', async () => {
  const { driver, registered, unregistered } = makeRecordingDriver()
  const session: Session = { id: 'r0912-bg-d', cwd: '/tmp', closed: false }
  // 空 bookRoot（无 book.yaml）→ runFinalizeSummaryOnce 抛错走既有留痕口径后 settle——
  // 本测试只锁登记/注销接线，不锁摘要生成
  const bookRoot = mkdtempSync(join(tmpdir(), 'clw-r0912-hook-'))
  const book = '摘要钩子书'
  try {
    afterFinalizeGenerateSummary(bookRoot, null, 'doc-1', book, driver, session)
    expect(hasBackgroundTasks(book)).toBe(true)
    await waitFor(() => unregistered.length >= 1, 3000, 10, '单发钩子 settle 注销')
    expect(registered[0]!.owner).toBe(`bg-summary:${book}`)
    expect(registered[0]!.session).toBe(session)
    await waitBackgroundTasks(book)
    expect(hasBackgroundTasks(book)).toBe(false)

    afterFinalizeGenerateSummaryBatch(bookRoot, null, ['doc-1', 'doc-2'], book, driver, session)
    await waitFor(() => unregistered.length >= 2, 3000, 10, '批量钩子 settle 注销')
    expect(registered[1]!.owner).toBe(`bg-summary:${book}`)
    await waitBackgroundTasks(book)
    expect(hasBackgroundTasks(book)).toBe(false)
  } finally {
    rmSync(bookRoot, { recursive: true, force: true })
  }
})

// ── 生产入口三：self-heal exitPass（账本推进草稿）────────────────────────────

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

test('R0912-1: self-heal pass → 账本草稿后台任务以 bg-lead-draft:<book> 独立登记，settle 后注销', async () => {
  // 长篇夹具带 布线/ → exitPass 触发账本草稿后台任务（ud 空 → 取 provider 失败快速留痕收口）
  const workDir = trackTempDir(makeDualTrackWorkdir())
  const ud = trackTempDir(tempUserData())
  const bookRoot = join(workDir, '长篇', LONG_BOOK)
  const registered: Array<{ session: Session; ctrl: AbortController; owner?: string }> = []
  const unregistered: AbortController[] = []
  const driver: StudioDriver = {
    ...makeEmitDriver([]),
    registerCtrl(session, ctrl, owner) {
      registered.push({ session, ctrl, owner })
    },
    unregisterCtrl(_session, ctrl) {
      unregistered.push(ctrl)
    },
  }
  const FM = '---\n章号: 1\n标题: 测试章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n'
  const save: typeof saveDraft = async (_root, _ch, content) => ({
    relPath: '工作区/草稿-1.md',
    docId: 'doc-长篇-1',
    words: content.length,
    snapshotted: false,
  })
  const check = (): CheckOutcome => ({ ok: true, report: { sections: [] }, hasRed: false, chapter: META, body: '正文' })
  const genFn: NonNullable<SelfHealOpts['genFn']> = async (_p, _k, _s, onText) => {
    onText?.(FM + '正文')
    return FM + '正文'
  }
  // 长篇夹具带 布线/ → exitPass 触发账本草稿后台任务（ud 空 → 取 provider 失败快速留痕收口）
  const r = await runSelfHeal({
    driver,
    mainSession: { id: 'main', cwd: workDir, closed: false },
    userDataPath: ud,
    cwd: workDir,
    bookRoot,
    bookName: LONG_BOOK,
    chapter: 1,
    check,
    save,
    genFn,
  })
  expect(r.outcome).toBe('pass')
  // pass 收尾即登记独立 ctrl（owner 带书维度，与 'self-heal' 槽位互不抢占）
  const bg = registered.find((x) => x.owner === `bg-lead-draft:${LONG_BOOK}`)
  expect(bg).toBeDefined()
  expect(bg!.session.id).toBe('main')
  // 不再持编排级 ctrl：登记的是 helper 新建的控制器（编排本体未走 register 通道）
  await waitFor(() => unregistered.includes(bg!.ctrl), 3000, 10, '后台草稿任务 settle 注销')
  await waitBackgroundTasks(LONG_BOOK)
  expect(hasBackgroundTasks(LONG_BOOK)).toBe(false)
})
