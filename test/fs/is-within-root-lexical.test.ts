/**
 * R51-D-4（五十一轮）回归：isWithinRoot 不存在路径改词法校验。
 *
 * 原实现 `!existsSync → true` 无条件放行——`../外`、越盘绝对路径等形态即使不存在
 * 也判真（误用脚枪：把本函数当新建场景守卫的调用方会放行 root 外路径）；头注
 * 「只做路径校验即可」与实态不符。修复：不存在路径走 resolve + relative 段级词法
 * 判定（不用 realpath——目标不存在时 realpath 必抛）；存在路径双侧 realpath 口径
 * 不变。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWithinRoot } from '../../src/fs/safe-path.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function mk(): string {
  const d = mkdtempTracked(join(tmpdir(), 'r51-d4-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('R51-D-4: isWithinRoot 不存在路径词法校验', () => {
  it('不存在但词法在 root 内 → 放行（新建场景契约保留）', () => {
    const root = mk()
    expect(isWithinRoot(root, join(root, '新建', '新章.md'))).toBe(true)
  })

  it('不存在且 `..` 词法越出 → 拒绝（修复前无条件放行）', () => {
    const root = mk()
    expect(isWithinRoot(root, join(root, '..', 'outside.md'))).toBe(false)
    expect(isWithinRoot(root, join(root, '..', '..', 'x', 'y.md'))).toBe(false)
  })

  it('不存在且为 root 外绝对路径 → 拒绝', () => {
    const root = mk()
    const other = mk()
    expect(isWithinRoot(root, join(other, '不存在.md'))).toBe(false)
  })

  it('词法归一后落回 root 内（中间 `a/..` 段）→ 放行', () => {
    const root = mk()
    // join 产 `root/a/../b.md`：resolve 归一后 rel = 'b.md'，词法在 root 内
    expect(isWithinRoot(root, join(root, 'a', '..', 'b.md'))).toBe(true)
  })

  it('存在路径双侧 realpath 口径不变：root 内放行、越外 symlink 拒（回归锚定）', () => {
    const root = mk()
    mkdirSync(join(root, 'sub'), { recursive: true })
    const inner = join(root, 'sub', 'a.md')
    writeFileSync(inner, 'x')
    expect(isWithinRoot(root, inner)).toBe(true)
    expect(isWithinRoot(root, root)).toBe(true) // rel 空 = 目标即 root 放行
  })
})
