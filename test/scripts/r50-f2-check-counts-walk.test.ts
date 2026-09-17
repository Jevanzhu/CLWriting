/**
 * R50-F-2（五十轮评审批）回归：check-counts walk 的 TOCTOU 容错。
 *
 * 修复前 walk 内 readdirSync/statSync 无容错——扫描间隙目录/条目被并发移走
 * （ENOENT）或目录被换成文件（ENOTDIR）时裸抛炸脚本（失败方向 fail-closed 不变，
 * 但整轮门禁诊断全损）。修复后两处包 try/catch：ENOENT/ENOTDIR 记 console.warn
 * 跳过，其余错误照抛（不吞真故障、不假绿）。
 *
 * 确定性构造：目录不存在 → readdir ENOENT；传文件路径 → readdir ENOTDIR；
 * 断链 symlink 条目 → statSync 跟随链接得 ENOENT（与「readdir 后条目被移走」同
 * 错误码路径，免竞态即可回归）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）
import { walk } from '../../scripts/check-counts.mjs'

let dirs: string[] = []

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'clw-r50-f2-walk-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('R50-F-2：check-counts walk TOCTOU 容错（ENOENT/ENOTDIR warn 跳过，其余照抛）', () => {
  it('目录不存在（readdirSync ENOENT）→ warn 留痕返回空集，不抛', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = join(tmpDir(), 'gone') // 从未创建
    const out = walk(missing, () => true)
    expect(out).toEqual([])
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('ENOENT'))).toBe(true)
  })

  it('目录参数实为文件（readdirSync ENOTDIR）→ warn 留痕返回空集，不抛', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = tmpDir()
    const fileAsDir = join(d, 'plain.txt')
    writeFileSync(fileAsDir, 'x')
    const out = walk(fileAsDir, () => true)
    expect(out).toEqual([])
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('ENOTDIR'))).toBe(true)
  })

  // Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，由 macOS/Linux CI 腿覆盖
  // 0918独立重评修复批（D005）改判注：walk 改 lstatSync 判型不跟随 symlink 后，断链
  // symlink 对 lstat 本体仍成功 → 归入 symlink 跳过分支（warn 含 symlink），不再经
  // statSync 跟随得 ENOENT——本用例从「条目级 ENOENT 同码路径」改锚 symlink 跳过语义
  // （目录环/断链/指向文件的完整 symlink 面 = check-counts.test.ts D005 块）；条目级
  // ENOENT/ENOTDIR 分支保留为 TOCTOU 防御（真实并发移走无确定性触发，恒真触发器已随
  // lstat 化消失，上两用例钉目录级同码路径）
  it.skipIf(process.platform === 'win32')('断链 symlink → lstat 本体成功归 symlink 跳过分支（warn 留痕），其余条目照常收集', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = tmpDir()
    const sub = join(d, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, 'a.test.ts'), 'x')
    writeFileSync(join(sub, 'b.test.ts'), 'y')
    // 断链 symlink：lstat 对链接本体成功 → isSymbolicLink → 跳过（不跟随、不炸）
    symlinkSync(join(d, 'moved-away'), join(sub, 'ghost.test.ts'))

    // walk 自 .mjs 导出无类型——参数显式标注（.mjs 直跑脚本不维护 d.ts 的既有口径）
    const out = walk(d, (n: string) => n.endsWith('.test.ts')).map((p: string) => p.split(sep).pop())
    expect(out.sort()).toEqual(['a.test.ts', 'b.test.ts']) // ghost 被跳过，不炸整轮
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('symlink'))).toBe(true)
  })

  it('正常递归收集不受影响（子目录下钻 + pred 过滤 + dotfile/node_modules 跳过）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = tmpDir()
    const sub = join(d, 'test')
    mkdirSync(sub)
    writeFileSync(join(sub, 'a.test.ts'), 'x')
    writeFileSync(join(sub, 'b.md'), 'y')
    writeFileSync(join(sub, '.hidden.test.ts'), 'z')
    const out = walk(d, (n: string) => n.endsWith('.test.ts')).map((p: string) => p.split(sep).pop())
    expect(out).toEqual(['a.test.ts'])
  })
})
