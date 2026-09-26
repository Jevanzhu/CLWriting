/**
 * SIMILE_RE 排他词集：模板性收词（「群像」）不计入比喻密度（R33-29）。
 *
 * 档源：原 r33-check-fixes.test.ts 的 R33-29 组（同文件 R33-1 组并入
 * section-count-fence.test.ts、R33-5/R33-6 组并入 lead-updates-evidence-guards.test.ts、
 * R33-30 组并入 check-input-tolerance.test.ts、R33-32 组并入
 * quoted-span-dialogue-strip.test.ts）。
 */
import { test, expect } from 'vitest'
import { checkSimile } from '../../src/check/count.js'

test('R33-29: 「群像」不再计入比喻密度', () => {
  expect(checkSimile('这幅群像描写刻画了众生。', 1).items).toHaveLength(0)
})
