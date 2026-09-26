/**
 * appendBook / doInit 建书占用判重：同名登记拒绝 + 同物理目录拒绝（平台折叠与
 * dev+ino 物理身份两代守卫）+ stat 失败回退口径。两源并一案（按被测行为合并，
 * 断言逐条保留、去重 0 条——R42-35 是 win 折叠臂、R44-11 是 mac dev+ino 孪生臂，
 * 各自平台钉定与注入手法不同、互为对照）：
 * - r42-append-book-dir-occupancy.test.ts（R42-35：win 大小写不敏感卷 Foo/foo join
 *   同目录——此前只做登记名判重，落成「双登记同库」；补 samePath 目录占用判重）
 * - r44-occupy-dev-ino.test.ts（R44-11：mac 默认 APFS 大小写不敏感上字符串全等放行
 *   的孪生漏修——占用判重升级 R71-8 同款 dev+ino 比对，stat 失败回退 samePath；
 *   断言全用 mock statSync 控制物理身份，宿主卷大小写敏感性无关）
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { appendBook, appendBookAsync, readBooks } from '../../src/install/books.js'
import { doInit } from '../../src/install/init.js'

// statSync 拦截（R44-11）：按绝对路径注入假 Stats（dev/ino）或 'throw'（stat 失败形态），
// 其余路径透明转发真 statSync——只控制占用判重探测面，不干扰锁/原子写等真实 IO。
// R42-35 组的用例不经 STAT（平台 mock + 真实 fs 形态），转发透明互不影响。
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
    }) as unknown as (typeof import('node:fs'))['statSync'],
  }
})

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
  STAT.clear()
})

/** 建带 Foo 登记的工作目录（不落书目录——appendBook 只管登记面；R42-35 组用）。 */
function mkWorkDirWithFooRegOnly(): string {
  const wd = mkdtempTracked(join(tmpdir(), 'clw-r42-append-'))
  mkdirSync(join(wd, '.clwriting'), { recursive: true })
  writeFileSync(
    join(wd, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: 'Foo', path: '长篇/Foo', kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
    'utf-8',
  )
  return wd
}

/** 建带 Foo 登记的工作目录 + stat 注入（占用判重只看登记面与探测结果；R44-11 组用）。 */
function mkWorkDirWithFoo(devFoo: number, inoFoo: number): string {
  const wd = mkdtempTracked(join(tmpdir(), 'clw-r44-ino-'))
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

// ── R42-35：samePath 目录占用判重（win 折叠臂；posix 不误伤对照） ────────────

describe('R42-35：appendBook 目录占用判重', () => {
  it('win32：既有 Foo 登记再建 foo（名不同、目录同库形态）→ 冲突拒绝、books.jsonl 不变', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const wd = mkWorkDirWithFooRegOnly()
    try {
      // 同步版（appendBook → appendBookLocked）
      const syncRes = appendBook(wd, {
        name: 'foo',
        path: '长篇/foo',
        kind: 'long',
        created_at: '2026-01-02T00:00:00.000Z',
      })
      expect(syncRes.ok).toBe(false)
      expect((syncRes as { ok: false; reason: string }).reason).toContain('Foo')
      expect((syncRes as { ok: false; reason: string }).reason).toContain('换个名字或先删掉旧的')
      // 登记不被写入（仍只有 Foo 一行）
      expect(readBooks(wd).map((b) => b.name)).toEqual(['Foo'])
      // 异步孪生（GUI 建书面 appendBookAsync）同源收口
      const asyncRes = await appendBookAsync(wd, { name: 'foo', path: '长篇/foo', kind: 'long' })
      expect(asyncRes.ok).toBe(false)
      expect(readBooks(wd).map((b) => b.name)).toEqual(['Foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('posix：大小写异名不折叠（samePath 全等比较）——正常登记不受误伤', () => {
    // 钉 linux（2026-09-04）：原「不钉平台」在 mac/linux 本腿跑 posix 全等分支，但
    // win 腿上 process.platform='win32' → samePath 折叠比较 → foo 撞 Foo 目录占用
    // 被拒，用例必挂（R43-25 同族：平台脆性用例收敛运行期形态）。钉平台后全平台
    // 确定性走 posix 分支——join 产物是 OS 形态路径但 samePath 只做字符串全等，
    // win 形态（反斜杠）不影响断言语义。
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const wd = mkWorkDirWithFooRegOnly()
    try {
      const res = appendBook(wd, { name: 'foo', path: '长篇/foo', kind: 'long' })
      expect(res.ok).toBe(true)
      expect(
        readBooks(wd)
          .map((b) => b.name)
          .sort(),
      ).toEqual(['Foo', 'foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })
})

// ── R44-11：dev+ino 物理身份判定（mac 孪生臂） ──────────────────────────────

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
      expect(
        readBooks(wd)
          .map((b) => b.name)
          .sort(),
      ).toEqual(['Foo', 'foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('stat 失败回退 samePath：darwin/win32 折叠比较 → 均拒（R42-35 折叠口径；R51-D-2 起 darwin 同折）', () => {
    const wd = mkWorkDirWithFoo(100, 200)
    STAT.set(join(wd, '长篇', 'Foo'), 'throw')
    STAT.set(join(wd, '长篇', 'foo'), 'throw')
    try {
      // R51-D-2（五十一轮）：samePath 平台折叠集收口 darwin（默认 APFS 卷大小写不敏感，
      // Foo/foo 回退口径下亦视同库拒双登记）——原「darwin 字符串全等放行」期望过时；
      // 大小写敏感卷上的合法异名库仍由上方 dev+ino 主路径放行（不同 ino 臂）
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      const posixRes = appendBook(wd, { name: 'foo', path: '长篇/foo', kind: 'long' })
      expect(posixRes.ok).toBe(false)
      expect((posixRes as { ok: false; reason: string }).reason).toContain('「Foo」')
      expect(readBooks(wd).map((b) => b.name)).toEqual(['Foo'])

      // win32：折叠比较——Foo/foo 视为同库，拒（R42-35 口径不回退）
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
    const wd = mkdtempTracked(join(tmpdir(), 'clw-r44-init-ino-'))
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
    const wd = mkdtempTracked(join(tmpdir(), 'clw-r44-init-ino2-'))
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
      expect(
        readBooks(wd)
          .map((b) => b.name)
          .sort(),
      ).toEqual(['Foo', 'foo'])
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })
})
