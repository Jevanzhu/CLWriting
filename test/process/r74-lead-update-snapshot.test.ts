/**
 * R74-4（二十二轮）：账本推进覆盖前快照留底回归（对齐 R71-9 onboard 先例）。
 *
 * lead-updates 生成是分钟级窗口，作者可经 PUT /file 手改 工作区/账本推进.md
 * （files.ts WORKDIR_EDITABLE 白名单恰含此文件，与生成闸互不相查）——生成完成的
 * 覆盖写此前把手改静默丢失。修复后 archive（他章草稿 rename 归档保全）之后、
 * atomicWriteFile 之前 snapshotBeforeOverwrite 留底（标签 lead-updates-overwrite
 * → 快照 fm「来源:」行），fail-open 不阻断主流程。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateLeadUpdateDraft } from '../../src/process/lead-update-draft.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const ARCHIVE_DIR = join('工作区', '.账本推进暂存')

/** 造一本有布线的书 + 第 1 章正文（makeWiringBook/makeChapter 口径复刻 lead-update-draft.test.ts） */
function makeBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r74-lead-snap-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '0001-雨夜.md'),
    '---\n章号: 1\n标题: 雨夜\n---\n\n山门外的钟声在雨夜里连响了三下。\n',
    'utf-8',
  )
  return root
}

/** 递归收集目录下全部文件绝对路径 */
function listFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}

test('R74-4: 同章草稿载作者手改 → 覆盖前留底（标签 lead-updates-overwrite）+ 主文件被 AI 产出覆盖', async () => {
  const prev = process.env['CLWRITING_DRIVER']
  process.env['CLWRITING_DRIVER'] = 'mock' // LEAD_UPDATE_SPEC mock：悬念-001 递进 + 正文原句
  try {
    const root = makeBook()
    try {
      // 同章标签（archive 不归档、直接覆盖的路径）+ 模拟生成窗口内作者手改
      writeFileSync(
        join(root, '工作区', '账本推进.md'),
        '# 第1章 账本推进\n- 悬念-001 递进：作者手改的推进证据。\n',
        'utf-8',
      )
      const versionsDir = join(root, '工作区', '.版本')
      expect(listFiles(versionsDir)).toHaveLength(0) // 前置：无版本链

      const r = await generateLeadUpdateDraft(root, 1, null)
      expect(r.ok).toBe(true)

      // 快照存在、内容 = 作者手改旧内容、标签经 fm「来源:」行可回溯
      const snaps = listFiles(versionsDir)
      expect(snaps.length).toBeGreaterThan(0)
      const hit = snaps.map((p) => readFileSync(p, 'utf8')).find((c) => c.includes('作者手改的推进证据'))
      expect(hit).toBeDefined()
      expect(hit).toContain('来源: lead-updates-overwrite')

      // 主流程不受影响：主文件被 mock 产出覆盖；同章路径无归档
      const after = readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')
      expect(after).toContain('# 第1章 账本推进')
      expect(after).toContain('- 悬念-001 递进：山门外的钟声在雨夜里连响了三下。')
      expect(after).not.toContain('作者手改的推进证据')
      expect(existsSync(join(root, ARCHIVE_DIR))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  } finally {
    if (prev === undefined) delete process.env['CLWRITING_DRIVER']
    else process.env['CLWRITING_DRIVER'] = prev
  }
})

test('R74-4: 他章草稿先被 rename 归档保全 → 不再重复留底（快照只盖真正被覆盖的同章文件）', async () => {
  const prev = process.env['CLWRITING_DRIVER']
  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    const root = makeBook()
    try {
      // 他章标签 → archive 先 rename 归档（内容已保全），主文件不存在 → 覆盖留底 no-op
      writeFileSync(
        join(root, '工作区', '账本推进.md'),
        '# 第2章 账本推进\n- 悬念-001 递进：上一章证据。\n',
        'utf-8',
      )
      const r = await generateLeadUpdateDraft(root, 1, null)
      expect(r.ok).toBe(true)

      const archived = join(root, ARCHIVE_DIR, '第2章.md')
      expect(existsSync(archived)).toBe(true)
      expect(readFileSync(archived, 'utf8')).toContain('上一章证据')
      // 归档保全路径不重复写快照
      expect(existsSync(join(root, '工作区', '.版本'))).toBe(false)
      expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf8')).toContain('# 第1章 账本推进')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  } finally {
    if (prev === undefined) delete process.env['CLWRITING_DRIVER']
    else process.env['CLWRITING_DRIVER'] = prev
  }
})
