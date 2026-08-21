import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { safeManifestPath, resolveWithinRoot } from '../../src/fs/safe-path.js'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
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

  it('P5-数据层（第七轮）：字面 .. 开头文件名（..草稿.md）不再误杀，真穿越仍拦', () => {
    // 旧 startsWith('..') 把目录内真实名为 ..xxx 的文件误判穿越（fail-closed 拒正常操作）；
    // 段级判定后只拦 ../ 与 ..\（及裸 ..）两种真出根形态
    mkdirSync(join(dir, '写作'), { recursive: true })
    writeFileSync(join(dir, '写作', '..草稿.md'), 'x', 'utf-8')
    expect(safeManifestPath(dir, '写作/..草稿.md')).not.toBeNull()
    expect(safeManifestPath(dir, '../etc/passwd')).toBeNull()
    expect(safeManifestPath(dir, '..\\etc\\passwd')).toBeNull() // Windows 分隔符形态
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

// 批 6（二轮复审）统一 canonical：各 safePath 变体（service/files/trash/desktop/style/books）
// 全部委托此处，行为契约在此集中回归
describe('resolveWithinRoot', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clw-rwr-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('拒绝空串 / NUL / .. 穿越 / 绝对路径输入', () => {
    expect(resolveWithinRoot(dir, '')).toBeNull()
    expect(resolveWithinRoot(dir, 'a\0b.md')).toBeNull()
    expect(resolveWithinRoot(dir, '../../etc/passwd')).toBeNull()
    expect(resolveWithinRoot(dir, '/etc/passwd')).toBeNull()
  })

  it('拒绝落到 root 自身的输入（. / a/..）——书路径=书库自身即非法', () => {
    expect(resolveWithinRoot(dir, '.')).toBeNull()
    expect(resolveWithinRoot(dir, 'a/..')).toBeNull()
  })

  it('目标不存在 → 返回 resolve 结果 + posix 规范化 rel（新建场景）', () => {
    const r = resolveWithinRoot(dir, '写作/正文/0001-测试.md')
    expect(r).not.toBeNull()
    expect(r!.abs.startsWith(dir)).toBe(true)
    expect(r!.rel).toBe('写作/正文/0001-测试.md')
    // 段内 .. 规范化后仍在 root 内 → 放行且 rel 为规范化结果
    const r2 = resolveWithinRoot(dir, '设定/子/../总纲.md')
    expect(r2!.rel).toBe('设定/总纲.md')
  })

  it('目标存在 → abs 为 realpath、rel 为真实相对路径', () => {
    mkdirSync(join(dir, '设定'), { recursive: true })
    writeFileSync(join(dir, '设定', '总纲.md'), 'x')
    const r = resolveWithinRoot(dir, '设定/总纲.md')
    expect(r!.abs).toBe(realpathSync(join(dir, '设定', '总纲.md')))
    expect(r!.rel).toBe('设定/总纲.md')
  })

  it('symlink 指向 root 外 → null（双侧 realpath 消解 /var→/private/var 前缀差）', () => {
    symlinkSync(tmpdir(), join(dir, 'evil'))
    writeFileSync(join(tmpdir(), 'secret-rwr.md'), 'test')
    try {
      expect(resolveWithinRoot(dir, 'evil/secret-rwr.md')).toBeNull()
    } finally {
      rmSync(join(tmpdir(), 'secret-rwr.md'), { force: true })
    }
  })
})
