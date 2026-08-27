/**
 * A1（批 1）golden 对照：随机组合变更（改 3 章正文 + 驳回 1 章 verdict + 移动 1 章）
 * 后，带缓存路径的 collectTreeIssues 与「删 .cache 全量重算」逐字节一致。
 *
 * 这是「缓存只是加速，语义与全量重算等价」红线的守门测试（设计 §二A1 验收②）。
 * 另覆盖 tree-issues-cache 模块单元语义（纪元失效 / NULL 信封匹配 / 损坏行自愈 /
 * 结构性清空）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { collectTreeIssues } from '../../src/check/run.js'
import {
  syncTreeIssuesEpoch,
  readTreeIssuesCache,
  writeTreeIssuesCache,
  clearTreeIssuesCacheForBook,
  writeLeadsBookRed,
  readLeadsBookRed,
} from '../../src/check/tree-issues-cache.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { readAnalysis, writeAnalysis } from '../../src/document/analysis.js'

/** 与 scan-count 测试同款造书（含禁词红源「玉佩」） */
function makeBook(chapterCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'tree-cache-golden-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n', 'utf-8')
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的玉佩在雨夜里连响了三下。\n`,
      'utf-8',
    )
    upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
  }
  writeManifest(manifestPath, m)
  return root
}

function verdictOf(root: string): (docId: string) => { approved: boolean } | undefined {
  return (docId) => {
    const env = readAnalysis(root, docId, 'review')
    const v = (env?.payload as { verdict?: { approved: boolean } } | undefined)?.verdict
    return v ?? undefined
  }
}

describe('A1 golden 对照：缓存路径 ≡ 全量重算（逐字节一致）', () => {
  it('随机组合（改 3 章 + 驳回 1 章 + 移动 1 章）后与无缓存全量重算一致', () => {
    const root = makeBook(8)
    try {
      const cb = verdictOf(root)
      // 预热缓存
      collectTreeIssues(root, cb)

      const manifestPath = join(root, '项目', '文档清单.jsonl')
      const m = readManifest(manifestPath)
      const docEntries = [...m.entries.entries()].filter(([, e]) => e.nodeType === 'document')
      const docOf = (chapterFile: string): string => docEntries.find(([, e]) => e.path === `写作/正文/${chapterFile}`)![0]

      // ① 改 3 章正文（第 1 章消除红源 / 第 4 章换新红源 / 第 6 章触碰不改内容语义）
      writeFileSync(
        join(root, '写作', '正文', '001-第1章.md'),
        '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的旧玉在雨夜里安安静静。\n',
        'utf-8',
      )
      writeFileSync(
        join(root, '写作', '正文', '004-第4章.md'),
        '---\n章号: 4\n标题: 第4章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n他又摸出了那枚玉佩。\n',
        'utf-8',
      )
      utimesSync(join(root, '写作', '正文', '006-第6章.md'), new Date(), new Date())

      // ② 驳回第 2 章（写 review 信封——生产链路同款动作）
      writeAnalysis(root, docOf('002-第2章.md'), 'review', {
        generatedAt: new Date().toISOString(),
        model: 'author',
        sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        payload: { verdict: { approved: false, at: new Date().toISOString() } },
      })

      // ③ 移动第 8 章：改名为「0008-移过.txt 不合法」不行——保持 md：换章号文件名（结构性）
      const oldPath = join(root, '写作', '正文', '008-第8章.md')
      const newPath = join(root, '写作', '正文', '010-第8章后传.md')
      renameSync(oldPath, newPath)
      const m2 = readManifest(manifestPath)
      const entry = m2.entries.get(docOf('008-第8章.md'))!
      m2.entries.delete(docOf('008-第8章.md'))
      entry.path = '写作/正文/010-第8章后传.md'
      upsertEntry(m2, entry)
      writeManifest(manifestPath, m2)

      // 带缓存跑（混合命中/失效/纪元重置路径）
      const cached = collectTreeIssues(root, verdictOf(root))

      // golden 基准：删 .cache 全量重算（零缓存）
      rmSync(join(root, '.cache'), { recursive: true, force: true })
      const fresh = collectTreeIssues(root, verdictOf(root))

      expect(cached.issues).toEqual(fresh.issues)
      expect(cached.rebuildFailed).toBe(fresh.rebuildFailed)
      // 抽查语义正确性：第 1 章红源消除、第 2 章驳回、第 4 章红源命中
      expect(cached.issues[docOf('001-第1章.md')]).toBeUndefined()
      expect(cached.issues[docOf('002-第2章.md')]).toEqual({ hasRed: true, verdictRejected: true })
      expect(cached.issues[docOf('004-第4章.md')]).toEqual({ hasRed: true, verdictRejected: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('结构性清空（invalidateTreeIndex structural）后残留行不复活', () => {
    const root = makeBook(3)
    try {
      const cb = verdictOf(root)
      const first = collectTreeIssues(root, cb)
      clearTreeIssuesCacheForBook(root)
      const second = collectTreeIssues(root, cb)
      expect(second.issues).toEqual(first.issues)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('tree-issues-cache 模块单元', () => {
  it('纪元对齐：指纹变化清表，未变化 no-op；NULL 信封按 IS NULL 匹配', () => {
    const root = makeBook(1)
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 首次：清+记
        writeTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, { hasRed: true, verdictRejected: false })
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null)).toEqual({ hasRed: true, verdictRejected: false })
        // 指纹不符（size 变）→ miss
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 333, null)).toBeNull()
        // 有信封指纹查无信封行 → miss（NULL ≠ 值）
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, '9:8')).toBeNull()
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false) // 纪元未变 → no-op
        utimesSync(join(root, 'book.yaml'), new Date(), new Date())
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 纪元变 → 清表
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null)).toBeNull()
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('损坏行自愈：非法 JSON 行按 miss 处理（走重算回写）', () => {
    const root = makeBook(1)
    try {
      // 触发一次 collectTreeIssues 建表 + 纪元
      collectTreeIssues(root, verdictOf(root))
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        db.prepare("UPDATE tree_issues_cache SET report_json = '{broken'").run()
        const hit = readTreeIssuesCache(db, '写作/正文/001-第1章.md', 1, 1, null)
        expect(hit).toBeNull() // 任意参数下损坏行都判 miss
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无 index.db 的书（短篇）clearTreeIssuesCacheForBook 安全 no-op', () => {
    const root = mkdtempSync(join(tmpdir(), 'tree-cache-bare-'))
    try {
      expect(existsSync(join(root, '.cache', 'index.db'))).toBe(false)
      expect(() => clearTreeIssuesCacheForBook(root)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('纪元输入补全：细纲/境界体系变更 → 清表（此前漏输入，两端闭合/成长红点可陈旧）', () => {
    const root = makeBook(1)
    try {
      // makeBook 不建这两个文件——补上（declaredLeadIds 与成长线的章外输入源）
      mkdirSync(join(root, '工作区'), { recursive: true })
      mkdirSync(join(root, '设定'), { recursive: true })
      writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 2\n推进:\n  - 悬念-001\n---\n', 'utf-8')
      writeFileSync(join(root, '设定', '境界体系.md'), '---\n体系:\n  - 名称: 测试\n---\n', 'utf-8')
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 首次：清+记
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false) // 稳定：no-op
        // +5s 防同毫秒写撞车（fileFp 是 mtimeMs 粒度）
        const later = new Date(Date.now() + 5000)
        utimesSync(join(root, '工作区', '细纲.md'), later, later)
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 细纲推进声明变 → 清
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false)
        utimesSync(join(root, '设定', '境界体系.md'), later, later)
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 境界体系变 → 清
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('R65-17（十三轮）：名册.md 变更 → 纪元清表（checkNewNames 输入此前漏在纪元外）', () => {
    const root = makeBook(1)
    try {
      mkdirSync(join(root, '设定'), { recursive: true })
      writeFileSync(join(root, '设定', '名册.md'), '已登记：云澈\n', 'utf-8')
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 首次：清+记
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false) // 稳定：no-op
        // +5s 防同毫秒写撞车（fileFp 是 mtimeMs 粒度）
        const later = new Date(Date.now() + 5000)
        utimesSync(join(root, '设定', '名册.md'), later, later)
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 修复前：名册不在纪元 → no-op，章级缓存陈旧
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('R66-3（十四轮）：.账本推进暂存 归档变化 → 纪元清表（R65-24 两源读取后归档此前漏在纪元外）', () => {
    const root = makeBook(1)
    try {
      mkdirSync(join(root, '工作区'), { recursive: true })
      const archiveDir = join(root, '工作区', '.账本推进暂存')
      mkdirSync(archiveDir, { recursive: true })
      writeFileSync(join(archiveDir, '第1章.md'), '- 悬念-001 埋下：古剑出鞘\n', 'utf-8')
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 首次：清+记
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false) // 稳定：no-op
        // +5s 防同毫秒写撞车（dirFp 的 maxMtime 是 mtimeMs 粒度）
        const later = new Date(Date.now() + 5000)
        utimesSync(join(archiveDir, '第1章.md'), later, later)
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 修复前：归档不在纪元 → no-op，章级缓存陈旧
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false)
        // 归档新增/删除同样构成变化（dirFp 的 count 部分）
        writeFileSync(join(archiveDir, '第2章.md'), '- 悬念-001 递进：剑鸣再起\n', 'utf-8')
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 新增归档章 → 清表
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false)
        rmSync(join(archiveDir, '第2章.md'))
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 删除归档章 → 清表
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R64-7（十二轮）：事务自动回亡 → 吞 ROLLBACK、原始病因优先', () => {
  it('syncTreeIssuesEpoch：RAISE(ROLLBACK) 自动回亡后 ROLLBACK 抛错不遮蔽原始错误', () => {
    const root = makeBook(1)
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        syncTreeIssuesEpoch(db, root, null) // 建表 + 记纪元
        writeTreeIssuesCache(db, '写作/正文/001-第1章.md', 1, 1, null, { hasRed: false, verdictRejected: false }) // 种一行：BEFORE DELETE 按行触发，空表不炸
        // 触发器在事务首句（DELETE）抛 RAISE(ROLLBACK)——事务随之整体回亡，
        // 随后的 db.exec('ROLLBACK') 会抛 "no transaction is active"
        db.exec(
          `CREATE TRIGGER boom_del BEFORE DELETE ON tree_issues_cache BEGIN SELECT RAISE(ROLLBACK, 'boom-original'); END`,
        )
        db.exec(`DELETE FROM tree_issues_meta WHERE key = 'global_fp'`) // 迫使下一轮进事务
        // 修复前：上抛的是 ROLLBACK 的 "no transaction is active"（次要异常替代病因）
        expect(() => syncTreeIssuesEpoch(db, root, null)).toThrow(/boom-original/)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writeLeadsBookRed：同款自动回亡 → 静默（缓存只是加速）且指纹不落', () => {
    const root = makeBook(1)
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        syncTreeIssuesEpoch(db, root, null) // 建表（global_fp 也经 tree_issues_meta，须在触发器前）
        db.exec(
          `CREATE TRIGGER boom_ins BEFORE INSERT ON tree_issues_meta BEGIN SELECT RAISE(ROLLBACK, 'boom-original'); END`,
        )
        expect(() => writeLeadsBookRed(db, 'fp-x', true)).not.toThrow()
        expect(readLeadsBookRed(db, 'fp-x')).toBeNull() // 回亡：两键都没落
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
