/**
 * R44-11（四十四轮）回归：建书占用判重 mac 侧孪生漏修——dev+ino 物理身份判定。
 *
 * R42-35 只补了 win32 折叠比较（samePath）；mac 默认 APFS（大小写不敏感）上字符串
 * 口径 posix 全等，《Foo》建后未写正文再建《foo》仍双登记同一物理目录。修复后
 * appendBookLocked / doInitSteps 的占用判重升级为 R71-8 同款 dev+ino 比对
 * （stat 失败回退 samePath 字符串口径）。
 *
 * 断言形态全部用 mock statSync 控制（不依赖宿主卷大小写敏感性——win 宿主真 statSync
 * 在大小写不敏感卷上本就同目录同 ino，mac/linux 宿主则否，mock 保证三平台腿一致）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// statSync 拦截：按绝对路径注入假 Stats（dev/ino）或 'throw'（stat 失败形态），
// 其余路径透明转发真 statSync——只控制占用判重探测面，不干扰锁/原子写等真实 IO。
const STAT = vi.hoisted(() => new Map<string, { dev: number; ino: number } | 'throw'>())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: ((p: string, ...rest: unknown[]) => {
      if (typeof p === 'string' && STAT.has(p)) {
        const hit = STAT.get(p)!
        if (hit === 'throw') {
          const e = new Error(`stat '${p}' 被测试注入失败`) as NodeJS.ErrnoException
          e.code = 'EACCES'
          throw e
        }
        return { dev: hit.dev, ino: hit.ino, isDirectory: () => true } as never
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as unknown as typeof import('node:fs')['statSync'],
  }
})

import { appendBook, appendBookAsync, readBooks } from '../../src/install/books.js'
import { doInit } from '../../src/install/init.js'

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
  STAT.clear()
})

/** 建带 Foo 登记的工作目录 + stat 注入（占用判重只看登记面与探测结果）。 */
function mkWorkDirWithFoo(devFoo: number, inoFoo: number): string {
  const wd = mkdtempSync(join(tmpdir(), 'clw-r44-ino-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  writeFileSync(
    join(wd, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: 'Foo', path: '长篇/Foo', kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
    'utf-8',
  )
  STAT.set(join(wd, '长篇', 'Foo'), { dev: devFoo, ino: inoFoo })
  STAT.set(join(wd, '长篇', 'foo'), { dev: devFoo, ino: inoFoo })
  return wd
}

describe('R44-11：appendBook 占用判重 dev+ino 物理身份', () => {
  it('mac（darwin）：Foo/foo 两登记路径 stat 同 dev+ino（APFS 同物理目录）→ 拒，books.jsonl 不变', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const wd = mkWorkDirWithFoo(100, 200)
    try {
      const res = appendBook(wd, { name: 'foo', path: '长篇/foo', kind: 'long' })
      expect(res.ok).toBe(false)
      expect((res as { ok: false; reason: string }).reason).toContain('「Foo」')
      expect((res as { ok: false; reason: string }).reason).toContain('换个名字或先删掉旧的')
      expect(readBooks(wd).map((b) => b.name)).toEqual(['Foo'])
      // 异步孪生（GUI/CLI 建书面）同源收口
      const asyncRes = await appendBookAsync(wd, { name: 'foo', path: '长篇/foo', kind: 'long' })
      expect(asyncRes.ok).toBe(false)
      expect(readBooks(wd).map((b) => b.name)).toEqual(['Foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('darwin：dev+ino 不同（大小写敏感卷上的合法异名库）→ 放行双登记', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const wd = mkWorkDirWithFoo(100, 200)
    STAT.set(join(wd, '长篇', 'foo'), { dev: 100, ino: 201 }) // 不同 ino = 不同物理目录
    try {
      const res = appendBook(wd, { name: 'foo', path: '长篇/foo', kind: 'long' })
      expect(res.ok).toBe(true)
      expect(readBooks(wd).map((b) => b.name).sort()).toEqual(['Foo', 'foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('stat 失败回退 samePath：darwin 字符串全等 → 放行；win32 折叠 → 拒（R42-35 行为保持）', () => {
    const wd = mkWorkDirWithFoo(100, 200)
    STAT.set(join(wd, '长篇', 'Foo'), 'throw')
    STAT.set(join(wd, '长篇', 'foo'), 'throw')
    try {
      // posix：回退全等比较——大小写异名两字符串不等，放行
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      const posixRes = appendBook(wd, { name: 'foo', path: '长篇/foo', kind: 'long' })
      expect(posixRes.ok).toBe(true)

      // win32：回退折叠比较——Foo/foo 视为同库，拒（R42-35 口径不回退）
      const wd2 = mkWorkDirWithFoo(100, 200)
      STAT.set(join(wd2, '长篇', 'Foo'), 'throw')
      STAT.set(join(wd2, '长篇', 'foo'), 'throw')
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      try {
        const winRes = appendBook(wd2, { name: 'foo', path: '长篇/foo', kind: 'long' })
        expect(winRes.ok).toBe(false)
        expect((winRes as { ok: false; reason: string }).reason).toContain('「Foo」')
        expect(readBooks(wd2).map((b) => b.name)).toEqual(['Foo'])
      } finally {
        rmSync(wd2, { recursive: true, force: true })
      }
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })
})

describe('R44-11：doInit 半成品放行分支的同款防线', () => {
  it('mac（darwin）：Foo 半成品在册再 init foo（同物理目录形态）→ 拒且不覆写他书 book.yaml', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const wd = mkdtempSync(join(tmpdir(), 'clw-r44-init-ino-'))
    // Foo 已登记 + 半成品目录在盘（book.yaml 骨架签名、零正文）
    mkdirSync(join(wd, '.clwriting'), { recursive: true })
    writeFileSync(
      join(wd, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: 'Foo', path: '长篇/Foo', kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
      'utf-8',
    )
    mkdirSync(join(wd, '长篇', 'Foo'), { recursive: true })
    const yamlPath = join(wd, '长篇', 'Foo', 'book.yaml')
    const yamlBefore = 'book:\n  title: Foo\n'
    writeFileSync(yamlPath, yamlBefore, 'utf-8')
    // APFS 形态：两条大小写异名路径 stat 同 dev+ino（同一物理目录）
    STAT.set(join(wd, '长篇', 'Foo'), { dev: 100, ino: 200 })
    STAT.set(join(wd, '长篇', 'foo'), { dev: 100, ino: 200 })
    try {
      const r = doInit({ workDir: wd, name: 'foo' })
      expect(r.ok).toBe(false)
      expect((r as { ok: false; reason: string }).reason).toContain('「Foo」')
      expect((r as { ok: false; reason: string }).reason).toContain('换个名字或先删掉旧的')
      // 拒绝发生在幂等 scaffold 之前——他书 book.yaml 未被覆写、登记不变
      expect(readFileSync(yamlPath, 'utf-8')).toBe(yamlBefore)
      expect(readBooks(wd).map((b) => b.name)).toEqual(['Foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('mac（darwin）：dev+ino 不同（合法异名库）→ init foo 照常成功', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const wd = mkdtempSync(join(tmpdir(), 'clw-r44-init-ino2-'))
    mkdirSync(join(wd, '.clwriting'), { recursive: true })
    writeFileSync(
      join(wd, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: 'Foo', path: '长篇/Foo', kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
      'utf-8',
    )
    STAT.set(join(wd, '长篇', 'Foo'), { dev: 100, ino: 200 })
    STAT.set(join(wd, '长篇', 'foo'), { dev: 100, ino: 201 }) // 不同 ino = 另一物理目录
    try {
      const r = doInit({ workDir: wd, name: 'foo' })
      expect(r.ok).toBe(true)
      expect(readBooks(wd).map((b) => b.name).sort()).toEqual(['Foo', 'foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })
})
