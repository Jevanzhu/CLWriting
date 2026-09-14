/**
 * 全库重评-0914 P2-5 回归：账本推进归档在「标准名已存在」时的归并重写。
 *
 * 原行为：目标已存在时新档落 `第N章-<时间戳>.md` 变体保全两代——但两读侧
 * （check/run.ts 批量预扫 `^第(\d+)章\.md$`i + lead-updates.chapterUpdateSources
 * 精确路径）均只认标准名，第二代归档对两端闭合判定与 finalize 回写不可见。
 * 修复后：读旧档 + 按（编号,动词）归并重写标准名（同键新声明覆盖旧证据，旧条目
 * 保序保全），归并不可行时（旧档读失败/新档解析零条目）回落时间戳变体。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archivePendingLeadUpdates } from '../../src/process/lead-update-draft.js'
import { LEAD_UPDATES_FILE, LEAD_UPDATES_ARCHIVE_DIR, parseLeadUpdateLines } from '../../src/check/lead-updates.js'

/** 造书根：只有归档目录（archivePendingLeadUpdates 不读书配置） */
function makeRoot(tag: string): string {
  const root = mkdtempTracked(join(tmpdir(), `r0914b-lead-merge-${tag}-`))
  mkdirSync(join(root, '工作区'), { recursive: true })
  return root
}

function writeMain(root: string, text: string): void {
  writeFileSync(join(root, LEAD_UPDATES_FILE), text, 'utf-8')
}

function readStandard(root: string, tag: number): string {
  return readFileSync(join(root, LEAD_UPDATES_ARCHIVE_DIR, `第${tag}章.md`), 'utf-8')
}

test('P2-5：标准名已存在 → 归并重写（旧条目保序保全 + 新键追加），旧证据被同键新声明覆盖', () => {
  const root = makeRoot('merge')
  try {
    const dir = join(root, LEAD_UPDATES_ARCHIVE_DIR)
    mkdirSync(dir, { recursive: true })
    // 旧档（第一代归档）：两条，其一与新档同键
    writeFileSync(
      join(dir, '第3章.md'),
      '# 第3章 账本推进\n- 悬念-001 递进：旧证据甲。\n- 线索-002 起步：旧证据乙。\n',
      'utf-8',
    )
    // 主文件载他章（tag=3，forChapter=5）→ 触发归档
    writeMain(root, '# 第3章 账本推进\n- 悬念-001 递进：新证据甲。\n- 成长线-007 推进：全新证据丙。\n')

    archivePendingLeadUpdates(root, 5)

    // 源文件已删除（归并路径同样清走主文件）
    expect(existsSync(join(root, LEAD_UPDATES_FILE))).toBe(false)
    // 无时间戳变体产生
    expect(readdirSync(dir).filter((f) => f.includes('-'))).toEqual([])
    // 标准名内容 = 归并结果：旧序保留，同键覆盖，新键追加
    const text = readStandard(root, 3)
    expect(parseLeadUpdateLines(text)).toEqual([
      { leadId: '悬念-001', 动词: '递进', 证据: '新证据甲。' },
      { leadId: '线索-002', 动词: '起步', 证据: '旧证据乙。' },
      { leadId: '成长线-007', 动词: '推进', 证据: '全新证据丙。' },
    ])
    expect(text.startsWith('# 第3章 账本推进\n')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P2-5：新档解析零有效条目 → 回落时间戳变体，旧标准名原文不动', () => {
  const root = makeRoot('fallback-empty')
  try {
    const dir = join(root, LEAD_UPDATES_ARCHIVE_DIR)
    mkdirSync(dir, { recursive: true })
    const oldText = '# 第3章 账本推进\n- 悬念-001 递进：旧证据甲。\n'
    writeFileSync(join(dir, '第3章.md'), oldText, 'utf-8')
    // 有 `-` 行（过 hasEntries 门）但不成条目格式：解析零条
    writeMain(root, '# 第3章 账本推进\n- 格式不合法行\n')

    archivePendingLeadUpdates(root, 5)

    expect(readStandard(root, 3)).toBe(oldText) // 旧档原文逐字节不动
    const variants = readdirSync(dir).filter((f) => f !== '第3章.md')
    expect(variants).toHaveLength(1)
    expect(variants[0]!.startsWith('第3章-')).toBe(true) // 新档原文保全在变体
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P2-5：标准名不存在 → 维持 rename 直归档（行为不回归）', () => {
  const root = makeRoot('plain')
  try {
    writeMain(root, '# 第7章 账本推进\n- 悬念-001 递进：证据甲。\n')
    archivePendingLeadUpdates(root, 2)
    expect(existsSync(join(root, LEAD_UPDATES_FILE))).toBe(false)
    expect(parseLeadUpdateLines(readStandard(root, 7))).toEqual([
      { leadId: '悬念-001', 动词: '递进', 证据: '证据甲。' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P2-5：归并读侧闭环——readChapterUpdatesForChapterChecked 可见归并后条目', async () => {
  const root = makeRoot('closure')
  try {
    const dir = join(root, LEAD_UPDATES_ARCHIVE_DIR)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '第4章.md'), '# 第4章 账本推进\n- 悬念-001 递进：旧证据甲。\n', 'utf-8')
    writeMain(root, '# 第4章 账本推进\n- 悬念-001 递进：新证据甲。\n- 线索-009 起步：证据乙。\n')

    archivePendingLeadUpdates(root, 6)

    const { readChapterUpdatesForChapterChecked } = await import('../../src/check/lead-updates.js')
    const res = readChapterUpdatesForChapterChecked(root, 4)
    expect(res.unreadable).toBe(false)
    expect(res.updates).toEqual([
      { leadId: '悬念-001', 动词: '递进', 证据: '新证据甲。' },
      { leadId: '线索-009', 动词: '起步', 证据: '证据乙。' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
