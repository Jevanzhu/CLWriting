/**
 * R0912-5（2026-09-11 修复批）回归：learn 收割锁前移到全书扫描之前。
 *
 * 背景：learnFromBook 原先先全书扫描（逐章读盘 + 打分，长书秒级）末了才取
 * .learn-harvest.lock——双进程并发收割时双方各自白扫一遍全书，败者整段 CPU/IO
 * 白付。修复：锁在扫描前取得（锁内逻辑不变，锁超时/失败返回口径逐字不变）。
 *
 * 判定设计：锁在途时，连「空正文目录」「坏章解析」这类**扫描后才会命中的早退**
 * 都不可达——一律先报既有「在途」文案。修复前这两臂分别返回
 * 「没有定稿正文可收割。」「章节解析失败：…」（确定性区分锁相对扫描的先后）。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  learnFromBook,
  LEARN_HARVEST_LOCK_TIMEOUT_MS,
  LEARN_HARVEST_LOCK_RENEW_MS,
} from '../../src/learn/index.js'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// RC 源码重审 A-4（Opus-5.5 轮）：取锁实参捕参钩子——learn 此前第三参数（opts）整段
// 缺省 = renewIntervalMs 0 = 不续期，而本锁是唯一的「长临界段 + 无续期」调用方：大书
// 慢盘收割整段可超锁原语活 pid 超龄门槛（MAX_HELD_MS 10min），第二进程会按「超龄且
// mtime 无续期」接管 → 双持锁。透传原实现、仅记录实参：断言确定性看参数，不依赖墙钟。
const lockCalls = vi.hoisted(
  () => [] as Array<{ lockPath: string; timeoutMs: number; opts?: { renewIntervalMs?: number } }>,
)
vi.mock('../../src/fs/cross-process-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/cross-process-lock.js')>()
  return {
    ...actual,
    acquireCrossProcessLockAsync: (lockPath: string, timeoutMs: number, opts?: { renewIntervalMs?: number }) => {
      lockCalls.push({ lockPath, timeoutMs, opts })
      return actual.acquireCrossProcessLockAsync(lockPath, timeoutMs, opts)
    },
  }
})

const HARVEST_LOCK = join('工作区', '.learn-harvest.lock')
const CANDIDATE_DIR = '工作区/learn候选'

const QUALIFYING_BODY =
  '林远踏出山门，暮色四合，青石阶尽头的灯火次第亮起。玉佩在胸前微微发烫，像一颗不肯安分的心。他抬手覆上，那温度便缓缓沉下去。\n\n他忽然感到一阵锥心之痛，仿佛有旧事在血里翻身。'

function makeBook(opts?: { emptyBody?: boolean; brokenChapter?: boolean }): string {
  const root = mkdtempTracked(join(tmpdir(), 'learn-lock-first-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\n', 'utf-8')
  if (opts?.emptyBody) return root
  if (opts?.brokenChapter) {
    // fm 章号格式不符 → readChapterDir errors 非空（扫描后的早退判据）
    writeFileSync(join(root, '写作', '正文', '坏章.md'), '---\n章号: 不是数字\n标题: 坏章\n---\n正文', 'utf-8')
    return root
  }
  writeFileSync(join(root, '写作', '正文', '0001-定稿章.md'), `---\n章号: 1\n标题: 定稿章\n---\n${QUALIFYING_BODY}`, 'utf-8')
  return root
}

test('R0912-5: 锁在途 → 空书也先报「在途」而非「没有定稿正文」（锁先于扫描，确定性判据）', async () => {
  const root = makeBook({ emptyBody: true })
  const release = await acquireCrossProcessLockAsync(join(root, HARVEST_LOCK), 0)
  expect(release).toBeTruthy()
  // 合并批注（2026-09-12 mac/win 语义并合）：原注入钩子 __setLearnHarvestLockTimeoutForTest
  // 已随 win 线 2026-09-11 精简批退役（零消费钩子删除）——改用假时钟瞬时走完生产
  // 5s 等待档（等待档本体仍为 LEARN_HARVEST_LOCK_TIMEOUT_MS，测试不付真实 5s，
  // 原设计意图不变）。「超时/失败返回口径」本体由返回形状断言（candidateDir/文案逐字）锁定
  vi.useFakeTimers()
  try {
    const pending = learnFromBook(root)
    await vi.advanceTimersByTimeAsync(LEARN_HARVEST_LOCK_TIMEOUT_MS)
    const r = await pending
    expect(r.ok).toBe(false)
    expect(r.error).toContain('在途')
    expect(r.candidateDir).toBe(CANDIDATE_DIR) // 在途返回口径逐字不变
  } finally {
    vi.useRealTimers()
    release?.()
  }
})

test('R0912-5: 锁在途 → 连章节解析都不跑（报「在途」而非「章节解析失败」，败者零白扫）', async () => {
  const root = makeBook({ brokenChapter: true })
  const release = await acquireCrossProcessLockAsync(join(root, HARVEST_LOCK), 0)
  expect(release).toBeTruthy()
  vi.useFakeTimers()
  try {
    const pending = learnFromBook(root)
    await vi.advanceTimersByTimeAsync(LEARN_HARVEST_LOCK_TIMEOUT_MS)
    const r = await pending
    expect(r.ok).toBe(false)
    expect(r.error).toContain('在途')
    expect(r.error).not.toContain('章节解析失败')
  } finally {
    vi.useRealTimers()
    release?.()
  }
})

test('R0912-5: 无争用 → 收割在锁内正常完成，结束后锁释放（下一轮可立即取锁）', async () => {
  const root = makeBook()
  const r = await learnFromBook(root)
  expect(r.ok).toBe(true)
  // 收割结束锁必须已释放（finally 收口）：try-acquire 立即成功
  const release = await acquireCrossProcessLockAsync(join(root, HARVEST_LOCK), 1000)
  expect(release).toBeTruthy()
  release?.()
})

// RC 源码重审 A-4（Opus-5.5 轮）回归：learn 收割锁必须开续期——缺省（不传第三参数）
// = renewIntervalMs 0 = 锁文件 mtime 恒为创建时刻，长书慢盘收割越过 10min 超龄线即被
// 第二进程按「活 pid 超龄且无续期」接管，双方同时持锁（同书收割双写候选）。判据取
// 实参（捕参钩子），与墙钟/真实续期定时器无关。
test('RC 源码重审 A-4: 收割取锁传了 30s 档续期（renewIntervalMs > 0 且 ≪ MAX_HELD_MS 10min）', async () => {
  const root = makeBook()
  lockCalls.length = 0
  const r = await learnFromBook(root)
  expect(r.ok).toBe(true)
  const harvestCalls = lockCalls.filter((c) => c.lockPath.endsWith(HARVEST_LOCK))
  expect(harvestCalls).toHaveLength(1)
  const call = harvestCalls[0]!
  expect(call.opts?.renewIntervalMs).toBe(LEARN_HARVEST_LOCK_RENEW_MS)
  expect(call.opts!.renewIntervalMs!).toBeGreaterThan(0) // 0/undefined = 不续期（修复前形态）
  // 续期周期必须远低于锁原语的活 pid 超龄门槛（10min），否则「活着且在续期不接管」收紧失效
  expect(call.opts!.renewIntervalMs!).toBeLessThan(10 * 60_000)
  expect(call.timeoutMs).toBe(LEARN_HARVEST_LOCK_TIMEOUT_MS) // 等待档未被顺手改动
})
