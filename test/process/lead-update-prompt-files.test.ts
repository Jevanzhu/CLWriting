/**
 * R-3（第十六轮复审）回归——账本推进草拟链 promptFiles 登记。
 *
 * 此前 generateLeadUpdateDraft 的 runSpec 调用不带 promptFiles：prompt 注入了
 * prune 后本章正文 + 细纲声明，llm/call promptMeta.files 却为空——铁律
 * 「模型可见 ⟺ 已记录」在 lead-update 链断裂。修复后登记正文路径 + 细纲（若在）。
 */
import { test, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateLeadUpdateDraft } from '../../src/process/lead-update-draft.js'
import { runSpec } from '../../src/ai/tasks/spec.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

vi.mock('../../src/ai/tasks/spec.js', () => ({
  runSpec: vi.fn(async () => ({ ok: true, data: { text: '- 悬念-001 递进：焦痕在烛火下泛着暗红。' }, model: 'mock' })),
}))

function makeBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'clw-leadopt-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 登记书\nhost: cc\nleads:\n  enabled: []\n', 'utf-8')
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(join(root, '写作', '正文', '0001-夜雨.md'), '---\n章号: 1\n标题: 夜雨\n---\n\n焦痕在烛火下泛着暗红。\n', 'utf-8')
  return root
}

test('R-3: lead-update promptFiles 登记本章正文 + 细纲（若在）', async () => {
  const root = makeBook()
  try {
    // 先无细纲：只登记正文
    let r = await generateLeadUpdateDraft(root, 1, null)
    expect(r.ok).toBe(true)
    let opts = vi.mocked(runSpec).mock.calls[0]![1] as unknown as { promptFiles?: string[] }
    expect(opts.promptFiles).toEqual(['写作/正文/0001-夜雨.md'])
    vi.mocked(runSpec).mockClear()

    // 有细纲：正文 + 细纲
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲。\n', 'utf-8')
    r = await generateLeadUpdateDraft(root, 1, null)
    expect(r.ok).toBe(true)
    opts = vi.mocked(runSpec).mock.calls[0]![1] as unknown as { promptFiles?: string[] }
    expect(opts.promptFiles).toEqual(['写作/正文/0001-夜雨.md', '工作区/细纲.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
