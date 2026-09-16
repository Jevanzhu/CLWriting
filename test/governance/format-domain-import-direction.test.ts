/**
 * R0916-6-P2-2（2026-09-16 五轮全库重评修复批）回归：format 域零 document 反向
 * 依赖（域环消除）。历史缺陷：format/draft.ts 的 resolveDraftPath 内嵌定稿覆盖
 * 守卫直接 import document/manifest——底座 format 依赖上层 document 的分层倒挂
 * （环风险边）。修复：守卫族整体上移 document/draft-path.ts（W-P1-5 契约随迁
 * 不变），本门防回归：src/format/*.ts 不得出现 '../document/' 相对 import。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('R0916-6-P2-2：format 域 import 方向锁', () => {
  it('src/format/*.ts 零 ../document/ 反向 import', () => {
    const dir = fileURLToPath(new URL('../../src/format', import.meta.url))
    const violations: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      const text = readFileSync(join(dir, f), 'utf-8')
      if (/'\.\.\/document\//.test(text)) violations.push(f)
    }
    expect(violations).toEqual([])
  })
})
