/**
 * H-1（2026-08-21 三轮复审）回归：树红点章级缓存不得吞「跨章输入」。
 *
 * 缺陷现场：账本全书性红项（引文命中 lead-evidence-miss 等）的输入是布线 db +
 * **任意章**正文（引文 grep 按履历章号直读该章），却进每章 report 的 hasRed、只按
 * 「本章 stat + 纪元」失效——改第 2 章正文补上引文后只有第 2 章自身行指纹失效，
 * 第 1 章的缓存红点残留（假红）；反向删引文则第 1 章漏红。违反缓存层核心不变量
 * 「缓存命中 = 与全量重算逐字节等价」。
 *
 * 修复后：全书性红项在 collectTreeIssues 单独计算、按「纪元 + 正文目录指纹」独立
 * 缓存（tree_issues_meta leads_book_*），改任何一章正文都会重算该项；章级行只含
 * 章作用域检查（两端闭合等）。本文件锁两个方向：假红消除 + 漏红消除。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { collectTreeIssues, __setLeadsBookDegradeForTest } from '../../src/check/run.js'
import { rebuild } from '../../src/cache/rebuild.js'
import { checkLeadsBookItems } from '../../src/check/leads.js'
import { readManifest, writeManifest, upsertEntry, type ManifestEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const EVIDENCE = '密室尽头的青铜灯'

/**
 * 造书：ch1/ch2 草稿（章作用域机检全绿——无禁词、fm 齐全）+ ch3 已定稿
 * （撑起 maxWritten 基准，防履历第 2 章被误判「未来章」）+ 悬念-001 履历一行
 * （第 2 章埋下，证据 EVIDENCE）。evidenceInCh2 控制第 2 章正文是否含引文。
 */
