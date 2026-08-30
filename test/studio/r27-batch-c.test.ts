/**
 * 二十七轮修复批 C 回归（R27-60~64）——根因-语义-测法：
 * - R27-60 启动清扫不查跨进程任务闸：sweepStaleReviewDirs 无差别 rmSync review-*，
 *   双进程形态会删他进程在途三审的 out_dir（白烧分钟级任务费用）→ 测闸在持跳过、
 *   无闸照常清扫（mock crossProcessHeldTaskGatesFor 控制在持面）。
 * - R27-61 draft-save 无编排互斥：self-heal 写章在途时同章草稿保存后写赢覆盖 →
 *   测 isSelfHealRunning=true 回 409 BUSY、false 落盘照常（真服务器集成）。
 * - R27-62 导出等待队列无界无超时：队首挂死全体 waiter 无限滞留 → 测排队超限
 *   即拒（ExportSlotWaitError）、等待超时出口、超时后名额不泄漏。
 * - R27-63 learn-commit 无幂等：双击双份条目 → 测同场景+正文二次提交不落新文件、
 *   返回既有路径；不同场景同正文照常入库；金句与样章跨类不互并。
 * - R27-64 chat/confirm 缺 resolveBook：书名不存在时落到「未找到待确认调用」的
 *   404，语义误导 → 测不存在书回 resolveBook 的「没有这本书」信封。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, describe, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { mkdirSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sweepStaleReviewDirs } from '../../src/studio/server/api/review.js'
import { crossProcessHeldTaskGatesFor } from '../../src/studio/server/api/task-gate.js'
import { isSelfHealRunning } from '../../src/ai/orchestrate/self-heal.js'
import { commitSamples, commitQuotes } from '../../src/learn/commit.js'
import { acquireExportSlot, __setExportWaitTimeoutForTest, ExportSlotWaitError } from '../../src/studio/server/api/io.js'

// 文件级 mock：跨进程闸默认无在持、self-heal 默认未运行（importOriginal 保其余原样）
vi.mock('../../src/studio/server/api/task-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/studio/server/api/task-gate.js')>()
  return { ...actual, crossProcessHeldTaskGatesFor: vi.fn(() => [] as string[]) }
})
vi.mock('../../src/ai/orchestrate/self-heal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/orchestrate/self-heal.js')>()
  return { ...actual, isSelfHealRunning: vi.fn(() => false) }
})

// ── R27-60：清扫跳过跨进程三审在持的书 ──

function makeWorkdirWithBook(): string {
  const workDir = mkdtempTracked(join(tmpdir(), 'r27-sweep-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: '清扫书', path: '清扫书', kind: 'long' }) + '\n')
  const cacheDir = join(workDir, '清扫书', '.cache', 'review-doc1')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'x.md'), '三审中间产物', 'utf8')
  return workDir
}

describe('R27-60: sweepStaleReviewDirs 跨进程闸', () => {
  test('无在持闸 → 照常清扫 review-* 残留', () => {
    vi.mocked(crossProcessHeldTaskGatesFor).mockReturnValue([])
    const workDir = makeWorkdirWithBook()
    sweepStaleReviewDirs(workDir)
    expect(existsSync(join(workDir, '清扫书', '.cache', 'review-doc1'))).toBe(false)
  })

  test('他进程持 review 闸 → 跳过该书；持其他 action 照常清扫', () => {
    vi.mocked(crossProcessHeldTaskGatesFor).mockReturnValue(['review'])
    const workDir = makeWorkdirWithBook()
    sweepStaleReviewDirs(workDir)
    expect(existsSync(join(workDir, '清扫书', '.cache', 'review-doc1'))).toBe(true)
    // 在持的若是其他 action（如 analyze），review 清扫照常
    vi.mocked(crossProcessHeldTaskGatesFor).mockReturnValue(['analyze'])
    sweepStaleReviewDirs(workDir)
    expect(existsSync(join(workDir, '清扫书', '.cache', 'review-doc1'))).toBe(false)
    vi.mocked(crossProcessHeldTaskGatesFor).mockReturnValue([])
  })
})

// ── R27-61 / R27-64：draft-save 互斥 + chat/confirm 书校验（真服务器集成） ──

const BOOK = '互斥测试书'
let server: http.Server | undefined
let baseUrl = ''
let token = ''
// 跨测试共享目录不得进 trackTempDir（afterEach 首测后即删，见 helpers/temp-dir.ts 头注）
let apiWorkDir = ''

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'x-studio-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))
}

beforeAll(async () => {
  const { startServer } = await import('../../src/studio/server/index.js')
  apiWorkDir = mkdtempSync(join(tmpdir(), 'r27-batchc-api-'))
  mkdirSync(join(apiWorkDir, '.clwriting'), { recursive: true })
  writeFileSync(join(apiWorkDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  const bookRoot = join(apiWorkDir, BOOK)
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 互斥测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n', 'utf8')
  server = startServer({ port: 0, workDir: apiWorkDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (apiWorkDir) rmSync(apiWorkDir, { recursive: true, force: true })
})

describe('R27-61: draft-save self-heal 互斥', () => {
  test('self-heal 在途 → 409 BUSY', async () => {
    vi.mocked(isSelfHealRunning).mockReturnValue(true)
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/draft-save`, { chapter: 1, content: '草稿正文' })
      expect(r.status).toBe(409)
      expect(r.json['code']).toBe('BUSY')
    } finally {
      vi.mocked(isSelfHealRunning).mockReturnValue(false)
    }
  })

  test('未在途 → 正常落盘', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/draft-save`, { chapter: 1, content: '草稿正文' })
    expect(r.status).toBe(200)
    expect(r.json['ok']).toBe(true)
  })
})

describe('R27-64: chat/confirm 补书存在性校验', () => {
  test('书不存在 → 404「没有这本书」（非「未找到待确认调用」）', async () => {
    const r = await post('/api/books/%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E4%B9%A6/chat/confirm', { callId: 'c1', ok: true })
    expect(r.status).toBe(404)
    expect(String(r.json['error'] ?? r.json['message'] ?? '')).toContain('没有这本书')
  })

  test('书存在但无待确认调用 → 原 404 语义保留', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/chat/confirm`, { callId: 'nope', ok: true })
    expect(r.status).toBe(404)
    expect(String(r.json['error'] ?? r.json['message'] ?? '')).toContain('未找到待确认的工具调用')
  })
})

// ── R27-62：导出等待队列封顶 + 超时出口 ──

describe('R27-62: acquireExportSlot 排队上限与超时', () => {
  test('队列满 → 立即拒（ExportSlotWaitError），放行后计数不泄漏', async () => {
    const held: Array<() => void> = []
    try {
      held.push(await acquireExportSlot())
      held.push(await acquireExportSlot())
      const queued = Array.from({ length: 8 }, () => acquireExportSlot())
      // 8 个 waiter 已在队，第 9 个立即拒
      await expect(acquireExportSlot()).rejects.toBeInstanceOf(ExportSlotWaitError)
      // 放行全部，计数不泄漏
      for (const r of held) r()
      for (const q of queued) {
        const rel = await q
        rel()
      }
      // 泄漏反证：清空后仍能立即拿到两个名额
      held.push(await acquireExportSlot())
      held.push(await acquireExportSlot())
      expect(held.length).toBe(4)
    } finally {
      for (const r of held) r()
    }
  })

  test('等待超时 → 明确出口且名额不泄漏', async () => {
    __setExportWaitTimeoutForTest(30)
    const held: Array<() => void> = []
    try {
      held.push(await acquireExportSlot())
      held.push(await acquireExportSlot())
      await expect(acquireExportSlot()).rejects.toThrow(/超时/)
      // 超时 waiter 已摘队——释放持有者后新请求仍能立即获取（无幽灵占位）
      for (const r of held) r()
      held.length = 0
      held.push(await acquireExportSlot())
      expect(held.length).toBe(1)
    } finally {
      __setExportWaitTimeoutForTest(10 * 60_000)
      for (const r of held) r()
    }
  })
})

// ── R27-63：learn-commit 内容指纹幂等 ──

/** 列条目目录 .md 文件（目录在 tracked 临时书内，afterEach 兜底清算） */
function listEntries(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
}

