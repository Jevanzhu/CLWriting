/**
 * R0916-7-P3-14（2026-09-25 源码质量评审 P3-14）：任务闸锁文件名可枚举 + 旧格式迁移。
 *
 * 旧格式文件名 = 截断 sha256(action + NUL + book)（单向不可逆）：跨进程查「本书有哪些
 * 任务在跑」只能拿 KNOWN_ACTIONS/GATED_ACTIONS 注册表逐个哈希探测——目录不可自描述、
 * 排障从文件名看不出持有者、新增闸占用点要登记。新格式 `${action}.${hash(book)}.lock`：
 * 列目录即得持有者（action 段自描述），两张注册表与两份静态对账门随批删除。
 *
 * 本文件锁三件事（文件名格式在测试内独立复现，不复用生产函数——改格式即红）：
 * 1. 可枚举：手写新格式锁文件（不经 acquireTaskGate）→ crossProcessHeldTaskGatesFor
 *    列目录即返回该书全部在途 action；他书记录 / 无关文件 / 旧格式名不进枚举面；
 * 2. 旧格式不可双持：旧名在持（活 pid）时新侧 acquire 必须退让（null）且不留新锁；
 *    旧名非在持（崩溃残留）时照常占上并顺手清残留；
 * 3. 启动清扫（configureTaskGateLockRoot）：非在持旧残留删除；在持旧锁保留（混合版本
 *    运行由 acquire 侧探测兜住，删掉等于替旧版放闸）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import {
  acquireTaskGate,
  crossProcessHeldTaskGatesFor,
  lockFileName,
  configureTaskGateLockRoot,
} from '../../src/studio/server/api/task-gate.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const BOOK = '枚举书'
const OTHER_BOOK = '旁书'
const ACTION_A = 'analyze'
const ACTION_B = 'rag-build'

/** 新格式名独立复现：`${action}.${sha256(book) 前 16 hex}.lock` */
const newName = (action: string, book: string): string =>
  `${action}.${createHash('sha256').update(book).digest('hex').slice(0, 16)}.lock`
/** 旧格式名独立复现：`${sha256(action + NUL + book) 前 16 hex}.lock` */
const legacyName = (action: string, book: string): string =>
  `${createHash('sha256').update(`${action}\u0000${book}`).digest('hex').slice(0, 16)}.lock`

