/**
 * R50-F-2（五十轮评审批）回归：check-packaging readDirTolerant 的 TOCTOU 容错。
 *
 * 修复前 promptsDir/skillsDir 两处 readdirSync 无容错——existsSync 判定后、readdir
 * 前目录被并发移走（ENOENT）或被换成文件（ENOTDIR）时裸抛炸脚本。修复后收编
 * readDirTolerant：ENOENT/ENOTDIR 记 console.warn 返回空数组（跳过只损该侧对账
 * 诊断，失败方向 fail-closed 不变）；其余错误（EACCES 等）照抛（不吞真故障）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）
import { readDirTolerant } from '../../scripts/check-packaging.mjs'

let dirs: string[] = []

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clw-r50-f2-pkg-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs) {
    try {
      chmodSync(d, 0o755) // EACCES 用例收尾恢复权限，rmSync 才能清理
    } catch {
      /* 目录本身已不在则跳过 */
    }
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})

describe('R50-F-2：check-packaging readDirTolerant（ENOENT/ENOTDIR warn 跳过，其余照抛）', () => {
  it('正常目录 → 原样返回条目', () => {
    const d = tmpDir()
    writeFileSync(join(d, 'a.md'), 'x')
    writeFileSync(join(d, 'b.md'), 'y')
    expect(readDirTolerant(d).sort()).toEqual(['a.md', 'b.md'])
  })

  it('目录不存在（ENOENT）→ warn 留痕返回 []，不抛', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = readDirTolerant(join(tmpDir(), 'gone'))
    expect(out).toEqual([])
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('ENOENT'))).toBe(true)
  })

  it('目录参数实为文件（ENOTDIR）→ warn 留痕返回 []，不抛', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = tmpDir()
    const f = join(d, 'plain.txt')
    writeFileSync(f, 'x')
    expect(readDirTolerant(f)).toEqual([])
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('ENOTDIR'))).toBe(true)
  })

  // Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），EACCES 语义由 macOS/Linux CI 腿覆盖
  it.skipIf(process.platform === 'win32')('其余错误（EACCES）→ 照抛不吞（不假绿也不静默跳过真故障）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = tmpDir()
    chmodSync(d, 0o000) // 无读权限：readdir EACCES——非 TOCTOU 族错误必须裸抛
    expect(() => readDirTolerant(d)).toThrow()
  })
})
