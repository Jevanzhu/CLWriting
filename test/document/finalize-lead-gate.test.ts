/**
 * ee-P1-3 定稿防吃书闸 + ee-P1-4 账本回写先于基线 单测（src/document/finalize.ts）。
 *
 * ee-P1-3：手工/批量定稿对长篇正文章跑账本「两端闭合」两条结构红——
 * - 声明了没做（细纲 fm 推进声明 X线-001，正文/账本推进未兑现）→ LEAD_GATE 阻断
 * - 做了没声明（账本推进有正文命中的证据，细纲未声明）→ LEAD_GATE 阻断
 * - 两端一致 → 放行 + 履历回写；无布线书 / 非正文文档 → 不触发闸
 *
 * ee-P1-4：账本回写失败 → LEAD_WRITE_ERROR 且 manifest 基线不落盘；
 * 恢复后重试同一文件 → 成功且履历包含该条（封死 skipped 幂等造成的永久丢失窗口）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeRevision } from '../../src/document/finalize.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { readLead } from '../../src/format/leads.js'

/** 正文中的证据句（账本推进的证据核心必须在 fm 剥离后的正文命中才算兑现） */
const BODY_SENTENCE = '玉佩在火光里泛出微芒。'

interface WiredBookOpts {
  /** 细纲 fm「推进」值；undefined = 不写细纲；null = 写细纲但无推进字段 */
  outlineLeads?: string | null
  /** 是否创建 布线/（无布线书用 false） */
  wiring?: boolean
}

/**
 * 造一本长篇书：正文章 0001（正文含 BODY_SENTENCE）+ 可选布线悬念线 + 可选细纲声明
 * + 清单登记。返回 {root, docId}。
 */
function makeBook(opts: WiredBookOpts = {}): { root: string; docId: string } {
  const root = mkdtempSync(join(tmpdir(), 'finalize-gate-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '0001-开篇.md'),
    `---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${BODY_SENTENCE}\n`,
    'utf-8',
  )
  if (opts.wiring !== false) {
    mkdirSync(join(root, '布线', '悬念'), { recursive: true })
    writeFileSync(
      join(root, '布线', '悬念', '悬念-001-玉佩.md'),
      '---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      'utf-8',
    )
  }
  mkdirSync(join(root, '工作区'), { recursive: true })
  if (opts.outlineLeads !== undefined) {
    // null = 写细纲但无「推进」字段（声明侧为空）
    const fm = opts.outlineLeads === null ? '章号: 1' : `章号: 1\n推进: ${opts.outlineLeads}`
    writeFileSync(join(root, '工作区', '细纲.md'), `---\n${fm}\n---\n\n本章细纲。\n`, 'utf-8')
  }
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  const docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)
  return { root, docId }
}

/** 登记一个额外文档（非正文文档用例：设定文件），返回 docId。 */
function registerExtraDoc(root: string, relPath: string, content: string): string {
  mkdirSync(join(root, relPath.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(root, relPath), content, 'utf-8')
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: relPath, parentId: null })
  writeManifest(manifestPath, m)
  return docId
}

// ── ee-P1-3：防吃书闸 ────────────────────────────────────────────────

