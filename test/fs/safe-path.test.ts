import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { safeManifestPath } from '../../src/fs/safe-path.js'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('safeManifestPath', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clw-safepath-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('拒绝绝对路径', () => {
    expect(safeManifestPath(dir, '/etc/passwd')).toBeNull()
  })

  it('拒绝 .. 穿越', () => {
    expect(safeManifestPath(dir, '../../../etc/passwd')).toBeNull()
  })

  it('接受正常相对路径（文件不存在 — 新建场景）', () => {
    const result = safeManifestPath(dir, '写作/正文/0001-测试.md')
    expect(result).not.toBeNull()
    expect(result!.startsWith(dir)).toBe(true)
  })

  it('接受不存在的浅层文件', () => {
    expect(safeManifestPath(dir, '新文件.md')).not.toBeNull()
  })

  it('拒绝 symlink 指向 bookRoot 外（文件已存在场景）', () => {
    // 创建 dir 内的 symlink 指向 dir 外（tmpdir），并在目标处放一个文件
    symlinkSync(tmpdir(), join(dir, 'evil'))
    writeFileSync(join(tmpdir(), 'secret.md'), 'test')
    // evil/secret.md → resolves to tmpdir/secret.md，在 dir 外 → 拒绝
    expect(safeManifestPath(dir, 'evil/secret.md')).toBeNull()
    // 清理 symlink 目标文件（防污染 tmpdir）
    rmSync(join(tmpdir(), 'secret.md'), { force: true })
  })
})
