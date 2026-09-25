/**
 * R36-1（三十六轮）回归：CRLF 行尾账本的履历条目全量解析 + 定稿回写不物理清空。
 *
 * 修复背景：HISTORY_ENTRY_RE / LOOSE_RE 对**未 trim 的原始行** `$` 锚定匹配且无 m
 * 标志，`\r` 前不认行尾 → CRLF 账本的履历条目全量落「形似条目」分支被 log.warn 丢弃；
 * 随后定稿回写 writeLead 按 stringifyHistory 整文件重序列化 → 既有全部履历条目物理
 * 删除、不可恢复（防吃书账本整体失真）。修复：parseHistory 匹配前对每行做 `\r` 行尾
 * 归一（endsWith 守卫，不 trim 内容侧空格），headingEndsSection 条目前瞻共用。
 */
import { test, expect } from 'vitest'
import { rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLead, writeLead, parseHistory } from '../../src/format/leads.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const FM = '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 12\n---\n'

/** LF 正文 → CRLF 正文 */
function toCrlf(text: string): string {
  return text.split('\n').join('\r\n')
}

// ── parseHistory：CRLF 行尾全量解析 ───────────────

test('R36-1: CRLF 履历段条目全部解析（修复前主/宽松正则均失配全丢）', () => {
  const body = toCrlf(`## 履历

- 第012章 埋下：林家祠堂的焦痕。
- 第030章 递进：管家提到狗没叫。
- 第047章 揭晓：真凶是二叔。
`)
  const entries = parseHistory(body)
  expect(entries).toHaveLength(3)
  expect(entries[0]).toEqual({ 章号: 12, 动词: '埋下', 证据: '林家祠堂的焦痕。' })
  expect(entries[1]).toEqual({ 章号: 30, 动词: '递进', 证据: '管家提到狗没叫。' })
  expect(entries[2]).toEqual({ 章号: 47, 动词: '揭晓', 证据: '真凶是二叔。' })
})

test('R36-1: CRLF 行尾的宽松抢救路径（缺空格/全角数字）同样生效', () => {
  const body = toCrlf(`## 履历

- 第012章 埋下：林家祠堂的焦痕。
- 第030章递进：管家提到狗没叫。
- 第０４７章 揭晓：真凶是二叔。
`)
  const entries = parseHistory(body)
  expect(entries).toHaveLength(3)
  expect(entries[1]).toEqual({ 章号: 30, 动词: '递进', 证据: '管家提到狗没叫。' })
  expect(entries[2]).toEqual({ 章号: 47, 动词: '揭晓', 证据: '真凶是二叔。' })
})

// ── 防退化：LF 行为不变 ─────────────────────────

test('R36-1: LF 与 CRLF 解析结果逐位一致（归一不改变 LF 语义）', () => {
  const bodyLf = `## 履历

- 第012章 埋下：林家祠堂的焦痕。
- 第030章递进：管家提到狗没叫。
- 第047章 揭晓：真凶是二叔。
- 第052章 回收：
`
  expect(parseHistory(toCrlf(bodyLf))).toEqual(parseHistory(bodyLf))
})

// ── CRLF 下的章标题分组/节终判定（headingEndsSection 条目前瞻）─────

test('R36-1: CRLF 条目在分组标题下仍被解析（节终前瞻共用归一后行）', () => {
  const body = toCrlf(`## 履历

- 第012章 埋下：林家祠堂的焦痕。

## 分组 A

- 第030章 递进：管家提到狗没叫。

## 手记
作者备注。
`)
  const entries = parseHistory(body)
  // 分组标题下的条目不因 CRLF 被误判节终丢弃（修复前 isEntry 对 `\r` 失配 → 分组
  // 判成节终 → 其后全部条目掉落）
  expect(entries).toHaveLength(2)
  expect(entries[1]).toEqual({ 章号: 30, 动词: '递进', 证据: '管家提到狗没叫。' })
})

// ── 端到端：读-改-写往返 + 定稿回写不物理清空 ─────────────

test('R36-1: CRLF 账本 readLead→writeLead 往返条目全部保留（定稿回写不清空）', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'r36-leads-crlf-'))
  const fp = join(dir, '悬念-001-灭门真凶.md')
  // 整文件 CRLF（front matter + 履历段；与 win 记事本/同步盘转码形态一致）
  const content = toCrlf(FM + `## 履历

- 第012章 埋下：林家祠堂的焦痕。
- 第020章 递进：管家提到狗没叫。
- 第030章 递进：门前雪地脚印。
`)
  writeFileSync(fp, content, 'utf-8')
  try {
    const r = readLead(fp)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 修复前此处履历为空数组 → 写回后既有履历物理清空
    expect(r.lead.履历).toHaveLength(3)

    // 模拟定稿回写链：lead-finalize.applyLeadUpdatesLocked 把读到的 lead 追加/改写后
    // 调 writeLead 整文件重序列化——既有条目必须随模型全部回写
    r.lead.履历.push({ 章号: 40, 动词: '揭晓', 证据: '真凶伏法。' })
    writeLead(fp, r.lead)

    const out = readFileSync(fp, 'utf-8')
    // 4 条（3 旧 + 1 新）全部物化。行尾契约演进：R38-11（三十八轮）曾为「主导行尾
    // 保真」；平台规范化批一（2026-09-03）推翻为规范形 LF——CRLF 源回写归一 LF
    //（跨机互拷差异归零），条目完整性语义与 R36-1 不变。LF 账本字节不变的锚见 r38 测试。
    expect(out).toContain('- 第012章 埋下：林家祠堂的焦痕。')
    expect(out).toContain('- 第020章 递进：管家提到狗没叫。')
    expect(out).toContain('- 第030章 递进：门前雪地脚印。')
    expect(out).toContain('- 第040章 揭晓：真凶伏法。')
    expect(out.includes('\r')).toBe(false) // 规范形：无 \r 残留

    // 重读幂等：条目全部仍在
    const r2 = readLead(fp)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.lead.履历).toEqual(r.lead.履历)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})