const roots: string[] = []
function freshDir(): string {
  const d = mkdtempTracked(join(tmpdir(), 'r0916-task-gate-format-'))
  mkdirSync(d, { recursive: true })
  roots.push(d)
  return d
}
afterAll(() => {
  configureTaskGateLockRoot(null)
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** 写一枚「他进程在持」锁文件（活 pid = 本进程，探测必活）。 */
function holdLock(dir: string, name: string): string {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify({ pid: process.pid, bootTime: Date.now() }))
  return p
}

describe('R0916-7-P3-14：锁文件名格式', () => {
  it('新格式 = action.hash(book).lock；书名（含路径字符）不进文件名', () => {
    expect(lockFileName(BOOK, ACTION_A)).toBe(newName(ACTION_A, BOOK))
    expect(lockFileName('长篇/书:名?*', 'review')).toMatch(/^review\.[0-9a-f]{16}\.lock$/)
  })
})

describe('R0916-7-P3-14：列目录即枚举（不需要动作注册表）', () => {
  it('只凭目录内容反解本书在途 action；他书记录/无关文件/旧格式名不入枚举面', () => {
    const dir = freshDir()
    // 本书两条在途（手写锁文件 = 等价他进程在持）；顺序故意与字典序相反，验证返回有序
    holdLock(dir, newName(ACTION_B, BOOK))
    holdLock(dir, newName(ACTION_A, BOOK))
    // 噪声：他书记录、无关文件、旧格式残留（P3-14 前的名）
    holdLock(dir, newName(ACTION_A, OTHER_BOOK))
    writeFileSync(join(dir, 'notes.lock'), 'x')
    writeFileSync(join(dir, 'README.md'), 'x')
    holdLock(dir, legacyName(ACTION_A, BOOK))

    expect(crossProcessHeldTaskGatesFor(BOOK, { lockDir: dir })).toEqual([ACTION_A, ACTION_B])
    expect(crossProcessHeldTaskGatesFor(OTHER_BOOK, { lockDir: dir })).toEqual([ACTION_A])
  })

  it('旧格式在持锁不入枚举面（迁移边界如实钉定：旧名不含书信息，无法归属）', () => {
    const dir = freshDir()
    holdLock(dir, legacyName(ACTION_B, BOOK))
    // 旧名是 16hex 单段（无 action 前缀），本查询只认 `${action}.${bookTag}.lock`
    expect(crossProcessHeldTaskGatesFor(BOOK, { lockDir: dir })).toEqual([])
  })

  it('陈锁不算在持（活 pid 超龄无续期）——枚举不误报', () => {
    const dir = freshDir()
    const p = holdLock(dir, newName(ACTION_A, BOOK))
    const past = new Date(Date.now() - 11 * 60_000)
    utimesSync(p, past, past)
    expect(crossProcessHeldTaskGatesFor(BOOK, { lockDir: dir })).toEqual([])
  })
})

describe('R0916-7-P3-14：旧格式残留不可造成双持', () => {
  it('旧名在持（旧版进程）→ 新侧 acquire 退让且不留新锁（不会两个持有者跑同一任务）', () => {
    const dir = freshDir()
    const legacy = holdLock(dir, legacyName(ACTION_A, BOOK))
    const r = acquireTaskGate(BOOK, ACTION_A, { lockDir: dir })
    expect(r).toBeNull()
    // 刚占的新锁必须已回滚——否则「新锁 + 旧锁」同时在位，旧版进程持旧锁照跑
    expect(existsSync(join(dir, newName(ACTION_A, BOOK)))).toBe(false)
    // 旧锁原样保留（不是本侧该删的：持有者还活着）
    expect(existsSync(legacy)).toBe(true)
    expect(readdirSync(dir)).toEqual([legacyName(ACTION_A, BOOK)])
  })

  it('旧名非在持（崩溃残留）→ 新侧照常占上并顺手清残留；release 后可再占', () => {
    const dir = freshDir()
    const legacy = holdLock(dir, legacyName(ACTION_B, BOOK))
    writeFileSync(legacy, JSON.stringify({ pid: 4194303, bootTime: 1 })) // 死 pid = 崩溃残留
    const r = acquireTaskGate(BOOK, ACTION_B, { lockDir: dir })
    expect(r).not.toBeNull()
    expect(existsSync(legacy)).toBe(false) // 残留被顺手清掉（不越积）
    expect(existsSync(join(dir, newName(ACTION_B, BOOK)))).toBe(true)
    r!()
    expect(existsSync(join(dir, newName(ACTION_B, BOOK)))).toBe(false)
    expect(acquireTaskGate(BOOK, ACTION_B, { lockDir: dir })).not.toBeNull() // 释放后可再占
  })

  it('旧名在持但属别的书/别的 action → 不影响本 key 占闸', () => {
    const dir = freshDir()
    holdLock(dir, legacyName(ACTION_A, OTHER_BOOK))
    const r = acquireTaskGate(BOOK, ACTION_A, { lockDir: dir })
    expect(r).not.toBeNull()
    r!()
  })
})

describe('R0916-7-P3-14：启动清扫旧格式残留', () => {
  it('非在持旧残留删除；在持旧锁保留（混合版本运行不替旧版放闸）；新格式与无关文件不受影响', () => {
    const dir = freshDir()
    const staleLegacy = holdLock(dir, legacyName(ACTION_A, BOOK))
    writeFileSync(staleLegacy, JSON.stringify({ pid: 4194303, bootTime: 1 }))
    const heldLegacy = holdLock(dir, legacyName(ACTION_B, BOOK)) // 活 pid = 旧版进程仍在跑
    const modern = holdLock(dir, newName(ACTION_A, BOOK))
    writeFileSync(join(dir, 'notes.lock'), 'x')

    configureTaskGateLockRoot(dir)
    try {
      expect(existsSync(staleLegacy)).toBe(false) // 非在持残留清掉
      expect(existsSync(heldLegacy)).toBe(true) // 在持旧锁保留
      expect(existsSync(modern)).toBe(true) // 新格式不动
      expect(existsSync(join(dir, 'notes.lock'))).toBe(true) // 无关文件不动
    } finally {
      configureTaskGateLockRoot(null)
    }
  })
})
