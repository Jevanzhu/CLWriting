/**
 * 定稿账本履历回写（W-P1-3 右端闭环 + 决策 2）单元测试。
 *
 * 覆盖 applyLeadUpdates：
 * - 消费 工作区/账本推进.md → 回写布线条目 履历（第N章 动词：证据）
 * - 回写后清空 账本推进.md
 * - 重复定稿（同 章号+动词+证据）不重复追加
 * - 编号查无此线 → 跳过不崩
 * - 无账本推进文件 → 0 且不清空
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyLeadUpdates } from '../../src/document/lead-finalize.js'
import { readLead } from '../../src/format/leads.js'

/** 造一本带布线的短书 + 一条悬念线 + 账本推进.md */
function makeBook(): { root: string } {
  const root = mkdtempTracked(join(tmpdir(), 'lead-finalize-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  return { root }
}

test('applyLeadUpdates: 消费账本推进 → 回写履历 + 清空文件', async () => {
  const { root } = makeBook()
  try {
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n',
      'utf-8',
    )
    const n = await applyLeadUpdates(root, 3)
    expect(n).toBe(1)

    // 履历已回写
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lead.履历).toEqual([{ 章号: 3, 动词: '递进', 证据: '焦痕在烛火下泛着暗红。' }])
    }
    // 账本推进.md 已清空
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyLeadUpdates: 同 章号+动词+证据 重复定稿不重复追加', async () => {
  const { root } = makeBook()
  try {
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n',
      'utf-8',
    )
    await applyLeadUpdates(root, 3)
    // 再次写入同样内容（作者改稿重新定稿）→ 已被清空，无新条目
    const n2 = await applyLeadUpdates(root, 3)
    expect(n2).toBe(0)
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    if (r.ok) expect(r.lead.履历).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyLeadUpdates: 编号查无此线 → 跳过不崩', async () => {
  const { root } = makeBook()
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-999 递进：不存在的线。\n', 'utf-8')
    const n = await applyLeadUpdates(root, 3)
    expect(n).toBe(0)
    // X-P2-6：仅 applied>0 才清空——查无此线的条目保留给作者处置（旧版静默清空=丢确认内容）
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toBe('- 悬念-999 递进：不存在的线。\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyLeadUpdates: 无账本推进文件 → 0 且不清空', async () => {
  const { root } = makeBook()
  try {
    expect(await applyLeadUpdates(root, 3)).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── M-6（第六轮）：混合场景不静默丢弃查无此线的条目 ─────────────────────

test('M-6: 一条成功 + 一条查无此线 → 成功的回写、查无的带警告写回源文件', async () => {
  const { root } = makeBook()
  try {
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n- 悬念-999 递进：查无此线的证据。\n',
      'utf-8',
    )
    const n = await applyLeadUpdates(root, 3)
    expect(n).toBe(1) // 成功条目已回写履历

    // 成功条目确实落库
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lead.履历).toEqual([{ 章号: 3, 动词: '递进', 证据: '焦痕在烛火下泛着暗红。' }])

    // 查无此线条目不再被整体清空吞掉：带警告写回，且保留本章章节标签
    const after = readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')
    expect(after).toContain('查无此线')
    expect(after).toContain('- 悬念-999 递进：查无此线的证据。')
    expect(after.startsWith('# 第3章 账本推进')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M-6: 归档场景（主文件属其他章）查无此线 → 残留写回归档而非删除', async () => {
  const { root } = makeBook()
  try {
    const main = join(root, '工作区', '账本推进.md')
    const mainContent = '# 第5章 账本推进\n- 悬念-001 递进：第五章的证据。\n'
    writeFileSync(main, mainContent, 'utf-8')
    const archDir = join(root, '工作区', '.账本推进暂存')
    mkdirSync(archDir, { recursive: true })
    writeFileSync(join(archDir, '第3章.md'), '- 悬念-001 递进：好的证据。\n- 悬念-999 递进：查无此线。\n', 'utf-8')

    expect(await applyLeadUpdates(root, 3)).toBe(1)
    // 其他章主文件不动；本章归档改写为警告残留（不删、不丢条目）
    expect(readFileSync(main, 'utf-8')).toBe(mainContent)
    const arch = readFileSync(join(archDir, '第3章.md'), 'utf-8')
    expect(arch).toContain('查无此线')
    expect(arch).toContain('- 悬念-999 递进：查无此线。')
    expect(arch).not.toContain('- 悬念-001 递进：好的证据。') // 已兑现条目不再残留
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M-6: 修好编号后再次定稿 → 残留条目自动重试回写（幂等链闭合）', async () => {
  const { root } = makeBook()
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-999 递进：查无此线的证据。\n', 'utf-8')
    await applyLeadUpdates(root, 3) // applied=0，文件不动（X-P2-6 语义）
    // 作者把编号改成真实存在的线
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 递进：查无此线的证据。\n', 'utf-8')
    const n = await applyLeadUpdates(root, 3)
    expect(n).toBe(1)
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    if (r.ok) expect(r.lead.履历).toEqual([{ 章号: 3, 动词: '递进', 证据: '查无此线的证据。' }])
    // 全部回写完成 → 源文件清空
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── X-P2-8：resolve/drop 动词落库同步派生条目状态 ────────────────────────

/** 造一条成长线（进行中）——resolve 特判用 */
function makeGrowthLead(root: string): void {
  mkdirSync(join(root, '布线', '成长线'), { recursive: true })
  writeFileSync(
    join(root, '布线', '成长线', '成长线-001-炼气.md'),
    '---\n编号: 成长线-001\n标题: 炼气\n类型: 成长线\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
}

test('X-P2-8: resolve 动词（揭晓）→ 状态派生 已收尾', async () => {
  const { root } = makeBook()
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 揭晓：真凶是管家。\n', 'utf-8')
    expect(await applyLeadUpdates(root, 3)).toBe(1)
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lead.状态).toBe('已收尾')
      expect(r.lead.履历).toEqual([{ 章号: 3, 动词: '揭晓', 证据: '真凶是管家。' }])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-8: drop 动词（放弃）→ 状态派生 已放弃', async () => {
  const { root } = makeBook()
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 放弃：线索断在这里。\n', 'utf-8')
    expect(await applyLeadUpdates(root, 3)).toBe(1)
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    if (r.ok) expect(r.lead.状态).toBe('已放弃')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-8: 成长线 resolve（突破）→ 常态化升级保持 进行中', async () => {
  const { root } = makeBook()
  try {
    makeGrowthLead(root)
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 成长线-001 突破：踏入炼气三层。\n', 'utf-8')
    expect(await applyLeadUpdates(root, 3)).toBe(1)
    const r = readLead(join(root, '布线', '成长线', '成长线-001-炼气.md'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lead.状态).toBe('进行中')
      expect(r.lead.履历).toHaveLength(1)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-8: 作者显式终态不被 advance/其他动词覆盖（仅 进行中 才派生）', async () => {
  const { root } = makeBook()
  try {
    // 作者已手动标终态的线 + 一条 advance 动词 → 状态不动（派生只作用于 进行中）
    const p = join(root, '布线', '悬念', '悬念-001-灭门真凶.md')
    writeFileSync(p, '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 已收尾\n开启章: 1\n---\n\n## 履历\n', 'utf-8')
    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 递进：新的线索。\n', 'utf-8')
    expect(await applyLeadUpdates(root, 3)).toBe(1)
    const r = readLead(p)
    if (r.ok) expect(r.lead.状态).toBe('已收尾')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── X-P2-6：批量连写归档回收（主文件章节标签 + .账本推进暂存/第N章.md） ────────

test('X-P2-6: 主文件载其他章待确认 → 只回收本章归档，主文件不动', async () => {
  const { root } = makeBook()
  try {
    // 主文件是第 5 章的草稿（上一章批量连写产出、未定稿确认）
    const main = join(root, '工作区', '账本推进.md')
    const mainContent = '# 第5章 账本推进\n- 悬念-001 递进：第五章的证据。\n'
    writeFileSync(main, mainContent, 'utf-8')
    const archDir = join(root, '工作区', '.账本推进暂存')
    mkdirSync(archDir, { recursive: true })
    writeFileSync(join(archDir, '第3章.md'), '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n', 'utf-8')

    const n = await applyLeadUpdates(root, 3)
    expect(n).toBe(1)
    // 履历只回写第 3 章归档的条目
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    if (r.ok) expect(r.lead.履历).toEqual([{ 章号: 3, 动词: '递进', 证据: '焦痕在烛火下泛着暗红。' }])
    // 第 5 章待确认内容原样保留（不被清空/覆盖）
    expect(readFileSync(main, 'utf-8')).toBe(mainContent)
    // 本章归档已回收删除
    expect(existsSync(join(archDir, '第3章.md'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-6: 主文件标签=本章 + 本章归档并存 → 双源合并回收 + 双清', async () => {
  const { root } = makeBook()
  try {
    const main = join(root, '工作区', '账本推进.md')
    writeFileSync(main, '# 第3章 账本推进\n- 悬念-001 递进：焦痕在烛火下泛着暗红。\n', 'utf-8')
    const archDir = join(root, '工作区', '.账本推进暂存')
    mkdirSync(archDir, { recursive: true })
    writeFileSync(join(archDir, '第3章.md'), '- 悬念-001 递进：另一条独立证据。\n', 'utf-8')

    const n = await applyLeadUpdates(root, 3)
    expect(n).toBe(2)
    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    if (r.ok) {
      expect(r.lead.履历.map((e) => e.证据)).toEqual(['焦痕在烛火下泛着暗红。', '另一条独立证据。'])
    }
    expect(readFileSync(main, 'utf-8')).toBe('')
    expect(existsSync(join(archDir, '第3章.md'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-6: 主文件无标签（旧格式）→ 视为本章回收清空（单章旧行为兼容）', async () => {
  const { root } = makeBook()
  try {
    const main = join(root, '工作区', '账本推进.md')
    writeFileSync(main, '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n', 'utf-8')
    expect(await applyLeadUpdates(root, 3)).toBe(1)
    expect(readFileSync(main, 'utf-8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-6: 其他章归档留存 + 无本章条目 → 0 且互不影响', async () => {
  const { root } = makeBook()
  try {
    const archDir = join(root, '工作区', '.账本推进暂存')
    mkdirSync(archDir, { recursive: true })
    writeFileSync(join(archDir, '第5章.md'), '- 悬念-001 递进：第五章的证据。\n', 'utf-8')
    expect(await applyLeadUpdates(root, 3)).toBe(0)
    // 第 5 章归档不动（等第 5 章定稿时回收）
    expect(existsSync(join(archDir, '第5章.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M-9（第八轮）：盘上非 UTF-8 的线索文件 → 拒绝回写（字节不损毁），条目留本章源', async () => {
  const root = mkdtempTracked(join(tmpdir(), 'lead-gbk-'))
  try {
    mkdirSync(join(root, '布线', '悬念'), { recursive: true })
    mkdirSync(join(root, '工作区'), { recursive: true })
    // 编号行保持合法 UTF-8（readLead 可解析、可匹配 leadId），标题混入 GBK 字节——
    // 整文件字节不合法 UTF-8 即触发防线
    const leadPath = join(root, '布线', '悬念', '悬念-001-灭门真凶.md')
    const head = Buffer.from('---\n编号: 悬念-001\n标题: ', 'utf-8')
    const gbk = Buffer.from([0xd6, 0xd0]) // GBK「中」——非 UTF-8 字节
    const tail = Buffer.from('\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n', 'utf-8')
    const raw = Buffer.concat([head, gbk, tail])
    writeFileSync(leadPath, raw)

    writeFileSync(join(root, '工作区', '账本推进.md'), '- 悬念-001 递进：焦痕在烛火下泛着暗红。\n', 'utf-8')
    const n = await applyLeadUpdates(root, 3)
    expect(n).toBe(0)
    // 原始字节一字不动（utf-8 往返会永久丢 GBK 字节——正是本防线要拦的覆盖）
    expect(readFileSync(leadPath)).toEqual(raw)
    // 条目未消费：本章源原样保留（作者转码后下次定稿自动重试）
    expect(readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')).toContain('悬念-001 递进')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
