/**
 * R26-19（二十六轮）回归——章摘要生成跨进程互斥锁 + 去重命中 skipped 语义：
 * - 锁被占（他进程持锁：预置活 pid 锁文件，与锁原语 judgeStaleLock 的 'held' 判定同口径）：
 *   第二调用方得 { ok: true, skipped: true } 且**不调 AI**（桩计数=0）——GUI+CLI 双开同书
 *   不再重复调 AI 重复计费，也不再误报失败（R26-101 同步闭合）。
 * - 正常路径不回归：锁空闲时照常生成落盘（skipped=false）；fresh 短路 skipped=true；
 *   锁文件释放干净不残留。
 * - 同进程并发去重（inFlight）命中同样 skipped（语义=他人正在生成，非失败）。
 *
 * AI 侧 runSpec 用桩替换（不可控真快路无法制造持锁/在途窗口）。
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { generateChapterSummary, chapterSummaryPath, __setSummaryGenerateLockTimeoutForTest } from '../../src/process/summary.js'
import { sweepAbandonedTmpFiles } from '../../src/fs/atomic.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// 桩计数 + 可控放行门：引用在 runSpec **调用时**才解引用（vi.mock 工厂提升安全，同
// summary-volume-inflight.test.ts 惯例）；被锁/inFlight 挡住的调用方不进桩，计数不增。
const state: { calls: number; release: (() => void) | null; hold: boolean } = { calls: 0, release: null, hold: false }
vi.mock('../../src/ai/tasks/spec.js', () => ({
  runSpec: vi.fn(async (_spec: unknown, opts: { userPrompt: string }) => {
    state.calls++
    if (opts.userPrompt.includes('写章摘要') && state.hold) {
      // 主评审核销修正：挂起门由 state.hold 显式开启——原版对一切「写章摘要」调用
      // 无条件挂起，「锁空闲正常路径」用例因此永挂 30s 超时（无人 release）。
      await new Promise<void>((r) => {
        state.release = r
      })
    }
    return { ok: true, data: { text: '情节推进：主角登场。\n账本变动：无。\n章尾钩子：玉佩再响。' }, model: 'mock' }
  }),
}))

// 锁等待档注入缩短：持锁窗口可控，等待方快速拿到 skipped 语义（R28-15 起生产档为 0
// 非阻塞 try-acquire，此处注入 150 只是本文件用例的等待上限口径，不影响断言面）
beforeEach(() => {
  __setSummaryGenerateLockTimeoutForTest(150)
  state.calls = 0
  state.release = null
  state.hold = false
})

/** 单章书夹具（generateChapterSummary 直调不读清单，最小文件集即可） */
function makeBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'clw-r26-sumlock-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '001-第1章.md'),
    '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第1章正文。\n',
    'utf-8',
  )
  return root
}

const bodyOf = (root: string): string => join(root, '写作', '正文', '001-第1章.md')