test('ee-P1-3: 声明了没做（账本推进.md 为空 / 证据不在正文）→ LEAD_GATE，基线未写', () => {
  // 变体 a：账本推进.md 为空文件
  const a = makeBook({ outlineLeads: '悬念-001' })
  try {
    writeFileSync(join(a.root, '工作区', '账本推进.md'), '', 'utf-8')
    const r = finalizeRevision(a.root, a.docId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('LEAD_GATE')
    expect(r.error).toContain('悬念-001')
    expect(r.error).toContain('声明了没做')
    // 定稿未生效：manifest 无定稿基线
    const e = readManifest(join(a.root, '项目', '文档清单.jsonl')).entries.get(a.docId)!
    expect(e.finalizedRevision).toBeUndefined()
  } finally {
    rmSync(a.root, { recursive: true, force: true })
  }

  // 变体 b：账本推进.md 有条目但证据不在正文中（兑现判定须正文命中）
  const b = makeBook({ outlineLeads: '悬念-001' })
  try {
    writeFileSync(join(b.root, '工作区', '账本推进.md'), '- 悬念-001 递进：正文里没有这句话。\n', 'utf-8')
    const r = finalizeRevision(b.root, b.docId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('LEAD_GATE')
    expect(r.error).toContain('声明了没做')
  } finally {
    rmSync(b.root, { recursive: true, force: true })
  }
})

test('ee-P1-3: 两端一致（细纲声明 + 账本推进证据命中正文）→ 定稿成功且履历回写', () => {
  const { root, docId } = makeBook({ outlineLeads: '悬念-001' })
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), `- 悬念-001 递进：${BODY_SENTENCE}\n`, 'utf-8')
    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skipped).toBe(false)
    // manifest 基线已写
    const e = readManifest(join(root, '项目', '文档清单.jsonl')).entries.get(docId)!
    expect(typeof e.finalizedRevision).toBe('string')
    // ee-P1-4：履历回写发生在基线落盘之前——此处两边都已生效
    const lead = readLead(join(root, '布线', '悬念', '悬念-001-玉佩.md'))
    expect(lead.ok).toBe(true)
    if (lead.ok) {
      expect(lead.lead.履历).toEqual([{ 章号: 1, 动词: '递进', 证据: BODY_SENTENCE }])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ee-P1-3: 做了没声明（账本推进证据命中正文但细纲无声明）→ LEAD_GATE', () => {
  const { root, docId } = makeBook({ outlineLeads: null }) // 细纲存在但无「推进」字段
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), `- 悬念-001 递进：${BODY_SENTENCE}\n`, 'utf-8')
    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('LEAD_GATE')
    expect(r.error).toContain('悬念-001')
    expect(r.error).toContain('做了没声明')
    const e = readManifest(join(root, '项目', '文档清单.jsonl')).entries.get(docId)!
    expect(e.finalizedRevision).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ee-P1-3: 无布线书 / 非正文文档 → 不触发闸（正常定稿）', () => {
  // 无布线书：细纲照样声明（短篇/无布线长篇不走账本闸）
  const a = makeBook({ outlineLeads: '悬念-001', wiring: false })
  try {
    const r = finalizeRevision(a.root, a.docId)
    expect(r.ok).toBe(true)
  } finally {
    rmSync(a.root, { recursive: true, force: true })
  }

  // 非正文文档（设定文件）：有布线书里定稿设定 → 闸只对 写作/正文/ 生效
  const b = makeBook({ outlineLeads: '悬念-001' }) // 声明了未兑现（若闸误触发会 LEAD_GATE）
  try {
    const settingDocId = registerExtraDoc(b.root, '设定/角色/林远.md', '---\n姓名: 林远\n---\n性格沉稳。\n')
    const r = finalizeRevision(b.root, settingDocId)
    expect(r.ok).toBe(true)
    const e = readManifest(join(b.root, '项目', '文档清单.jsonl')).entries.get(settingDocId)!
    expect(typeof e.finalizedRevision).toBe('string')
  } finally {
    rmSync(b.root, { recursive: true, force: true })
  }
})

// ── ee-P1-4：账本回写先于定稿基线 ────────────────────────────────────

// Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('ee-P1-4: 账本回写失败 → LEAD_WRITE_ERROR 且基线未写；恢复后重试成功（丢失窗口封死）', () => {
  const { root, docId } = makeBook({ outlineLeads: '悬念-001' })
  const leadDir = join(root, '布线', '悬念')
  try {
    writeFileSync(join(root, '工作区', '账本推进.md'), `- 悬念-001 递进：${BODY_SENTENCE}\n`, 'utf-8')
    // 布线/悬念 只读 → writeLead 的 tmp 落盘 EACCES → 回写抛错（模拟磁盘满/权限故障）
    chmodSync(leadDir, 0o555)
    let r: ReturnType<typeof finalizeRevision>
    try {
      r = finalizeRevision(root, docId)
    } finally {
      chmodSync(leadDir, 0o755) // macOS：恢复权限，防后续 rmSync 失败
    }
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('LEAD_WRITE_ERROR')
    expect(r.error).toContain('账本履历回写失败')
    // 关键断言：manifest 基线未落盘（旧序下基线已写 → 下次定稿 skipped 永不再回写）
    const e1 = readManifest(join(root, '项目', '文档清单.jsonl')).entries.get(docId)!
    expect(e1.finalizedRevision).toBeUndefined()

    // 恢复后重试同一文件 → 成功且履历包含该条
    const r2 = finalizeRevision(root, docId)
    expect(r2.ok).toBe(true)
    const lead = readLead(join(leadDir, '悬念-001-玉佩.md'))
    expect(lead.ok).toBe(true)
    if (lead.ok) {
      expect(lead.lead.履历).toEqual([{ 章号: 1, 动词: '递进', 证据: BODY_SENTENCE }])
    }
    const e2 = readManifest(join(root, '项目', '文档清单.jsonl')).entries.get(docId)!
    expect(typeof e2.finalizedRevision).toBe('string')
  } finally {
    chmodSync(leadDir, 0o755) // 双保险：中途 expect 失败也不留只读目录
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ff-P1-1：闸与回写读取源单源化（归档章不再旁路） ──────────────────

/** 批量连写形态：主文件载有**其他章**待确认条目（标签=第2章），本章推进在归档。 */
function seedBatchArchive(root: string, archiveLine: string): void {
  writeFileSync(
    join(root, '工作区', '账本推进.md'),
    '# 第2章 账本推进\n- 悬念-002 递进：别章待确认的证据。\n',
    'utf-8',
  )
  mkdirSync(join(root, '工作区', '.账本推进暂存'), { recursive: true })
  writeFileSync(join(root, '工作区', '.账本推进暂存', '第1章.md'), `# 第1章 账本推进\n${archiveLine}\n`, 'utf-8')
}

test('ff-P1-1: 归档「做了没声明」→ 闸拦得住（旧闸只读主文件 → 误放行，未审推进直落履历）', () => {
  const { root, docId } = makeBook({ outlineLeads: null }) // 细纲无声明
  try {
    seedBatchArchive(root, `- 悬念-001 递进：${BODY_SENTENCE}`)
    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('LEAD_GATE')
    expect(r.error).toContain('做了没声明')
    // 闸红即拦：履历未被回写
    const lead = readLead(join(root, '布线', '悬念', '悬念-001-玉佩.md'))
    expect(lead.ok).toBe(true)
    if (lead.ok) expect(lead.lead.履历).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ff-P1-1: 归档两端一致 → 放行 + 从归档回写履历并清归档（旧闸误判「声明了没做」）', () => {
  const { root, docId } = makeBook({ outlineLeads: '悬念-001' })
  try {
    seedBatchArchive(root, `- 悬念-001 递进：${BODY_SENTENCE}`)
    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 履历来自归档条目；主文件（第2章内容）不被清空
    const lead = readLead(join(root, '布线', '悬念', '悬念-001-玉佩.md'))
    expect(lead.ok).toBe(true)
    if (lead.ok) {
      expect(lead.lead.履历).toEqual([{ 章号: 1, 动词: '递进', 证据: BODY_SENTENCE }])
    }
    expect(existsSync(join(root, '工作区', '.账本推进暂存', '第1章.md'))).toBe(false)
    const main = readFileSync(join(root, '工作区', '账本推进.md'), 'utf-8')
    expect(main).toContain('第2章')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
