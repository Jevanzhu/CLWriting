/**
 * R44-18（四十四轮）回归：doInitAsync「永不 reject」契约的两个残余 throw 窗。
 *
 * ① writeActive 调用点（appendBookAsync 成功后）：mkdirSync/atomicWriteFile 抛
 *   EACCES 等此前裸穿 reject——建书端点 500，且登记已落盘，作者重试同名撞
 *  「已有一本叫…」的误导性拒绝。修复后按「登记在、active 未写」给可行动 reason。
 * ② tryBooksLock/tryBooksLockAsync 首行 mkdirSync：.clwriting 建不出（EACCES）
 *   此前裸穿，而全部调用方的 null 检查只预期超时语义。修复后收编为获取锁失败
 *   语义（返回 null + warn 留痕），公共签名不变。
 *
 * 另含 R44-7 的 init.ts 计数点用例（countMarkdownFiles 的 .MD 大写扩展名计数）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 注入开关：默认全透传（不影响真实 IO），用例内按需置位
const MOCK = vi.hoisted(() => ({ writeActiveThrows: false, mkdirThrows: false }))
const warns: Array<[string, string]> = vi.hoisted(() => [])

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdirSync: ((p: string, ...rest: unknown[]) => {
      if (MOCK.mkdirThrows) {
        const e = new Error(`mkdir '${p}' 被测试注入失败`) as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }
      return (actual.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as unknown as typeof import('node:fs')['mkdirSync'],
  }
})

vi.mock('../../src/install/books.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/install/books.js')>()
  return {
    ...actual,
    writeActive: (workDir: string, name: string): void => {
      if (MOCK.writeActiveThrows) {
        const e = new Error('EACCES: permission denied, open active') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }
      return actual.writeActive(workDir, name)
    },
  }
})

vi.mock('../../src/log/index.js', () => ({
  log: {
    warn: (tag: string, msg: string): void => {
      warns.push([tag, msg])
    },
    info: (): void => {},
    error: (): void => {},
  },
  initLogging: (): void => {},
}))

import { doInit, doInitAsync } from '../../src/install/init.js'
import { tryBooksLock, tryBooksLockAsync, appendBookAsync, readBooks, readActive } from '../../src/install/books.js'

afterEach(() => {
  MOCK.writeActiveThrows = false
  MOCK.mkdirThrows = false
  warns.length = 0
})

describe('R44-18①：writeActive 失败不再裸穿 reject（登记在、active 未写 → 可行动 reason）', () => {
  it('doInitAsync：mock writeActive 抛 EACCES → 不 reject，reason 明示登记成功 + 手动启用；登记已落盘', async () => {
    MOCK.writeActiveThrows = true
    const wd = mkdtempSync(join(tmpdir(), 'clw-r44-contract-'))
    try {
      let thrown: unknown = null
      let r: Awaited<ReturnType<typeof doInitAsync>> | null = null
      try {
        r = await doInitAsync({ workDir: wd, name: '契约书' })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeNull() // 契约：永不 reject
      expect(r!.ok).toBe(false)
      const reason = (r as { ok: false; reason: string }).reason
      expect(reason).toContain('已建成并登记成功')
      expect(reason).toContain('活动书')
      expect(reason).toContain('无需重建')
      // reason 指导重试的依据是真实状态：登记在、active 未写
      expect(readBooks(wd).some((b) => b.name === '契约书')).toBe(true)
      expect(readActive(wd)).toBeNull()
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('doInit（同步孪生调用点）同源收口：不 throw、同 reason 语义', () => {
    MOCK.writeActiveThrows = true
    const wd = mkdtempSync(join(tmpdir(), 'clw-r44-contract-sync-'))
    try {
      let thrown: unknown = null
      let r: ReturnType<typeof doInit> | null = null
      try {
        r = doInit({ workDir: wd, name: '契约书' })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeNull()
      expect(r!.ok).toBe(false)
      expect((r as { ok: false; reason: string }).reason).toContain('已建成并登记成功')
      expect(readBooks(wd).some((b) => b.name === '契约书')).toBe(true)
      expect(readActive(wd)).toBeNull()
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })
})

describe('R44-18②：tryBooksLock(Async) 的 mkdirSync 抛错收编为获取锁失败语义', () => {
  it('mock mkdirSync 抛 EACCES → tryBooksLock 返回 null 不抛，warn 留痕', () => {
    const wd = mkdtempSync(join(tmpdir(), 'clw-r44-lock-'))
    try {
      MOCK.mkdirThrows = true
      let thrown: unknown = null
      let release: ReturnType<typeof tryBooksLock> = 'unset' as unknown as ReturnType<typeof tryBooksLock>
      try {
        release = tryBooksLock(wd)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeNull()
      expect(release).toBeNull()
      expect(warns.some(([t, m]) => t === 'books' && m.includes('登记锁获取失败'))).toBe(true)
    } finally {
      MOCK.mkdirThrows = false
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('异步孪生 tryBooksLockAsync 同堵：返回 null 不抛', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'clw-r44-lock-async-'))
    try {
      MOCK.mkdirThrows = true
      let thrown: unknown = null
      let release: Awaited<ReturnType<typeof tryBooksLockAsync>> = 'unset' as unknown as Awaited<ReturnType<typeof tryBooksLockAsync>>
      try {
        release = await tryBooksLockAsync(wd)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeNull()
      expect(release).toBeNull()
    } finally {
      MOCK.mkdirThrows = false
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('调用方面：appendBookAsync 在锁获取失败（EACCES 形态）下返回 {ok:false} 不裸抛', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'clw-r44-lock-append-'))
    try {
      MOCK.mkdirThrows = true
      const r = await appendBookAsync(wd, { name: '被挡书', path: '长篇/被挡书', kind: 'long' })
      expect(r.ok).toBe(false)
      expect((r as { ok: false; reason: string }).reason).toContain('锁获取')
      expect(readBooks(wd)).toHaveLength(0)
    } finally {
      MOCK.mkdirThrows = false
      rmSync(wd, { recursive: true, force: true })
    }
  })
})

describe('R44-7：init 半成品判定的 .MD 计数（countMarkdownFiles）', () => {
  it('骨架签名 + 写作/正文 仅 .MD 大写正文 → 不再判为可复跑半成品，拒绝而非覆写', () => {
    const wd = mkdtempSync(join(tmpdir(), 'clw-r44-md-count-'))
    try {
      const bookRoot = join(wd, '长篇', '半成品书')
      mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
      writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 半成品书\n', 'utf-8')
      writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.MD'), '---\n章号: 1\n标题: 开篇\n---\n正文。', 'utf-8')
      const r = doInit({ workDir: wd, name: '半成品书' })
      expect(r.ok).toBe(false)
      expect((r as { ok: false; reason: string }).reason).toContain('已存在且非空')
      // 正文零文件（仅骨架）仍走幂等复跑分支——计数点收紧不误伤原语义的对照断言
      const wd2 = mkdtempSync(join(tmpdir(), 'clw-r44-md-count2-'))
      try {
        const bookRoot2 = join(wd2, '长篇', '空壳书')
        mkdirSync(join(bookRoot2, '写作', '正文'), { recursive: true })
        writeFileSync(join(bookRoot2, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 空壳书\n', 'utf-8')
        const r2 = doInit({ workDir: wd2, name: '空壳书' })
        expect(r2.ok).toBe(true)
      } finally {
        rmSync(wd2, { recursive: true, force: true })
      }
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })
})
