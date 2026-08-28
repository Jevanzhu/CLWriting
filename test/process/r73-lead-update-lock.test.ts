/**
 * R73-46（二十一轮）回归：generateLeadUpdateDraft 落盘尾段（archive + 写主文件）套
 * 按书跨进程锁。
 *
 * 进程内队列只防同进程并发；GUI 与 CLI 双进程同书各跑各的队列时，归档判定与覆写的
 * 读改写序列仍可交错（B 的 rename 撞上 A 已 rename 的源 → 误报失败；归档/覆写交错丢
 * 「作者未确认」草稿）。修复后尾段持 `<账本推进.md>.lock`；AI 生成段不持锁。
 *
 * 本文件验证（mock 驱动，不真调 AI）：
 * 1. 正常生成 → 落盘成功、锁文件不残留；
 * 2. 他进程持锁 → 降级裸跑仍成功（warn 留痕）、不删他人在位锁——生成一次成本高，
 *    不因锁等待作废（与 journal appendLine 降级口径一致）。
 */
import { test, expect, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateLeadUpdateDraft, __setLeadUpdateLockTimeoutForTest } from '../../src/process/lead-update-draft.js'
import { log } from '../../src/log/index.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'

const LOCK_REL = join('工作区', '账本推进.md.lock')

function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'r73-leadlock-'))
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 锁测书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '0001-雨夜.md'),
    '---\n章号: 1\n标题: 雨夜\n---\n\n山门外的钟声在雨夜里连响了三下。\n',
    'utf-8',
  )
  return root
}

/** 与 X-P2-6 既有用例同款 mock 驱动开关（LEAD_UPDATE_SPEC 走 mock 产出） */
async function withMockDriver<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env['CLWRITING_DRIVER']
  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env['CLWRITING_DRIVER']
    else process.env['CLWRITING_DRIVER'] = prev
  }
}

const cleanup: string[] = []
afterEach(() => {
  __setLeadUpdateLockTimeoutForTest(5_000)
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

test('R73-46: 正常生成落盘成功，锁文件不残留', async () => {
  const root = makeBook()
  cleanup.push(root)
  const r = await withMockDriver(() => generateLeadUpdateDraft(root, 1, null))
  expect(r.ok).toBe(true)
  const main = readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')
  expect(main).toContain('# 第1章 账本推进')
  expect(existsSync(join(root, LOCK_REL))).toBe(false)
})

test('R73-46: 他进程持锁 → 降级裸跑成功、warn 留痕、他人在位锁不删', async () => {
  const root = makeBook()
  cleanup.push(root)
  __setLeadUpdateLockTimeoutForTest(80) // 缩短锁等待保测试快
  const lockPath = join(root, LOCK_REL)
  mkdirSync(join(lockPath, '..'), { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
  const warnSpy = vi.spyOn(log, 'warn')
  const r = await withMockDriver(() => generateLeadUpdateDraft(root, 1, null))
  expect(r.ok).toBe(true) // 降级不作废本次生成
  expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toContain('# 第1章')
  expect(warnSpy).toHaveBeenCalled()
  expect(existsSync(lockPath)).toBe(true) // 他人在位锁未被误删
})
