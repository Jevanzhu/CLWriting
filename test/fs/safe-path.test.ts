import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { safeManifestPath } from '../../src/fs/safe-path.js'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// P1-R2：safe-path.ts 的 realpathSync 是命名导入，ESM 下无法 vi.spyOn 模块命名空间
//（"Cannot spy on export ... Module namespace is not configurable"）。
// 用 vi.mock 包装 realpathSync 为 vi.fn——测试里可动态 mockImplementation（见 R2 用例）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) }
})

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

  it('拒绝 NUL 字节注入', () => {
    expect(safeManifestPath(dir, 'foo\0bar.md')).toBeNull()
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

  it('R2: realpathSync 抛异常 → fail-closed 返回 null（不抛异常）', () => {
    // existsSync 返回 true 后 realpathSync 抛 ELOOP（race：existsSync 通过后文件被删/断链）。
    // 真实文件系统难以确定性构造（existsSync 对 dangling/loop symlink 均返回 false），
    // 故用 vi.mock 包装的 realpathSync 模拟——safe-path.ts 的命名导入与测试共享同一 mock 实例。
    writeFileSync(join(dir, 'target.md'), 'test')
    const spy = vi.mocked(realpathSync)
    spy.mockImplementation(() => {
      throw new Error('ELOOP: too many symbolic links encountered')
    })
    try {
      // 修复前：异常抛给调用方（batch-finalize 中断整批）；修复后：fail-closed 返回 null
      expect(safeManifestPath(dir, 'target.md')).toBeNull()
    } finally {
      spy.mockReset()
    }
  })
})