describe('R26-19: 章摘要跨进程锁', () => {
  test('锁被占（他进程活 pid 锁文件）：本调用方 skipped=true 且未调 AI（桩计数=0），不落盘', async () => {
    const root = makeBook()
    try {
      state.hold = true // 桩挂起门开：AI 调用停在在途（本用例不需要它完成）
      // 模拟他进程持锁：预置本进程活 pid 的锁文件（judgeStaleLock 判 'held'，不接管）
      const lockPath = join(root, '工作区', '.摘要锁-章1.lock')
      mkdirSync(join(root, '工作区'), { recursive: true })
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: Date.now() }), 'utf-8')
      const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root) })
      expect(r.ok).toBe(true)
      expect(r.ok && r.skipped).toBe(true) // 语义=他人正在生成/已完成，非失败
      if (r.ok) expect(r.path).toBe(chapterSummaryPath(root, 1))
      expect(state.calls).toBe(0) // 桩计数：没碰 AI（修复前双开重复调 AI 重复计费）
      expect(existsSync(chapterSummaryPath(root, 1))).toBe(false) // 不落盘
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('锁空闲正常路径不回归：生成落盘 skipped=false；再调走 fresh 短路 skipped=true；锁不残留', async () => {
    const root = makeBook()
    try {
      const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root) })
      expect(r.ok && !r.skipped).toBe(true)
      expect(state.calls).toBe(1)
      expect(existsSync(chapterSummaryPath(root, 1))).toBe(true)
      const again = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root) })
      expect(again.ok && again.skipped).toBe(true)
      expect(state.calls).toBe(1) // fresh 短路不调 AI
      // 锁释放干净：锁文件不残留（他进程下次首调零等待）
      expect(existsSync(join(root, '工作区', '.摘要锁-章1.lock'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('同进程并发去重（inFlight）：命中 skipped 非失败，不重复调 AI（R26-101 语义）', async () => {
    const root = makeBook()
    try {
      state.hold = true // 首调用进入挂起的 AI 调用（在途窗口），随后显式放行
      const first = generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root) })
      await new Promise((r) => setTimeout(r, 30)) // 等首调用进入挂起的 AI 调用（在途窗口）
      const second = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root) })
      expect(second.ok && second.skipped).toBe(true)
      expect(state.calls).toBe(1)
      state.release!()
      expect((await first).ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // R28-14（二十八轮）：锁名补 .lock 后缀的直接锚定——修复前 `.摘要锁-章N` 不以 .lock
  // 结尾，fs/atomic sweepAbandonedTmpFiles 的陈锁清扫分支（ent.name.endsWith('.lock')，
  // R76-27）永不命中，崩溃残留锁永久堆积。测法：真实生成链持锁（桩挂起制造在途窗口）
  // 捕获模块实际落盘的锁名（不二次硬编码断言面），再以同名死 pid 超龄锁模拟崩溃残留，
  // 断言 sweep 清走——锁名漂移回无后缀形态时本用例双断言（名字锚 + sweep 命中）同红。
  test('R28-14: 摘要锁名以 .lock 结尾——崩溃残留锁文件会被 sweep 陈锁分支清扫（不再永久堆积）', async () => {
    const root = makeBook()
    try {
      state.hold = true
      const p = generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root) })
      const lockDir = join(root, '工作区')
      let lockName = ''
      for (let i = 0; i < 400 && !lockName; i++) {
        await new Promise((r) => setTimeout(r, 5))
        lockName = existsSync(lockDir) ? (readdirSync(lockDir).find((n) => n.endsWith('.lock')) ?? '') : ''
      }
      expect(lockName).toBe('.摘要锁-章1.lock') // 修复前落盘名 .摘要锁-章1（无后缀）
      state.release!()
      expect((await p).ok).toBe(true) // 放行使真实链走完：锁释放删文件，现场干净
      // 模拟崩溃残留：同名锁 + 死 pid + 超 10 分钟龄（sweep 陈锁分支的活 pid/年龄判据全过）
      const residue = join(lockDir, lockName)
      const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
      writeFileSync(residue, JSON.stringify({ pid: dead.pid ?? 999_999, bootTime: 0 }), 'utf-8')
      const old = new Date(Date.now() - 20 * 60_000)
      utimesSync(residue, old, old)
      expect(sweepAbandonedTmpFiles(root)).toBe(1)
      expect(existsSync(residue)).toBe(false)
    } finally {
      state.hold = false
      state.release?.()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // R28-15（二十八轮）：0 档 = 非阻塞 try-acquire——锁被活进程持有时立即 skipped 返回，
  // 不再有 Atomics.wait 同步等待档（修复前生产 5s：GUI 主进程双开场景整段冻结事件循环）。
  // 注入 0 与生产常量同档锚定「拿不到即跳过、快速返回」的行为面。
  test('R28-15: 锁等待档 0（纯 try-acquire）——持锁时立即 skipped，不阻塞等待', async () => {
    const root = makeBook()
    try {
      __setSummaryGenerateLockTimeoutForTest(0) // 生产档（R28-15 起固定 0）
      const lockPath = join(root, '工作区', '.摘要锁-章1.lock')
      mkdirSync(join(root, '工作区'), { recursive: true })
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: Date.now() }), 'utf-8')
      const t0 = Date.now()
      const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root) })
      expect(r.ok && r.skipped).toBe(true) // 语义不变：他人正在生成，非失败
      expect(state.calls).toBe(0) // 未碰 AI
      expect(Date.now() - t0).toBeLessThan(100) // 修复前 5s 同步等待档会稳红
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
