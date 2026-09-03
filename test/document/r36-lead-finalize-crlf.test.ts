/**
 * R36-1（三十六轮）定稿回写端到端回归：CRLF 账本履历在定稿回写后全部保留。
 *
 * 触发面：任意账本 .md 行尾为 CRLF（win 记事本/编辑器手改、git autocrlf 检出、同步盘
 * 转码）——旧实现 readLead 的 parseHistory 对未 trim 原始行 `$` 锚定失配 → 履历空 →
 * applyLeadUpdatesLocked 读到的 lead.履历为空 → writeLead 整文件重序列化 → 既有全部
 * 履历条目物理删除、不可恢复。本测试走真实 applyLeadUpdates（含布线锁 + 清源）全链。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyLeadUpdates } from '../../src/document/lead-finalize.js'
import { readLead } from '../../src/format/leads.js'

/** 造一本带布线的短书 + 一条 CRLF 悬念线（含存量履历）+ 账本推进.md */
function makeBook(): { root: string } {
  const root = mkdtempTracked(join(tmpdir(), 'r36-lead-finalize-crlf-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  // 存量履历 2 条，整文件 CRLF
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    [
      '---',
      '编号: 悬念-001',
      '标题: 灭门真凶',
      '类型: 悬念',
      '状态: 进行中',
      '开启章: 1',
      '---',
      '',
      '## 履历',
      '',
      '- 第010章 埋下：林家祠堂的焦痕。',
      '- 第020章 递进：管家提到狗没叫。',
      '',
    ].join('\r\n'),
    'utf-8',
  )
  return { root }
}

test('R36-1: CRLF 账本经定稿回写——既有履历保留 + 新条目追加（不物理清空）', async () => {
  const { root } = makeBook()
  try {
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      '- 悬念-001 递进：门前雪地脚印。\n',
      'utf-8',
    )
    const n = await applyLeadUpdates(root, 30)
    expect(n).toBe(1)

    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 修复前：存量 2 条被物理清空，仅剩新追加 1 条
      expect(r.lead.履历).toHaveLength(3)
      expect(r.lead.履历[0]).toEqual({ 章号: 10, 动词: '埋下', 证据: '林家祠堂的焦痕。' })
      expect(r.lead.履历[1]).toEqual({ 章号: 20, 动词: '递进', 证据: '管家提到狗没叫。' })
      expect(r.lead.履历[2]).toEqual({ 章号: 30, 动词: '递进', 证据: '门前雪地脚印。' })
    }
    // R38-11（三十八轮）契约演进：写侧主导行尾保真——本文件源为 CRLF，回写保持 CRLF
    //（旧断言「规整为 LF 无 \r 残留」固化的是修复前的 LF 重生成口径）；履历完整性
    // 语义与 R36-1 不变。LF 账本字节不变的锚见 test/format/r38-batch-e.test.ts。
    expect(readFileSync(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'), 'utf-8').includes('\r\n')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R36-1: 账本推进源与账本文件双 CRLF——全链归一并回写', async () => {
  const { root } = makeBook()
  try {
    // 账本推进.md 本身 CRLF（lead-updates 解析层先 trim 本就安全，此处证全链）
    writeFileSync(
      join(root, '工作区', '账本推进.md'),
      '- 悬念-001 递进：门前雪地脚印。\r\n',
      'utf-8',
    )
    const n = await applyLeadUpdates(root, 30)
    expect(n).toBe(1)

    const r = readLead(join(root, '布线', '悬念', '悬念-001-灭门真凶.md'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lead.履历).toHaveLength(3)
      expect(r.lead.履历[2]!.证据).toBe('门前雪地脚印。')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})