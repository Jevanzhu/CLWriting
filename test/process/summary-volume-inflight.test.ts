/**
 * P5-管线（第七轮）回归——卷摘要并发去重（generateVolumeSummary inFlight，
 * 对齐章摘要 :122-136 模式）。定稿钩子与备料自愈同时命中同一卷时，并发窗口内
 * 不得重复调 AI 写同一文件；完成后键释放，不残留永久拒绝。
 */
import { test, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { computeRevision } from '../../src/document/revision.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { generateChapterSummary, generateVolumeSummary } from '../../src/process/summary.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let releaseVolume: (() => void) | null = null
vi.mock('../../src/ai/tasks/spec.js', () => ({
  // 章摘要立即返回；卷摘要挂起直到测试放行——制造可控的并发在途窗口
  runSpec: vi.fn(async (_spec: unknown, opts: { userPrompt: string }) => {
    if (opts.userPrompt.includes('写卷摘要')) {
      await new Promise<void>((r) => {
        releaseVolume = r
      })
    }
    return { ok: true, data: { text: '内容提要。' }, model: 'mock' }
  }),
}))

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 2 章 volume_size=2（卷 1 = 章 1/2），两章均定稿。 */
function makeBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'clw-volinflight-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 卷去重\n  volume_size: 2\nhost: cc\nleads:\n  enabled: []\n',
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

test('P5-管线（第七轮）：同卷并发只放行一个，第二个 skipped（R26-19：去重命中非失败），完成后键释放可 skipped', async () => {
  const root = makeBook()
  try {
    for (const ch of [1, 2]) {
      const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: ch, bodyAbsPath: bodyOf(root, ch) })
      expect(r.ok).toBe(true)
    }
    const first = generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    await delay(30) // 等第一个真正进入挂起的 AI 调用（在途窗口内）
    // R26-19（二十六轮）：并发去重命中 = 他人正在生成，返回 skipped（非失败）——
    // 调用方不再把「已在途」误报成自愈失败（R26-101 同步闭合）
    const second = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    expect(second.ok && second.skipped).toBe(true)
    releaseVolume!()
    const r1 = await first
    expect(r1.ok).toBe(true)
    // 键已释放：再次调用走 fresh → skipped（不因残留键永久拒绝）
    const third = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, volume: 1 })
    expect(third.ok && third.skipped).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
