import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectDocSignals,
  collectDocSignalsAsync,
  harvestStyleCandidates,
  harvestStyleCandidatesAsync,
} from '../../src/process/style-harvest.js'
import { recordAiVersion } from '../../src/git/ai-track.js'
import { execFileSync } from 'node:child_process'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-harvest-async-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 建带 git 轨迹的最小书：recordAiVersion 需要 .git（写侧 R36-5 语义）。 */
function makeTrackedBook(): void {
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: short\nbook:\n  title: 异步收割\n')
  writeFileSync(
    join(root, '写作', '正文', '001-雨夜.md'),
    '---\n章号: 1\n标题: 雨夜\n---\n## 开头\n\n门外没有脚印。\n\n## 反转\n\n来客笑了。',
  )
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n- 正文纯文本\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
  recordAiVersion(root, '001-雨夜', 'AI 草稿旧段。')
}

test('R37-5 延伸：collectDocSignalsAsync 与同步版等价（有轨迹 / 无轨迹双臂）', async () => {
  makeTrackedBook()
  const text = `${'AI 草稿旧段。'.repeat(3)}\n\n作者新写的长段落，与 AI 版形成 gap。`
  const syncR = collectDocSignals(root, '001-雨夜', text, 1)
  const asyncR = await collectDocSignalsAsync(root, '001-雨夜', text, 1)
  expect(syncR).not.toBeNull()
  expect(asyncR).toEqual(syncR)
  // 无轨迹 doc：双臂同 null
  expect(await collectDocSignalsAsync(root, 'doc_没轨迹', '正文')).toBeNull()
  expect(collectDocSignals(root, 'doc_没轨迹', '正文')).toBeNull()
})

test('R37-5 延伸：harvestStyleCandidatesAsync 与同步版等价（空书安全臂）', async () => {
  mkdirSync(join(root, '写作'), { recursive: true })
  const syncR = harvestStyleCandidates(root, 'short', '2026-09-02')
  const asyncR = await harvestStyleCandidatesAsync(root, 'short', '2026-09-02')
  expect(asyncR).toEqual(syncR)
  expect(asyncR.created).toEqual([])
})
