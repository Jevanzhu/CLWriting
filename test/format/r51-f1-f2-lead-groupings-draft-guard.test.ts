/**
 * R51-F-1（五十一轮，P1）回归：履历段分组标题三槽位保真。
 *
 * 修复前：条目间的 ATX 分组标题（后随条目，如 `### 第二幕`）在 parseHistoryWithPreamble
 * 走 continue——不进 entries/不进 preamble/不进 bodyAfterHistory，writeLead 整段重序列化
 * 即物理删除（作者手写结构标记不可逆丢失，「编辑永不静默丢失」红线面）。
 * 修复后：解析收 _historyGroupHeadings（挂靠 beforeEntry = 其后首个条目下标，标题链
 * 逐行各记、数组序即文件序），stringifyHistory 原位还原；lead-finalize 孪生读侧同口径。
 *
 * R51-F-2（五十一轮，P2）回归：ensureChapterNotFinalized 章号数值匹配限正文路径。
 * 修复前：finalizedRevision 是全文档通用语义（章纲/设定也可定稿），定稿章纲
 * `大纲/章纲/0012-x.md` 的文件名数字前缀会把正文第 12 章的写定位全量误拦「已定稿」。
 * 修复后：数值匹配仅对 `写作/正文/` 前缀条目生效；精确 path 分支不设限。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseHistory,
  parseHistoryWithPreamble,
  readLead,
  writeLead,
} from '../../src/format/leads.js'
import { resolveDraftPath } from '../../src/format/draft.js'

let tmp = ''
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

function scaffold(): string {
  tmp = mkdtempSync(join(tmpdir(), 'clw-r51-f1-'))
  return tmp
}

describe('R51-F-1：履历分组标题解析与还原', () => {
  it('条目间分组标题 → groupHeadings 收录（挂靠其后首条），entries 不受影响', () => {
    const body = [
      '## 履历',
      '',
      '- 第012章 埋下：焦痕',
      '### 第二幕',
      '- 第015章 递进：血字',
    ].join('\n')
    const r = parseHistoryWithPreamble(body)
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).toMatchObject({ 章号: 12, 动词: '埋下' })
    expect(r.groupHeadings).toEqual([{ beforeEntry: 1, line: '### 第二幕' }])
    // 既有 parseHistory 消费面不受影响
    expect(parseHistory(body)).toHaveLength(2)
  })

  it('标题链（R76-21 形态）逐行收录、数组序即文件序、同槽挂靠', () => {
    const body = [
      '## 履历',
      '',
      '- 第012章 埋下：焦痕',
      '### 第二幕',
      '#### 幕注：北境线',
      '- 第015章 递进：血字',
    ].join('\n')
    const r = parseHistoryWithPreamble(body)
    expect(r.groupHeadings).toEqual([
      { beforeEntry: 1, line: '### 第二幕' },
      { beforeEntry: 1, line: '#### 幕注：北境线' },
    ])
  })

  it('节终标题（后无条目）不进分组槽——仍归 bodyAfterHistory，无双收', () => {
    const body = [
      '## 履历',
      '',
      '- 第012章 埋下：焦痕',
      '',
      '### 手记',
      '作者备注内容',
    ].join('\n')
    const fp = join(scaffold(), '悬念-031-试.md')
    writeFileSync(fp, `---\n编号: 悬念-031\n标题: 试\n---\n\n${body}\n`, 'utf8')
    const r = readLead(fp)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lead.履历).toHaveLength(1)
    expect(r.lead._historyGroupHeadings).toBeUndefined()
    expect(r.lead._bodyAfterHistory).toContain('### 手记')
    expect(r.lead._bodyAfterHistory).toContain('作者备注内容')
  })

  it('readLead → writeLead 往返：分组标题原位还原（此前物理丢失点）', () => {
    const md = [
      '---',
      '编号: 悬念-031',
      '标题: 灭门真凶',
      '类型: 悬念',
      '状态: 进行中',
      '开启章: 5',
      '---',
      '',
      '## 履历',
      '',
      '- 第012章 埋下：焦痕',
      '### 第二幕',
      '- 第015章 递进：血字',
      '',
    ].join('\n')
    const dir = scaffold()
    const src = join(dir, '悬念-031-灭门真凶.md')
    writeFileSync(src, md, 'utf8')
    const r = readLead(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dst = join(dir, '回写.md')
    writeLead(dst, r.lead)
    const out = readFileSync(dst, 'utf8')
    expect(out).toContain('### 第二幕')
    // 原位：分组标题位于两条目之间
    const i0 = out.indexOf('- 第012章 埋下：焦痕')
    const ih = out.indexOf('### 第二幕')
    const i1 = out.indexOf('- 第015章 递进：血字')
    expect(i0).toBeGreaterThanOrEqual(0)
    expect(ih).toBeGreaterThan(i0)
    expect(i1).toBeGreaterThan(ih)
    // 往返幂等：再读再写，标题仍在、条目不增不减
    const r2 = readLead(dst)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.lead.履历).toHaveLength(2)
    expect(r2.lead._historyGroupHeadings).toEqual([{ beforeEntry: 1, line: '### 第二幕' }])
  })

  it('首条条目前的分组标题挂 beforeEntry=0，还原顺序 = preamble 之后、首条之前', () => {
    const body = [
      '## 履历',
      '',
      '手写散文一句。',
      '### 第一卷',
      '- 第003章 设下：银簪',
    ].join('\n')
    const text = parseHistoryWithPreamble(body)
    expect(text.preamble).toBe('手写散文一句。')
    expect(text.groupHeadings).toEqual([{ beforeEntry: 0, line: '### 第一卷' }])
    const out = parseHistoryWithPreamble(body)
    expect(out.entries).toHaveLength(1)
  })
})

describe('R51-F-2：定稿章号匹配限正文路径', () => {
  const MANIFEST_REL = join('项目', '文档清单.jsonl')

  function writeManifestLines(root: string, entries: unknown[]): void {
    mkdirSync(join(root, '项目'), { recursive: true })
    const lines = [
      JSON.stringify({ version: 1, type: 'header' }),
      ...entries.map((e) => JSON.stringify(e)),
    ]
    writeFileSync(join(root, MANIFEST_REL), lines.join('\n') + '\n', 'utf8')
  }

  function scaffoldBookWithChapter12(): string {
    const root = scaffold()
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(
      join(root, '写作', '正文', '0012-示例章.md'),
      '---\n章号: 12\n标题: 示例章\n---\n\n正文。',
      'utf8',
    )
    return root
  }

  it('定稿的是章纲（大纲/章纲/0012-x.md）→ 正文第 12 章写定位不再误拦', () => {
    const root = scaffoldBookWithChapter12()
    writeManifestLines(root, [
      {
        id: 'doc-outline-12',
        nodeType: 'document',
        path: '大纲/章纲/0012-伏笔安排.md',
        parentId: null,
        finalizedRevision: 'sha256:abc',
        finalizedAt: '2026-09-06T00:00:00.000Z',
      },
    ])
    const r = resolveDraftPath(root, 12)
    expect(r.existed).toBe(true)
    expect(r.relPath).toBe('写作/正文/0012-示例章.md')
  })

  it('对照：定稿的是正文同章号文件 → 照常拦截（守卫不因本修松动）', () => {
    const root = scaffoldBookWithChapter12()
    writeManifestLines(root, [
      {
        id: 'doc-body-12',
        nodeType: 'document',
        path: '写作/正文/0012-示例章.md',
        parentId: null,
        finalizedRevision: 'sha256:abc',
        finalizedAt: '2026-09-06T00:00:00.000Z',
      },
    ])
    expect(() => resolveDraftPath(root, 12)).toThrow(/已定稿/)
  })

  it('对照：定稿正文同章号但改名后的旧路径 → 数值匹配仍拦（W-P2-2 语义保持）', () => {
    const root = scaffoldBookWithChapter12()
    writeManifestLines(root, [
      {
        id: 'doc-body-12-old',
        nodeType: 'document',
        path: '写作/正文/第一卷/0012-旧名.md',
        parentId: null,
        finalizedRevision: 'sha256:def',
        finalizedAt: '2026-09-06T00:00:00.000Z',
      },
    ])
    expect(() => resolveDraftPath(root, 12)).toThrow(/已定稿/)
  })
})
