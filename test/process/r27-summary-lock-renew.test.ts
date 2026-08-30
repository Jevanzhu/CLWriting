/**
 * R27-105（二十七轮）回归——摘要生成跨进程锁接线 N6 续期：
 * 根因：锁盖「状态判定 + AI 调用 + 落盘」全临界段（R26-19），而锁原语的活 pid 超龄
 * 门槛（Z-19）与 AI 任务默认超时同为 10 分钟——章/卷两处锁调用未传 renewIntervalMs，
 * 长调用窗口内锁文件 mtime 恒为创建时刻，第二进程按「活 pid 超龄且无续期」接管成
 * 双持锁：同章/卷双生成双计费，跨进程互斥被静默击穿。
 * 语义：接线锁原语既有续期能力（N6；task-gate R71-3 同款 30s 档）——持锁期间周期
 * utimes 刷 mtime，活锁不再被超龄误接管；锁原语自身语义由
 * test/fs/cross-process-lock-renew.test.ts 盖，本文件只锚「摘要侧接线到位」。
 * 测法：runSpec 桩挂起制造在途 AI 窗口 + 注入最小续期周期，观察锁文件 mtime 在窗口内
 * 被抬新（章/卷两处接线各自锚定，修复前 mtime 不动）；放行后锁文件释放不残留（停表+删锁）。
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateChapterSummary,
  generateVolumeSummary,
  chapterSummaryPath,
  __setSummaryGenerateLockTimeoutForTest,
  __setSummaryLockRenewMsForTest,
} from '../../src/process/summary.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { computeRevision } from '../../src/document/revision.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// 桩挂起门：章/卷摘要各自可控挂起（制造在途 AI 窗口）——引用在 runSpec 调用时才解引用
// （vi.mock 工厂提升安全，同 r26-summary-crossproc-lock.test.ts 惯例）
const state: {
  holdChapter: boolean
  holdVolume: boolean
  releaseChapter: (() => void) | null
  releaseVolume: (() => void) | null
} = { holdChapter: false, holdVolume: false, releaseChapter: null, releaseVolume: null }

vi.mock('../../src/ai/tasks/spec.js', () => ({
  runSpec: vi.fn(async (_spec: unknown, opts: { userPrompt: string }) => {
    if (opts.userPrompt.includes('写章摘要') && state.holdChapter) {
      await new Promise<void>((r) => {
        state.releaseChapter = r
      })
    } else if (opts.userPrompt.includes('写卷摘要') && state.holdVolume) {
      await new Promise<void>((r) => {
        state.releaseVolume = r
      })
    }
    return { ok: true, data: { text: '情节推进：主角登场。\n账本变动：无。\n章尾钩子：钟声又响。' }, model: 'mock' }
  }),
}))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 等锁文件出现（拿锁成功的观测锚）；超时抛错防用例假绿挂死。 */
async function waitForLock(lockPath: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (existsSync(lockPath)) return
    await sleep(5)
  }
  throw new Error(`锁文件未出现（2s 超时）：${lockPath}`)
}

beforeEach(() => {
  __setSummaryGenerateLockTimeoutForTest(150)
  __setSummaryLockRenewMsForTest(20) // 最小续期周期：90ms 窗口跨 ≥4 次续期
  state.holdChapter = false
  state.holdVolume = false
  state.releaseChapter = null
  state.releaseVolume = null
})

describe('R27-105: 摘要锁续期接线', () => {
  test('章摘要：在途 AI 窗口内锁文件 mtime 被续期抬新；放行后锁释放不残留', async () => {
    const root = mkdtempTracked(join(tmpdir(), 'clw-r27-chrenew-'))
    try {
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      const body = join(root, '写作', '正文', '001-第1章.md')
      writeFileSync(
        body,
        '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第1章正文。\n',
        'utf-8',
      )
      state.holdChapter = true
      const p = generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: body })
      const lockPath = join(root, '工作区', '.摘要锁-章1.lock') // R28-14：锁名补 .lock 后缀
      await waitForLock(lockPath)
      const m0 = Math.floor(statSync(lockPath).mtimeMs)
      await sleep(90) // 跨 ≥4 个续期周期（注入 20ms）
      const m1 = Math.floor(statSync(lockPath).mtimeMs)
      // 修复前：未传 renewIntervalMs → mtime 恒为创建时刻（m1 === m0），长调用一超
      // 10min 超龄线即被他进程接管双持锁；修复后续期把 mtime 抬新
      expect(m1).toBeGreaterThan(m0)
      state.releaseChapter!()
      expect((await p).ok).toBe(true)
      expect(existsSync(lockPath)).toBe(false) // release 停表 + 删锁（续期定时器不残留）
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('卷摘要：在途 AI 窗口内锁文件 mtime 被续期抬新（第二处接线同锚）；放行后不残留', async () => {
    const root = mkdtempTracked(join(tmpdir(), 'clw-r27-volrenew-'))
    try {
      // 2 章定稿 + 章摘要齐全（卷 1 链完整，generateVolumeSummary 才进得到 AI 调用）
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      mkdirSync(join(root, '项目'), { recursive: true })
      const manifestPath = join(root, '项目', '文档清单.jsonl')
      const m = readManifest(manifestPath)
      for (let no = 1; no <= 2; no++) {
        const pad = String(no).padStart(3, '0')
        const body = join(root, '写作', '正文', `${pad}-第${no}章.md`)
        writeFileSync(
          body,
          `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${no}章正文。\n`,
          'utf-8',
        )
        const id = generateDocId()
        upsertEntry(m, { id, nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
        const e = m.entries.get(id)!
        e.finalizedRevision = computeRevision(body)
        e.finalizedAt = new Date().toISOString()
        const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: no, bodyAbsPath: body })
        expect(r.ok).toBe(true)
        expect(existsSync(chapterSummaryPath(root, no))).toBe(true)
      }
      writeManifest(manifestPath, m)

      state.holdVolume = true
      const p = generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
      const lockPath = join(root, '工作区', '.摘要锁-卷1.lock') // R28-14：锁名补 .lock 后缀
      await waitForLock(lockPath)
      const m0 = Math.floor(statSync(lockPath).mtimeMs)
      await sleep(90)
      const m1 = Math.floor(statSync(lockPath).mtimeMs)
      expect(m1).toBeGreaterThan(m0) // 修复前 mtime 恒旧 → 超龄被接管双生成双计费
      state.releaseVolume!()
      expect((await p).ok).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
