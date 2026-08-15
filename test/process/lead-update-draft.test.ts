/**
 * 账本推进草拟（W-P1-3 右端）单元测试。
 *
 * 覆盖：
 * - parseLeadUpdateDraft：编号白名单 + 动词合法表过滤（臆造编号/非法动词被剔除）
 * - buildLeadUpdatePrompt：注入正文 + 细纲声明 + 进行中账本
 * - 与 check/lead-updates.ts 读取格式同构（两端闭合右侧数据源闭环）
 */
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseLeadUpdateDraft,
  buildLeadUpdatePrompt,
  generateLeadUpdateDraft,
  archivePendingLeadUpdates,
} from '../../src/process/lead-update-draft.js'
import { readChapterLeadUpdates } from '../../src/check/lead-updates.js'

/** 造一本有布线的短书（book.yaml + 布线/悬念 一条进行中线） */
function makeWiringBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'lead-draft-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  // 悬念-001 进行中
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  // 成长线-001 未启用类 → 不在白名单
  return root
}

test('parseLeadUpdateDraft: 合法行保留，臆造编号/非法动词剔除', () => {
  const root = makeWiringBook()
  try {
    const text = [
      '# 本章账本推进',
      '- 悬念-001 递进：焦痕在烛火下泛着暗红。',
      '- 悬念-999 递进：臆造编号应被剔除。',
      '- 悬念-001 胡诌：非法动词应被剔除。',
      '- 成长线-001 起步：未启用类不在白名单。',
    ].join('\n')
    const out = parseLeadUpdateDraft(text, root)
    expect(out).toEqual([{ leadId: '悬念-001', 动词: '递进', 证据: '焦痕在烛火下泛着暗红。' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseLeadUpdateDraft: 无推进 → 空数组', () => {
  const root = makeWiringBook()
  try {
    expect(parseLeadUpdateDraft('无推进', root)).toEqual([])
    expect(parseLeadUpdateDraft('', root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildLeadUpdatePrompt: 注入正文 + 细纲声明 + 进行中账本', () => {
  const root = makeWiringBook()
  try {
    // 细纲声明推进 悬念-001（带章号 1）
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: [悬念-001]\n---\n\n本章细纲正文。\n', 'utf-8')
    const prompt = buildLeadUpdatePrompt(root, 1, '焦痕在烛火下泛着暗红。正文内容。')
    expect(prompt).toContain('本章正文')
    expect(prompt).toContain('细纲声明推进')
    expect(prompt).toContain('悬念-001')
    expect(prompt).toContain('进行中账本')
    expect(prompt).toContain('焦痕在烛火下泛着暗红')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('A3: 超长正文 → 头尾保留 + 省略标记（替代无通知硬切，章尾证据可见）', () => {
  const root = makeWiringBook()
  try {
    const head = '开头证据句。'
    const middle = '水'.repeat(7000)
    const tail = '结尾证据句。'
    const prompt = buildLeadUpdatePrompt(root, 1, head + middle + tail)
    expect(prompt).toContain('开头证据句。')
    expect(prompt).toContain('结尾证据句。') // 旧 slice(0,6000) 会丢章尾
    expect(prompt).toContain('[...中段已省略...]')
    // 正文段被压回阈值内（头 4800 + 尾 1024 + marker < 6000）
    const bodySection = prompt.split('## 本章正文\n')[1]!.split('\n\n## ')[0]!
    expect(Array.from(bodySection).length).toBeLessThan(6000)
    expect(bodySection).toContain('水') // 头部保留段仍在（非整段丢弃）
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('闭环：parseLeadUpdateDraft 产出可被 readChapterLeadUpdates 读回（格式同构）', () => {
  const root = makeWiringBook()
  try {
    const text = '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n'
    const parsed = parseLeadUpdateDraft(text, root)
    expect(parsed.length).toBe(1)
    // 模拟生成函数落盘 → 读取端解析
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      parsed.map((u) => '- ' + u.leadId + ' ' + u.动词 + '：' + u.证据).join('\n') + '\n',
      'utf-8',
    )
    expect(readChapterLeadUpdates(root)).toEqual([{ leadId: '悬念-001', 动词: '递进', 证据: '焦痕在烛火下泛着暗红。' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── X-P2-6：批量连写按章归档（archivePendingLeadUpdates + generateLeadUpdateDraft 联动） ──

const ARCHIVE_DIR = join('工作区', '.账本推进暂存')

/** 造第 1 章正文（generateLeadUpdateDraft 需按章号读到正文） */
function makeChapter(root: string): void {
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '0001-雨夜.md'),
    '---\n章号: 1\n标题: 雨夜\n---\n\n山门外的钟声在雨夜里连响了三下。\n',
    'utf-8',
  )
}

test('archivePendingLeadUpdates: 主文件载其他章条目 → 归档到 .账本推进暂存/第N章.md', () => {
  const root = makeWiringBook()
  try {
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      '# 第2章 账本推进\n- 悬念-001 递进：上一章证据。\n',
      'utf-8',
    )
    archivePendingLeadUpdates(root, 1)
    // 主文件已被挪走归档，内容原样
    expect(existsSync(join(root, '工作区', '账本推进.md'))).toBe(false)
    const archived = join(root, ARCHIVE_DIR, '第2章.md')
    expect(existsSync(archived)).toBe(true)
    expect(readFileSync(archived, 'utf-8')).toBe('# 第2章 账本推进\n- 悬念-001 递进：上一章证据。\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archivePendingLeadUpdates: 同章重生成（自愈复查）→ 不归档（覆盖语义）', () => {
  const root = makeWiringBook()
  try {
    const content = '# 第1章 账本推进\n- 悬念-001 递进：本章证据。\n'
    writeFileSync(join(root, '工作区', '账本推进.md'), content, 'utf-8')
    archivePendingLeadUpdates(root, 1)
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toBe(content)
    expect(existsSync(join(root, ARCHIVE_DIR))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('archivePendingLeadUpdates: 无条目（无推进占位）/ 无标签旧格式 / 无文件 → 不归档', () => {
  const root = makeWiringBook()
  try {
    // 无推进占位（count=0 产出）→ 不归档
    writeFileSync(join(root, '工作区', '账本推进.md'), '# 第2章 账本推进\n# 本章无账本推进\n', 'utf-8')
    archivePendingLeadUpdates(root, 1)
    expect(existsSync(join(root, '工作区', '账本推进.md'))).toBe(true)

    // 无标签旧格式 → 视为当前章，保持覆盖语义
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 递进：旧格式条目。\n', 'utf-8')
    archivePendingLeadUpdates(root, 1)
    expect(existsSync(join(root, '工作区', '账本推进.md'))).toBe(true)
    expect(existsSync(join(root, ARCHIVE_DIR))).toBe(false)

    // 无文件 → no-op
    rmSync(join(root, '工作区', '账本推进.md'))
    archivePendingLeadUpdates(root, 1)
    expect(existsSync(join(root, ARCHIVE_DIR))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-6: generateLeadUpdateDraft（mock）→ 落盘带章节标签；载有他章草稿时先归档再写', async () => {
  const prev = process.env['CLWRITING_DRIVER']
  process.env['CLWRITING_DRIVER'] = 'mock' // LEAD_UPDATE_SPEC mock：悬念-001 递进 + 正文原句
  try {
    const root = makeWiringBook()
    try {
      makeChapter(root)
      // 主文件先载第 2 章待确认草稿（模拟批量连写上一章未定稿）
      writeFileSync(
        join(root, '工作区', '账本推进.md'),
        '# 第2章 账本推进\n- 悬念-001 递进：上一章证据。\n',
        'utf-8',
      )

      const r = await generateLeadUpdateDraft(root, 1, null)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.count).toBe(1)

      // 第 2 章草稿已归档，本章主文件带章节标签 + mock 解析出的推进条目
      const archived = join(root, ARCHIVE_DIR, '第2章.md')
      expect(existsSync(archived)).toBe(true)
      expect(readFileSync(archived, 'utf-8')).toContain('上一章证据')
      const main = readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')
      expect(main).toContain('# 第1章 账本推进')
      expect(main).toContain('- 悬念-001 递进：山门外的钟声在雨夜里连响了三下。')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  } finally {
    if (prev === undefined) delete process.env['CLWRITING_DRIVER']
    else process.env['CLWRITING_DRIVER'] = prev
  }
})
