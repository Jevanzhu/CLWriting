/**
 * CC-P1-6 回归：短篇集编号断档时 nextChapter 不得回指已定稿篇号。
 *
 * 场景：定稿 1、2、5（删除/回收 3、4）——旧算式 max(篇数+1, 最大文件名号)=5
 * 会算出 nextChapter=5，resolveDraftPath 的防覆盖闸（V-P2-2/W-P2-2）fail-loud
 * 抛错，写作流卡死。修复：跳过已定稿章号（篇号永不复用），但**只跳定稿**——
 * V-P1-3 场景（坏 fm 草稿占号）的恢复语义是落号覆盖草稿，不能跳。
 */
import { test, expect } from 'vitest'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeGitBook } from '../helpers/book.js'
import { detectState, buildRecap } from '../../src/state/state.js'
import { resolveDraftPath } from '../../src/format/draft.js'
import { DEFAULT_CONFIG, writeBookConfig } from '../../src/format/yaml.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

/** 造一本短篇书（book.yaml kind:short + 无 布线/ 目录），并按给定篇号落定稿文件 + manifest 定稿基线。 */
function makeShortBookWithFinalized(nums: number[]): string {
  const root = makeGitBook()
  // 短篇书形态：kind: short + 无布线（detectState 按 布线/ 存在性分轨）。
  // R29-8（二十九轮）：healthCheck 对「长篇 kind 且 布线/ 缺失」报 wiringMissing 健康项
  // ——本夹具必须落真实的 kind: short（只删布线目录的长篇书现在按设计进态 1 体检）。
  rmSync(join(root, '布线'), { recursive: true, force: true })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)

  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  for (const n of nums) {
    const rel = `写作/正文/${String(n).padStart(3, '0')}-第${n}篇.md`
    const abs = join(root, rel)
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(
      abs,
      `---\n章号: ${n}\n标题: 第${n}篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${n}篇正文。\n`,
      'utf-8',
    )
    upsertEntry(m, {
      id: generateDocId(), nodeType: 'document', path: rel, parentId: null,
      finalizedRevision: computeRevision(abs), finalizedAt: new Date().toISOString(),
    })
  }
  writeManifest(manifestPath, m)
  return root
}

test('CC-P1-6:定稿 1、2、5 断档 → nextChapter=6 而非回指已定稿 5', () => {
  const root = makeShortBookWithFinalized([1, 2, 5])
  try {
    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(7)
    if (d.state === 7) {
      // 旧算式：max(3+1, 5)=5 → 回指已定稿第 5 篇；修复后跳过 5
      expect(d.nextChapter).toBe(6)
      // 执行面同口径：落稿路径可解析（不抛防覆盖闸）
      expect(() => resolveDraftPath(root, d.nextChapter)).not.toThrow()
      expect(resolveDraftPath(root, d.nextChapter).existed).toBe(false)
      // 反证防线仍在：直接指 5 依旧被防覆盖闸拦截
      expect(() => resolveDraftPath(root, 5)).toThrow(/已定稿/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CC-P1-6:连续定稿 1、2、3 → nextChapter=4（零断档零跳号，行为不变）', () => {
  const root = makeShortBookWithFinalized([1, 2, 3])
  try {
    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(7)
    if (d.state === 7) expect(d.nextChapter).toBe(4)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CC-P1-6:V-P1-3 语义保留——坏 fm 草稿占号走态 4 续写覆盖，不被跳号', () => {
  const root = makeShortBookWithFinalized([1, 2, 3])
  try {
    // 坏 fm 草稿占 004（无 front matter，readChapterDir 不计入 chapters 但文件名占号）
    writeFileSync(join(root, '写作', '正文', '004-坏草稿.md'), '没有 front matter 的草稿', 'utf-8')
    const d = detectState(root, SHORT_CONFIG)
    // 草稿在正文 → detectIncompleteWorkdir 捕获，走态 4 续写（覆盖草稿的恢复语义在态 4 通道）
    expect(d.state).toBe(4)
    if (d.state === 4) {
      // 落号 4（草稿占号不被跳），且未定稿不触发防覆盖闸
      expect(d.chapterNum).toBe(4)
      expect(() => resolveDraftPath(root, d.chapterNum)).not.toThrow()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CC-P1-6:buildRecap 提示号与 detectState 执行号同口径（断档 → 6）', () => {
  const root = makeShortBookWithFinalized([1, 2, 5])
  try {
    const d = detectState(root, SHORT_CONFIG)
    const recap = buildRecap(root, SHORT_CONFIG, d)
    // 旧口径：currentChapter=4 → 提示「开始写第 5 章」回指定稿；修复后与执行号一致
    expect(recap.nextChapter).toBe(6)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
