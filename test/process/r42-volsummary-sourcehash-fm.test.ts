/**
 * R42-36（四十二轮）：卷摘要 sourceHash 指纹只认 fm 段（splitFrontMatter 后只搜 fmRaw）。
 *
 * 此前三处（generateVolumeSummary / selfHealVolumeSummary / volumeSummaryProvablyStale）
 * 对整文件 grep `/^sourceHash:/m`——摘要正文含行首 `sourceHash: …`（作者引用/示例文本）
 * 时：fm 缺指纹的手写产物被误判程序生成（M-7 作者优先失守、被重生成覆盖）、
 * fresh/stale 判定被正文污染。对齐章摘要侧 chapterSummaryState 先例（先 split 再搜 fm）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateChapterSummary,
  generateVolumeSummary,
  selfHealVolumeSummary,
  volumeSummaryProvablyStale,
  volumeSummaryPath,
  chapterSummaryPath,
  effectiveConfig,
} from '../../src/process/summary.js'
import { computeRevision } from '../../src/document/revision.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const dirs: string[] = []

beforeEach(() => {
  process.env['CLWRITING_DRIVER'] = 'mock'
})

afterEach(() => {
  delete process.env['CLWRITING_DRIVER']
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 造书：volumeSize=2、章 1/2 定稿并生成章摘要（链完整，卷 1 可判定指纹） */
function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-r42-volhash-'))
  dirs.push(root)
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 卷指纹测试书\n  volume_size: 2\nhost: cc\nleads:\n  enabled: []\n',
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

/** 章摘要链就绪（mock 生成章 1/2）→ 返回生效配置 */
async function readyChain(root: string) {
  const config = effectiveConfig(root, null)
  for (const ch of [1, 2]) {
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config, chapter: ch, bodyAbsPath: bodyOf(root, ch) })
    expect(r.ok).toBe(true)
  }
  return config
}

/** 从卷摘要文件取 fm 内的链指纹（测试侧辅助，与实现同形正则） */
const fmHashOf = (raw: string): string | null => /^sourceHash:\s*(\S+)/m.exec(raw)?.[1] ?? null

describe('R42-36: 卷摘要 sourceHash 只认 fm 段', () => {
  it('程序生成 + 正文混入行首假指纹 → fresh 判定不受污染（generate skipped / 非 stale）', async () => {
    const root = makeBook()
    const config = await readyChain(root)
    expect((await generateVolumeSummary({ bookRoot: root, userDataPath: null, config, volume: 1 })).ok).toBe(true)
    // 正文追加行首假指纹（fm 指纹仍是真实链指纹）
    const fp = volumeSummaryPath(root, 1)
    const raw = readFileSync(fp, 'utf-8')
    const realHash = fmHashOf(raw)
    expect(realHash).toMatch(/^sha256:/)
    writeFileSync(fp, `${raw}\nsourceHash: deadbeef\n正文里引用指纹样式的行。\n`, 'utf-8')
    // generateVolumeSummary：链未变 → 仍 skipped（fm 值生效，不因正文行误判过期重生成）
    const again = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config, volume: 1 })
    expect(again.ok && again.skipped).toBe(true)
    // volumeSummaryProvablyStale：fm 指纹与当前链一致 → false
    expect(volumeSummaryProvablyStale(root, 1, 2)).toBe(false)
  })

  it('fm-less 手写产物 + 正文行首 sourceHash → generateVolumeSummary 不误判 fresh（重生成补 fm）', async () => {
    const root = makeBook()
    const config = await readyChain(root)
    expect((await generateVolumeSummary({ bookRoot: root, userDataPath: null, config, volume: 1 })).ok).toBe(true)
    // 改写成 fm-less 手写形态，正文引用了「当前真实链指纹」——修复前整文件 grep 命中
    // 正文行 → m[1] === fingerprint → 误判 fresh 走 skipped
    const realHash = fmHashOf(readFileSync(volumeSummaryPath(root, 1), 'utf-8'))!
    writeFileSync(volumeSummaryPath(root, 1), `作者手写卷摘，正文引用当前链指纹：\nsourceHash: ${realHash}\n`, 'utf-8')
    const r = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config, volume: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.skipped).toBe(false) // 无 fm 指纹 → 不 skipped，走重生成
    const rewritten = readFileSync(volumeSummaryPath(root, 1), 'utf-8')
    expect(rewritten).toContain('---') // 重生成落回带 fm 的程序形态
    expect(fmHashOf(rewritten)).toBe(realHash)
  })

  it('fm-less 手写产物 + 正文行首 sourceHash → selfHeal 按作者产物跳过（M-7 不被正文伪装）', async () => {
    const root = makeBook()
    const config = await readyChain(root)
    const hand = `# 第 1 卷\n\n作者手写，正文提到指纹样式：\nsourceHash: deadbeef\n一字不动。\n`
    mkdirSync(join(root, '定稿', '摘要', '卷摘要'), { recursive: true })
    writeFileSync(volumeSummaryPath(root, 1), hand, 'utf-8')
    // 修复前：整文件 grep 命中 deadbeef ≠ 当前链指纹 → 误判程序生成过期 → 重生成覆盖
    expect(await selfHealVolumeSummary(root, null, config, 3)).toBeNull()
    expect(readFileSync(volumeSummaryPath(root, 1), 'utf-8')).toBe(hand)
  })

  it('fm-less 手写产物 + 正文行首 sourceHash → volumeSummaryProvablyStale 不误报过期', async () => {
    const root = makeBook()
    await readyChain(root) // 链完整非空（判据可达）
    const hand = `作者手写卷摘。\nsourceHash: deadbeef\n`
    mkdirSync(join(root, '定稿', '摘要', '卷摘要'), { recursive: true })
    writeFileSync(volumeSummaryPath(root, 1), hand, 'utf-8')
    // 修复前：deadbeef ≠ 当前链指纹 → 误报 true（备料陈旧闸拒注入手写产物）
    expect(volumeSummaryProvablyStale(root, 1, 2)).toBe(false)
  })

  it('程序生成 + 链变动（fm 指纹过时）→ stale 判定照常（回归锚）', async () => {
    const root = makeBook()
    const config = await readyChain(root)
    expect((await generateVolumeSummary({ bookRoot: root, userDataPath: null, config, volume: 1 })).ok).toBe(true)
    // 模拟章摘要重生成 → 链指纹变（M-7 既有口径）
    writeFileSync(chapterSummaryPath(root, 1), '---\nchapter: 1\nsourceHash: 旧\n---\n新的第 1 章摘要内容。', 'utf-8')
    expect(volumeSummaryProvablyStale(root, 1, 2)).toBe(true)
    const vol = await selfHealVolumeSummary(root, null, config, 3)
    expect(vol).toBe('定稿/摘要/卷摘要/1.md') // R71-15：posix 口径
    const r = await generateVolumeSummary({ bookRoot: root, userDataPath: null, config, volume: 1 })
    expect(r.ok && r.skipped).toBe(true) // 重生成后新链指纹 → fresh
  })
})