function makeBook(evidenceInCh2: boolean, finalizeCh3 = true): { root: string; docIds: Record<number, string> } {
  const root = mkdtempSync(join(tmpdir(), 'leads-book-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-密室之主.md'),
    '---\n编号: 悬念-001\n标题: 密室之主\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第2章 埋下：「' +
      EVIDENCE +
      '」\n',
    'utf-8',
  )
  const docIds: Record<number, string> = {}
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const chapterBody = (no: number): string => {
    if (no === 2 && evidenceInCh2) return `夜色里，${EVIDENCE}忽然亮了一下。\n`
    return `第${no}章的叙述文本，山门外落了整夜的雨。\n`
  }
  for (const no of [1, 2, 3]) {
    const pad = String(no).padStart(3, '0')
    const rel = `写作/正文/${pad}-第${no}章.md`
    writeFileSync(
      join(root, rel),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${chapterBody(no)}`,
      'utf-8',
    )
    const id = generateDocId()
    docIds[no] = id
    const entry: ManifestEntry = { id, nodeType: 'document', path: rel, parentId: null }
    // ch3 定稿：manifest 基线 = 当前内容指纹 → deriveStatus 判 final，树循环跳过且
    // maxWrittenChapterOf 取到 3（履历第 2 章不算未来章）
    if (finalizeCh3 && no === 3) {
      entry.finalizedRevision =
        'sha256:' + createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
    }
    upsertEntry(m, entry)
  }
  writeManifest(manifestPath, m)
  return { root, docIds }
}

/** 改章正文并显式前移 mtime（同秒写入指纹不变的保险） */
function rewriteChapter(root: string, no: number, append: string): void {
  const pad = String(no).padStart(3, '0')
  const fp = join(root, '写作', '正文', `${pad}-第${no}章.md`)
  const next = readFileSync(fp, 'utf-8') + append
  writeFileSync(fp, next, 'utf-8')
  const t = new Date(Date.now() + 10_000)
  utimesSync(fp, t, t)
}

describe('collectTreeIssues 账本全书性红项（H-1 跨章陈旧修复）', () => {
  it('改他章正文补引文 → 全部章红点清除（修复前：非编辑章假红残留）', () => {
    const { root, docIds } = makeBook(false)
    try {
      // 首轮：引文缺失 → 全书性红项为真，ch1/ch2（草稿章）全部亮红
      const first = collectTreeIssues(root, () => undefined)
      expect(first.issues[docIds[1]!]?.hasRed).toBe(true)
      expect(first.issues[docIds[2]!]?.hasRed).toBe(true)

      // 修第 2 章正文补上引文——只有第 2 章自身行指纹 + 全书性指纹失效，
      // 第 1 章行指纹未变（修复前它的缓存 hasRed=true 残留 → 假红）
      rewriteChapter(root, 2, `他终于看见了${EVIDENCE}。\n`)
      const second = collectTreeIssues(root, () => undefined)
      expect(second.issues[docIds[1]!]).toBeUndefined()
      expect(second.issues[docIds[2]!]).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('改他章正文删引文 → 全部章红点亮起（修复前：非编辑章漏红）', () => {
    const { root, docIds } = makeBook(true)
    try {
      // 首轮：引文在场 → 全书无红
      const first = collectTreeIssues(root, () => undefined)
      expect(first.issues[docIds[1]!]).toBeUndefined()
      expect(first.issues[docIds[2]!]).toBeUndefined()

      // 第 2 章正文整章重写（引文消失）——第 1 章行指纹未变，但全书性红项须重算亮红
      const pad = '002'
      const fp = join(root, '写作', '正文', `${pad}-第2章.md`)
      writeFileSync(
        fp,
        '---\n章号: 2\n标题: 第2章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第2章被整章重写了，密室空无一物。\n',
        'utf-8',
      )
      const t = new Date(Date.now() + 10_000)
      utimesSync(fp, t, t)
      const second = collectTreeIssues(root, () => undefined)
      expect(second.issues[docIds[1]!]?.hasRed).toBe(true)
      expect(second.issues[docIds[2]!]?.hasRed).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('index.db 损坏 → fail-open 降级不抛（M-9：只算 verdict，不再穿透成 500）', () => {
    const { root } = makeBook(false)
    try {
      collectTreeIssues(root, () => undefined) // 先跑一轮建库
      // 覆写损坏库文件：rebuild/开库抛硬异常——修复前直接穿透把树红点端点打成 500，
      // 与缓存层「读写失败跳过缓存走全量」的 fail-open 红线冲突
      writeFileSync(join(root, '.cache', 'index.db'), 'this is not a sqlite database', 'utf-8')
      const r = collectTreeIssues(root, () => undefined)
      expect(r.rebuildFailed).toBe(true)
      expect(r.issues).toEqual({})
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('章文件缺失 → lead-evidence-unverifiable 黄项（修复前：引文检查静默通过无任何输出）', () => {
    const { root } = makeBook(true)
    try {
      // 删掉履历声称的第 2 章正文文件——引文无从 grep
      rmSync(join(root, '写作', '正文', '002-第2章.md'))
      const r = collectTreeIssues(root, () => undefined)
      // 黄项不进树红点（正文缺失 ≠ 证据不存在，提示而非拦截）
      expect(r.issues).toEqual({})
      // 但全书性检查必须产出 unverifiable 条目，不得静默失明（修复前 items 为空）
      const db = new DatabaseSync(join(root, '.cache', 'index.db'), { readOnly: true })
      try {
        const items = checkLeadsBookItems(db, root, 3, ['悬念'])
        const unverifiable = items.filter((i) => i.checkId === 'lead-evidence-unverifiable')
        expect(unverifiable).toHaveLength(1)
        expect(unverifiable[0]!.level).toBe('yellow')
        expect(unverifiable[0]!.message).toContain('悬念-001')
        expect(unverifiable[0]!.message).toContain('无法核验')
        expect(items.some((i) => i.checkId === 'lead-evidence-miss')).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('零定稿章（新书）→ 未来章基准回退最高现存章号（修复前 ?? 0 → 全树假红）', () => {
    const { root, docIds } = makeBook(true, false)
    try {
      // 无任何 finalizedRevision：maxWrittenChapterOf 为 null。草稿现存到第 3 章，
      // 履历声称第 2 章 不算「凭空声称未来章」——与单章机检面板口径一致
      const r = collectTreeIssues(root, () => undefined)
      expect(r.issues[docIds[1]!]).toBeUndefined()
      expect(r.issues[docIds[2]!]).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），该守卫语义由 macOS/Linux CI 腿覆盖
  it.skipIf(process.platform === 'win32')('低级项（第六轮）：章文件在但读失败（权限）→ 不崩三检，落 unverifiable 黄项', () => {
    const { root } = makeBook(true)
    const ch2 = join(root, '写作', '正文', '002-第2章.md')
    try {
      collectTreeIssues(root, () => undefined) // 建库（缓存/布线），文件此刻可读
      chmodSync(ch2, 0o000) // 读侧故障模拟：findChapterFile 找得到、readFileSync 抛 EACCES
      const db = new DatabaseSync(join(root, '.cache', 'index.db'), { readOnly: true })
      try {
        // 修复前：chapterTextOf 的裸 readFileSync 把 EACCES 上抛，整个三检 500
        const items = checkLeadsBookItems(db, root, 3, ['悬念'])
        const unverifiable = items.filter((i) => i.checkId === 'lead-evidence-unverifiable')
        expect(unverifiable).toHaveLength(1)
        expect(items.some((i) => i.checkId === 'lead-evidence-miss')).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      chmodSync(ch2, 0o644)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── R62-5/R62-7（第六十二轮）──────────────────────────

describe('R62-5/R62-7：章文件定位单次建表 + 账本降级可见性', () => {
  it('R62-5：正文按卷子目录 + 章号补零布局，章文件定位照常（walkMdEach 单次建表含递归与补零判等）', () => {
    const root = mkdtempSync(join(tmpdir(), 'leads-book-map-'))
    try {
      mkdirSync(join(root, '布线', '悬念'), { recursive: true })
      mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
      writeFileSync(
        join(root, 'book.yaml'),
        'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
        'utf-8',
      )
      writeFileSync(
        join(root, '布线', '悬念', '悬念-001-密室之主.md'),
        '---\n编号: 悬念-001\n标题: 密室之主\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第2章 埋下：「密室尽头的青铜灯」\n',
        'utf-8',
      )
      writeFileSync(
        join(root, '写作', '正文', '第一卷', '002-第2章.md'),
        '---\n章号: 2\n标题: 第2章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n夜色里，密室尽头的青铜灯忽然亮了一下。\n',
        'utf-8',
      )
      const cachePath = join(root, '.cache', 'index.db')
      rebuild(root, cachePath)
      const db = new DatabaseSync(cachePath)
      try {
        const items = checkLeadsBookItems(db, root, 2, ['悬念'])
        expect(items.filter((i) => i.level === 'red')).toEqual([]) // 卷子目录 + 补零章号内引文被找到
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('R62-7：账本全书性红项计算失败 → leadsBookDegraded 透出（修复前静默降级为「无红」且响应无 warning）', () => {
    const { root } = makeBook(true)
    try {
      const healthy = collectTreeIssues(root, () => undefined)
      expect(healthy.leadsBookDegraded).toBe(false)

      // R62-7 触发（定稿）：readLeadsBookRed 对表异常自愈吞错且 collectTreeIssues 每次
      // 先跑 rebuild 重建表——外部腐蚀（DROP/坏 schema）无法确定性触发 degraded。按库内
      // 既有 __set...ForTest 注入范型（R62-21 同族）用 __setLeadsBookDegradeForTest 直证透出路径。
      __setLeadsBookDegradeForTest(true)
      const degraded = collectTreeIssues(root, () => undefined)
      __setLeadsBookDegradeForTest(false)
      expect(degraded.leadsBookDegraded).toBe(true)
      expect(degraded.rebuildFailed).toBe(false) // 与 rebuildFailed 两口径独立可辨
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
