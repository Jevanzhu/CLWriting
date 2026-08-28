/**
 * R-2（第十六轮复审）回归——章/卷摘要 promptMeta.files 登记真实注入源。
 *
 * 此前章摘要登记输出文件（定稿/摘要/章摘要/N.md）、卷摘要登记输出文件
 * （定稿/摘要/卷摘要/N.md），而模型实际注入的是正文 / 章摘要链——铁律
 * 「模型可见 ⟺ 已记录」在摘要两条链断裂。修复后：
 * - 章摘要 promptFiles = 正文相对路径（写作/正文/NNN-标题.md）
 * - 卷摘要 promptFiles = 实际注入的章摘要文件列表
 */
import { test, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { computeRevision } from '../../src/document/revision.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { generateChapterSummary, generateVolumeSummary } from '../../src/process/summary.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

vi.mock('../../src/ai/tasks/spec.js', () => ({
  runSpec: vi.fn(async () => ({ ok: true, data: { text: '情节推进：测试。' }, model: 'mock' })),
}))

/** 2 章 volume_size=2（卷 1 = 章 1/2），两章均定稿 */
function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-sumfiles-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 摘要登记\n  volume_size: 2\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= 2; no++) {
    const pad = String(no).padStart(3, '0')
    const p = join(root, '写作', '正文', `${pad}-第${no}章.md`)
    writeFileSync(p, `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${no}章正文。\n`, 'utf-8')
    const id = generateDocId()
    upsertEntry(m, { id, nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
    const e = m.entries.get(id)!
    e.finalizedRevision = computeRevision(p)
    e.finalizedAt = new Date().toISOString()
  }
  writeManifest(manifestPath, m)
  return root
}

const bodyOf = (root: string, no: number): string => join(root, '写作', '正文', `${String(no).padStart(3, '0')}-第${no}章.md`)

test('R-2: 章摘要 promptFiles 登记正文路径（注入源），非输出文件', async () => {
  const root = makeBook()
  try {
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(r.ok).toBe(true)
    const { runSpec } = await import('../../src/ai/tasks/spec.js')
    const opts = vi.mocked(runSpec).mock.calls[0]![1] as unknown as { promptFiles?: string[] }
    expect(opts.promptFiles).toEqual(['写作/正文/001-第1章.md']) // 真实注入源：draft.body 所在正文
    expect(opts.promptFiles).not.toContain('定稿/摘要/章摘要/1.md') // 不再登记输出文件（R71-15：posix 字面量口径）
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R-2: 卷摘要 promptFiles 登记实际注入的章摘要文件列表，非输出文件', async () => {
  const root = makeBook()
  try {
    for (const ch of [1, 2]) {
      const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: ch, bodyAbsPath: bodyOf(root, ch) })
      expect(r.ok).toBe(true)
    }
    const { runSpec } = await import('../../src/ai/tasks/spec.js')
    vi.mocked(runSpec).mockClear()
    const v = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    expect(v.ok).toBe(true)
    const opts = vi.mocked(runSpec).mock.calls[0]![1] as unknown as { promptFiles?: string[] }
    // 真实注入源：chainText 的两个章摘要文件（按注入序；R71-15：posix 字面量口径——
    // 修复前 join() 在 win 产反斜杠，与全库相对路径口径分裂）
    expect(opts.promptFiles).toEqual(['定稿/摘要/章摘要/1.md', '定稿/摘要/章摘要/2.md'])
    expect(opts.promptFiles).not.toContain('定稿/摘要/卷摘要/1.md') // 不再登记输出文件
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
