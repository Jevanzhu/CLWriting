/**
 * 工作区续跑（态 4 中断点判定）测试。
 *
 * 工单施工序 3-4 验证点：态 4 续跑判定（#13 第 5 节中断点：pre-finalize 续写）。
 * （git 人话层小节已随 exec.ts 死代码清理移除。）
 */

import { test, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { makeGitBook, stageIncompleteChapter } from '../helpers/book.js'
import { detectState, routeState } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'


// ── 态 4 续跑：中断点判定（#13 第 5 节）──────────────

test('态4: 草稿未定稿 → pre-finalize 续写', () => {
  const root = makeGitBook()
  stageIncompleteChapter(root, 1) // 正文区草稿+细纲+.confirm，未定稿

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(4)
  if (d.state === 4) {
    expect(d.resumePoint).toBe('pre-finalize')
    const r = routeState(d)
    expect(r.humanMsg).toContain('接着干')
    expect(r.humanMsg).toContain('续写')
  }
  rmSync(root, { recursive: true, force: true })
})