describe('R27-63: commitSamples/commitQuotes 幂等', () => {
  test('同场景同正文二次提交 → 不落新文件、返回既有路径', () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'r27-learn-'))
    const pick = { 章号: 1, 打分: 5, 场景: '战斗', 技法指令: '学短句压迫感', 出处: '《测试》第1章', 正文: '刀光没入雪雾。' }
    const first = commitSamples(bookRoot, [pick])
    expect(first).toHaveLength(1)
    const second = commitSamples(bookRoot, [pick])
    expect(second).toEqual(first) // 幂等：重放返回同一相对路径
    // 只有 1 个条目文件（双击不双份）
    expect(listEntries(join(bookRoot, '文风', '条目', '样章'))).toHaveLength(1)
  })

  test('不同场景同正文 → 照常入库（场景是注入取用键）', () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'r27-learn2-'))
    commitSamples(bookRoot, [{ 章号: 1, 打分: 5, 场景: '战斗', 出处: '', 正文: '同一段正文。' }])
    commitSamples(bookRoot, [{ 章号: 2, 打分: 5, 场景: '日常', 出处: '', 正文: '同一段正文。' }])
    expect(listEntries(join(bookRoot, '文风', '条目', '样章'))).toHaveLength(2)
  })

  test('金句与样章同内容 → 跨类不互并（金句标签不丢）', () => {
    const bookRoot = mkdtempTracked(join(tmpdir(), 'r27-learn3-'))
    commitSamples(bookRoot, [{ 章号: 1, 打分: 5, 场景: '战斗', 出处: '', 正文: '金句正文。' }])
    const q = commitQuotes(bookRoot, [{ 章号: 1, 场景: '战斗', 出处: '', 正文: '金句正文。' }])
    expect(q).toHaveLength(1)
    expect(listEntries(join(bookRoot, '文风', '条目', '样章'))).toHaveLength(2)
  })
})
