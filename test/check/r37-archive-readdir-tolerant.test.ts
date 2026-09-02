/**
 * R37-9（三十七轮批 B）回归：三处归档/历史目录 readdirSync 无容错。
 *
 * 根因：run.ts scanChapterUpdatesByChapter（归档账本暂存）、runner.ts（大纲/章纲
 * 前缀匹配口径）、draft.ts inferVolumeDir（正文卷扫描）的 readdirSync 裸调——
 * existsSync 守卫与 readdirSync 之间有 TOCTOU 间隙（目录被瞬删 → ENOENT），且
 * existsSync 对**文件**同样返回 true（路径被文件占用 → ENOTDIR），异常直穿把
 * 树红点聚合/机检/写章链路打成 500。修复：各包 try/catch，ENOENT/ENOTDIR 降级
 * 空列表 + log.warn 留痕（走既有缺失分支），其余错误码照旧抛（失败可见）。
 *
 * 测法（ENOENT 的 TOCTOU 间隙无法在单测稳定制造，ENOTDIR 走同一 catch 分支）：
 * 把目标路径放同名**文件**——existsSync 为 true、readdirSync 抛 ENOTDIR，
 * 修复前直穿炸链路，修复后降级不抛。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTreeIssues } from '../../src/check/run.js'
import { runAllChecks } from '../../src/check/runner.js'
import { inferVolumeDir } from '../../src/format/draft.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import type { ChapterMeta, BookConfig } from '../../src/format/types.js'

/** 造一本 1 章正文的最小书（无布线 → collectTreeIssues 走无 db 路径，隔离单变量） */
function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'r37-readdir-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  // 禁词红源（tree-issues-scan-count 同款）：该章机检必红 → issues 必非空，
  // 证明链路真的穿过了归档预扫（scanChapterUpdatesByChapter）走到逐章机检
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nleads:\n  enabled: []\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  writeFileSync(
    join(root, '写作', '正文', '001-第1章.md'),
    '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，玉佩，连响了三下。\n',
    'utf-8',
  )
  upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: '写作/正文/001-第1章.md', parentId: null })
  writeManifest(manifestPath, m)
  return root
}

test('R37-9: run.ts 归档暂存被文件占用（ENOTDIR）不炸树红点聚合（修复前直穿 500）', () => {
  const root = makeBook()
  try {
    // 归档目录路径放同名文件：existsSync 为 true → readdirSync 抛 ENOTDIR
    mkdirSync(join(root, '工作区'))
    writeFileSync(join(root, '工作区', '.账本推进暂存'), 'not a dir', 'utf-8')
    // 修复前：scanChapterUpdatesByChapter 的 readdirSync ENOTDIR 直穿 collectTreeIssues
    // （外层仅 finally 无 catch）→ 树红点端点 500；修复后降级空列表正常返回
    const r = collectTreeIssues(root, () => undefined)
    expect(Object.keys(r.issues)).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R37-9: runner.ts 章纲目录被文件占用（ENOTDIR）机检不炸，降级走章纲缺失黄项', () => {
  const root = mkdtempSync(join(tmpdir(), 'r37-runner-'))
  try {
    mkdirSync(join(root, '大纲'))
    writeFileSync(join(root, '大纲', '章纲'), 'not a dir', 'utf-8') // 同名文件占位
    const config: BookConfig = {
      ...DEFAULT_CONFIG,
      kind: 'short',
      short: { word_min: 0, word_max: 999999 },
    }
    const chapter = {
      章号: 1,
      标题: '雪夜',
      钩子类型: '悬念钩',
      钩子强弱: '中',
      情绪定位: '铺垫',
      _path: join(root, '写作', '正文', '001-雪夜.md'),
    } as unknown as ChapterMeta
    // 修复前：三口径兜底 readdirSync ENOTDIR 直穿炸整次机检；修复后降级 manifestPath
    // = null → 走既有 piece-list-outline-missing 黄项（R32-15，不静默）
    const r = runAllChecks({ bookRoot: root, config, chapter, body: '他推开门。', fileName: '001-雪夜.md' })
    const missing = r.sections
      .flatMap((s) => s.items)
      .find((it) => it.checkId === 'piece-list-outline-missing')
    expect(missing).toBeDefined()
    expect(missing!.message).toContain('未找到章纲')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R37-9: draft.ts 正文目录被文件占用（ENOTDIR）卷推断不炸，回落第一卷', () => {
  const root = mkdtempSync(join(tmpdir(), 'r37-vol-'))
  try {
    mkdirSync(join(root, '写作'))
    writeFileSync(join(root, '写作', '正文'), 'not a dir', 'utf-8') // 同名文件占位
    // 修复前：inferVolumeDir 的 readdirSync ENOTDIR 直穿炸写章链路；修复后与
    // bodyDir 不存在同一出口回落「第一卷」
    expect(inferVolumeDir(root, 5)).toBe('第一卷')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R37-9: 正文目录不存在与正常卷目录两形态不回归（既有行为对照）', () => {
  const root = mkdtempSync(join(tmpdir(), 'r37-vol-ok-'))
  try {
    // 目录整个不存在：existsSync 挡在 if 外（既有行为），照旧回落第一卷
    expect(inferVolumeDir(root, 1)).toBe('第一卷')
    // 正常卷目录：末卷照取（Z-18 数值序——第十卷 > 第四卷）
    mkdirSync(join(root, '写作', '正文', '第四卷'), { recursive: true })
    mkdirSync(join(root, '写作', '正文', '第十卷'), { recursive: true })
    expect(inferVolumeDir(root, 99)).toBe('第十卷')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
