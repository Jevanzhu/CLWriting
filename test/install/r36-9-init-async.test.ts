/**
 * R36-9/R36-26（三十六轮批 D）：建书同步锁异步化回归——appendBookAsync / doInitAsync。
 *
 * 机理：GUI 建书端点（POST /api/books → doInit → appendBook）与 CLI 建书（appendBook）
 * 此前都在同步 books.lock（Atomics.wait 最坏 5s）内，而端点承载 SSE/全部接口；
 * install/books.ts 注释登记「余面均不在请求窗口」与 GUI 建书事实矛盾（R36-26）。
 *
 * 覆盖：
 * - GUI 路径（doInitAsync）成功：登记 + active + 结果与同步 doInit 恒等
 * - CLI 路径（appendBookAsync）成功 + 同名冲突 {ok:false}（DA-3 语义）
 * - 互斥不阻塞：锁被持有（另一进程形态模拟）时异步孪生轮询等待不冻结事件循环
 *   （期间定时器照常触发），超时降级 {ok:false 锁获取超时}；释放后重试成功
 * - doInitAsync 同样在锁争用下不阻塞（建书前置骨架段照常走完后登记段异步等待）
 * - 失败路径永不 reject（{ok:false, reason} 契约不破坏）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  doInitAsync,
  doInit,
} from '../../src/install/init.js'
import {
  appendBookAsync,
  tryBooksLock,
  readBooks,
  readActive,
  __setBooksLockTimeoutForTest,
  BOOKS_LOCK_TIMEOUT_MS,
} from '../../src/install/books.js'

afterEach(() => {
  __setBooksLockTimeoutForTest(BOOKS_LOCK_TIMEOUT_MS)
})

describe('R36-9 建书异步锁：成功路径', () => {
  it('GUI 路径：doInitAsync 建书 → 骨架 + 登记 + active 全部落位，结果与同步 doInit 恒等', async () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clwriting-r36-9-init-'))
    let thrown: unknown = null
    let r: Awaited<ReturnType<typeof doInitAsync>> | null = null
    try {
      r = await doInitAsync({ workDir: wd, name: '异步建书', genre: '玄幻' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeNull() // 永不 reject
    expect(r!.ok).toBe(true)
    if (!r!.ok) return
    expect(existsSync(join(r!.bookRoot, 'book.yaml'))).toBe(true)
    expect(readBooks(wd).some((b) => b.name === '异步建书')).toBe(true)
    expect(readActive(wd)).toBe('异步建书')

    // 与同步 doInit 结果恒等（同名同参数；bookRoot 因临时根不同不可比，比注册面字段）
    const wd2 = mkdtempTracked(join(tmpdir(), 'clwriting-r36-9-init-sync-'))
    const rs = doInit({ workDir: wd2, name: '异步建书', genre: '玄幻' })
    expect(rs.ok).toBe(true)
    if (rs.ok && r!.ok) {
      expect(rs.bookName).toBe(r!.bookName)
      expect(rs.bookPath).toBe(r!.bookPath)
      expect(readBooks(wd2).some((b) => b.name === '异步建书')).toBe(true)
      expect(readActive(wd2)).toBe('异步建书')
    }
  })

  it('CLI 路径：appendBookAsync 追加登记成功；同名冲突 {ok:false, reason} 不 reject', async () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clwriting-r36-9-append-'))
    const entry = { name: '夜语集', path: '短篇/夜语集', kind: 'short' as const }
    let thrown: unknown = null
    let added: { ok: true } | { ok: false; reason: string } | null = null
    try {
      added = await appendBookAsync(wd, entry)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeNull()
    expect(added!.ok).toBe(true)
    expect(readBooks(wd)).toHaveLength(1)

    const dup = await appendBookAsync(wd, entry)
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toContain('已有一本叫「夜语集」')
    expect(readBooks(wd)).toHaveLength(1) // 冲突未写
  })
})

describe('R36-9 互斥不阻塞（队列语义）', () => {
  it('锁被持有：appendBookAsync 轮询等待不冻结事件循环（定时器照跑），超时降级；释放后重试成功', async () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clwriting-r36-9-block-'))
    __setBooksLockTimeoutForTest(80)

    // 同进程持锁模拟「另一进程正在改写 books.jsonl」（tryBooksLock 的 pid 存活判定
    // 对本进程返回 held——与跨进程争用窗口同型）
    const release = tryBooksLock(wd)
    expect(release).not.toBeNull()
    let wheel = false
    const flag = setTimeout(() => {
      wheel = true
    }, 10)
    try {
      const r = await appendBookAsync(wd, { name: '被挡书', path: '长篇/被挡书', kind: 'long' })
      // 事件循环未被 Atomics.wait 冻结——异步孪生的关键断言（同步版此处会卡满 80ms 挡住定时器）
      expect(wheel).toBe(true)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('锁获取超时')
      expect(readBooks(wd)).toHaveLength(0) // 超时降级未写
    } finally {
      clearTimeout(flag)
      release?.()
    }

    // 锁释放后同一请求重试 → 成功（超时降级不是死路）
    const retry = await appendBookAsync(wd, { name: '被挡书', path: '长篇/被挡书', kind: 'long' })
    expect(retry.ok).toBe(true)
    expect(readBooks(wd)).toHaveLength(1)
  })

  it('GUI 路径：锁被持有 + 注入短超时 → doInitAsync 登记段异步等待超时降级 {ok:false}，事件循环不冻结', async () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clwriting-r36-9-block-init-'))
    __setBooksLockTimeoutForTest(60)

    const release = tryBooksLock(wd)
    expect(release).not.toBeNull()
    let wheel = false
    const flag = setTimeout(() => {
      wheel = true
    }, 10)
    try {
      const r = await doInitAsync({ workDir: wd, name: '被挡书', genre: '玄幻' })
      expect(wheel).toBe(true)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('锁获取超时')
    } finally {
      clearTimeout(flag)
      release?.()
    }

    // 释放后重试 → 成功（骨架已建，幂等续走登记）
    const retry = await doInitAsync({ workDir: wd, name: '被挡书', genre: '玄幻' })
    expect(retry.ok).toBe(true)
    if (retry.ok) {
      expect(readBooks(wd).some((b) => b.name === '被挡书')).toBe(true)
      expect(readActive(wd)).toBe('被挡书')
    }
  })
})