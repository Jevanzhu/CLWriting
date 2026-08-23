/**
 * Y-5（第五十七轮）回归——resolveWithinRoot 对不存在目标的中间 symlink 校验。
 *
 * 缺陷：realpath 双侧防线只覆盖目标存在的分支；`linkdir/new.md`（linkdir 指向书外、
 * new.md 不存在）经词法 resolve 放行 → 调用方在书外创建文件（可篡改 manifest.path
 * 的 defense-in-depth 失守）。修复：目标不存在时取最近存在祖先做同款双侧校验。
 * 顺带锁定：书内 symlink 重定向（合法形态）解析到真实路径放行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveWithinRoot } from '../../src/fs/safe-path.js'

let root: string
let outside: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-y5-'))
  outside = mkdtempSync(join(tmpdir(), 'clw-y5-out-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('Y-5: 不存在目标的中间 symlink', () => {
  it('linkdir 指向书外 + 新建目标 → 拒绝（null）', () => {
    mkdirSync(join(root, '写作'), { recursive: true })
    symlinkSync(outside, join(root, '写作', 'linkdir'))
    expect(resolveWithinRoot(root, '写作/linkdir/新章.md')).toBeNull()
  })

  it('linkdir 指向书内（合法重定向）+ 新建目标 → 解析到真实路径放行', () => {
    mkdirSync(join(root, '写作'), { recursive: true })
    mkdirSync(join(root, '设定'), { recursive: true })
    symlinkSync(join(root, '设定'), join(root, '写作', 'linkdir'))
    const r = resolveWithinRoot(root, '写作/linkdir/新章.md')
    expect(r).not.toBeNull()
    // 契约：不存在目标返回词法路径（校验经 realpath，返回不随重定向走）
    expect(r!.rel).toBe('写作/linkdir/新章.md')
  })

  it('无 symlink 的普通新建路径不受影响（既有行为保持）', () => {
    const r = resolveWithinRoot(root, '写作/正文/第一卷/0005-新章.md')
    expect(r).not.toBeNull()
    expect(r!.rel).toBe('写作/正文/第一卷/0005-新章.md')
  })
})
