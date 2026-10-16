/**
 * A1（批 1）golden 对照：随机组合变更（改 3 章正文 + 驳回 1 章 verdict + 移动 1 章）
 * 后，带缓存路径的 collectTreeIssues 与「删 .cache 全量重算」逐字节一致。
 *
 * 这是「缓存只是加速，语义与全量重算等价」红线的守门测试（设计 §二A1 验收②）。
 * 另覆盖 tree-issues-cache 模块单元语义（纪元失效 / NULL 信封匹配 / 损坏行自愈 /
 * 结构性清空）。
 */
import { describe, it, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, renameSync, existsSync, utimesSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 粗粒度卷替身：本机卷（NTFS/APFS/ext4）mtime 为 ns 级，真粗粒度卷（FAT 2s /
 * exFAT 10ms / SMB 1s）物理上复现不了，故对 statSync 的 bigint 面打桩——登记过的
 * 章文件路径按帧返回（mtimeNs 整毫秒对齐 = 低精度卷形态），其余路径透传真实 stat。
 * 登记键同时含词法 join 与 realpath 两种拼写（safeManifestPath 对存在的文件返回
 * realpath 形式，mac 上 tmpdir 的 symlink 前缀会使两者不同）。
 */
const { coarseStatFrames } = vi.hoisted(() => ({
  coarseStatFrames: new Map<string, { size: bigint; mtimeNs: bigint }>(),
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (p: string, opts?: { bigint?: boolean }) => {
      if (opts?.bigint && typeof p === 'string') {
        const frame = coarseStatFrames.get(p)
        if (frame) return frame as never
      }
      return actual.statSync(p, opts as never)
    },
  }
})

/** 给一个文件登记粗粒度帧（整毫秒对齐），同时覆盖词法与 realpath 两种路径拼写。 */
function registerCoarseFrame(abs: string, size: bigint): void {
  const frame = { size, mtimeNs: 1_700_000_002_000_000_000n }
  coarseStatFrames.set(abs, frame)
  try {
    coarseStatFrames.set(join(realpathSync(dirname(abs)), basename(abs)), frame)
  } catch {
    /* realpath 失败（目录竞态）：词法键已登记 */
  }
}
import { mkdtempTracked, tempDirTracked } from '../helpers/temp-dir.js'
import { collectTreeIssues } from '../../src/check/run.js'
import {
  syncTreeIssuesEpoch,
  readTreeIssuesCache,
  writeTreeIssuesCache,
  writeTreeIssuesCacheBatch,
  type TreeIssuesCacheRow,
  clearTreeIssuesCacheForBook,
  writeLeadsBookRed,
  readLeadsBookRed,
  computeTreeIssuesGlobalFp,
} from '../../src/check/tree-issues-cache.js'
// P1-18（二轮复审）：代次哈希与其规则表来源（见文末 describe）
import {
  CHECKER_GENERATION,
  CHECKER_RULE_SNAPSHOT,
  canonicalRuleValue,
  computeCheckerGeneration,
} from '../../src/check/checker-generation.js'
import { SIMILE_RE } from '../../src/check/count.js'
import { DE_RUN_SPLIT_RE, POSSESSIVE_UNIT_RE } from '../../src/check/count-style.js'
import { SPEECH_VERBS } from '../../src/check/count-dialogue.js'
import { QUOTED_SPAN_RE } from '../../src/check/quotes.js'
import { STRICT_SHORT_CHECK_IDS } from '../../src/check/strict-short-ids.js'
import { AI_PATTERN_RULES, CLICHE_WORDS } from '../../src/check/ai-patterns.js'
// 新并入代次表的规则模块：断言「快照确由这些模块的导出面机械导出」
import { leadEvidenceMatchesBody } from '../../src/check/lead-updates.js'
import { outlineDeclarationForChapter } from '../../src/check/outline-leads.js'
import { extractExactRealmFromEvidence } from '../../src/format/realms.js'
import { parseIronRules } from '../../src/format/iron-rules.js'
import { ngramRepeatRate } from '../../src/format/sentences.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { readAnalysis, writeAnalysis } from '../../src/document/analysis.js'
import { ensureTreeIssuesTables } from '../../src/cache/schema.js'
import { makeCheckBook } from '../helpers/check-book.js'

/** 与 scan-count 测试同款造书（含禁词红源「玉佩」）。
 *  R29-1（二十九轮）：禁词匹配加「前后非汉字」边界后，红源正文改为标点夹持形态
 *  （「，玉佩，」）——嵌在连续汉字中的「的玉佩在」不再计命中（漏报向安全的既定取舍）。
 *  骨架单源见 helpers/check-book.ts。 */
const PREFIX = 'tree-cache-golden-'

function verdictOf(root: string): (docId: string) => { approved: boolean } | undefined {
  return (docId) => {
    const env = readAnalysis(root, docId, 'review')
    const v = (env?.payload as { verdict?: { approved: boolean } } | undefined)?.verdict
    return v ?? undefined
  }
}

describe('A1 golden 对照：缓存路径 ≡ 全量重算（逐字节一致）', () => {
  it('随机组合（改 3 章 + 驳回 1 章 + 移动 1 章）后与无缓存全量重算一致', () => {
    const root = makeCheckBook({ prefix: PREFIX, chapterCount: 8 })
    try {
      const cb = verdictOf(root)
      // 预热缓存
      collectTreeIssues(root, cb)

      const manifestPath = join(root, '项目', '文档清单.jsonl')
      const m = readManifest(manifestPath)
      const docEntries = [...m.entries.entries()].filter(([, e]) => e.nodeType === 'document')
      const docOf = (chapterFile: string): string =>
        docEntries.find(([, e]) => e.path === `写作/正文/${chapterFile}`)![0]

      // ① 改 3 章正文（第 1 章消除红源 / 第 4 章换新红源 / 第 6 章触碰不改内容语义）
      writeFileSync(
        join(root, '写作', '正文', '001-第1章.md'),
        '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的旧玉在雨夜里安安静静。\n',
        'utf-8',
      )
      writeFileSync(
        join(root, '写作', '正文', '004-第4章.md'),
        '---\n章号: 4\n标题: 第4章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n他又摸出了那枚旧物。玉佩，在掌心微凉。\n',
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
    const root = makeCheckBook({ prefix: PREFIX, chapterCount: 3 })
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
    const root = makeCheckBook({ prefix: PREFIX, chapterCount: 1 })
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 首次：清+记
        // R59 清偿批（R55-D-3）：读写新增行级纪元锚参数（'ep-a' 任取非空串，读写同锚）
        writeTreeIssuesCache(
          db,
          '写作/正文/001-第1章.md',
          111,
          222,
          null,
          { hasRed: true, verdictRejected: false },
          'ep-a',
        )
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, 'ep-a')).toEqual({
          hasRed: true,
          verdictRejected: false,
        })
        // 指纹不符（size 变）→ miss
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 333, null, 'ep-a')).toBeNull()
        // 有信封指纹查无信封行 → miss（NULL ≠ 值）
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, '9:8', 'ep-a')).toBeNull()
        // 纪元锚不符 → miss（行级纪元戳强制比对，R55-D-3）
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, 'ep-b')).toBeNull()
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false) // 纪元未变 → no-op
        utimesSync(join(root, 'book.yaml'), new Date(), new Date())
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true) // 纪元变 → 清表
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, 'ep-a')).toBeNull()
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('损坏行自愈：非法 JSON 行按 miss 处理（走重算回写）', () => {
    const root = makeCheckBook({ prefix: PREFIX, chapterCount: 1 })
    try {
      // 触发一次 collectTreeIssues 建表 + 纪元
      collectTreeIssues(root, verdictOf(root))
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        db.prepare("UPDATE tree_issues_cache SET report_json = '{broken'").run()
        const hit = readTreeIssuesCache(db, '写作/正文/001-第1章.md', 1, 1, null, 'ep-a')
        expect(hit).toBeNull() // 任意参数下损坏行都判 miss
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无 index.db 的书（短篇）clearTreeIssuesCacheForBook 安全 no-op', () => {
    const root = mkdtempTracked(join(tmpdir(), 'tree-cache-bare-'))
    try {
      expect(existsSync(join(root, '.cache', 'index.db'))).toBe(false)
      expect(() => clearTreeIssuesCacheForBook(root)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('纪元输入补全：细纲/境界体系变更 → 清表（此前漏输入，两端闭合/成长红点可陈旧）', () => {
    const root = makeCheckBook({ prefix: PREFIX, chapterCount: 1 })
    try {
      // 造书夹具不建这两个文件——补上（declaredLeadIds 与成长线的章外输入源）
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
    const root = makeCheckBook({ prefix: PREFIX, chapterCount: 1 })
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
    const root = makeCheckBook({ prefix: PREFIX, chapterCount: 1 })
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
    const root = makeCheckBook({ prefix: PREFIX, chapterCount: 1 })
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        syncTreeIssuesEpoch(db, root, null) // 建表 + 记纪元
        writeTreeIssuesCache(
          db,
          '写作/正文/001-第1章.md',
          1,
          1,
          null,
          { hasRed: false, verdictRejected: false },
          'ep-a',
        ) // 种一行：BEFORE DELETE 按行触发，空表不炸
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
    const root = makeCheckBook({ prefix: PREFIX, chapterCount: 1 })
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

// ── R55-D-3（R59 清偿批 R55-D-3，并入档；原 backlog-tree-issues-epoch-column.test.ts）：
// 章级缓存行纪元戳（tree_issues_cache.epoch_fp）。
//
// 修复前：章级行按「rel_path + 正文 stat + verdict 指纹」命中，不含纪元——双进程并发
// 校验且轮中全局输入变更时，他进程按新纪元 sync 清表后写入的新纪元行，会被本进程
// （轮基线仍是旧纪元）按章指纹误读：单轮响应混入异纪元结果（持久层由轮后终核兜住
// 不毒化，下一轮自愈，但该轮红点口径错）。
// 修复后契约：①行记落行时纪元（run.ts 传轮基线），读侧锚不匹配一律按 miss；②读侧
// 无锚（null）一律按 miss——无法验证归属时宁重算勿混纪元；③旧格式行（epoch_fp NULL，
// 存量库经 ensureTreeIssuesTables 补列后的旧行）天然不匹配 → 一次性失效重算（可接受），
// 解析向后兼容不抛错。与本文件上方「纪元对齐/NULL 信封」模块单元同族，去重 0 条。

/** 最小造书：1 章 + 布线（含禁词红源「玉佩」，保证重算必红） */
function makeEpochColumnBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'epoch-column-int-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
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
  writeFileSync(
    join(root, '写作', '正文', '001-第1章.md'),
    '---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，玉佩，连响了三下。\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: '写作/正文/001-第1章.md', parentId: null })
  writeManifest(manifestPath, m)
  return root
}

/** 裸临时目录（无书文件——sync/computeTreeIssuesGlobalFp 对缺席文件给 'absent'，fp 稳定） */
function bareDir(): string {
  return tempDirTracked('epoch-column-bare-')
}

/** 按「列是否存在」条件带 epoch_fp 插行——同一测试代码在修复前（无列）与修复后
 *  （有列）都可执行：修复前行无纪元戳 = 修复后的不匹配行，语义等价于旧格式/异纪元行 */
function insertRowWithEpoch(
  db: DatabaseSync,
  relPath: string,
  mtimeUs: number,
  size: number,
  epoch: string | null,
  hasRed: boolean,
): void {
  const cols = db.prepare('PRAGMA table_info(tree_issues_cache)').all() as Array<{ name: string }>
  const hasEpochCol = cols.some((c) => c.name === 'epoch_fp')
  if (hasEpochCol) {
    db.prepare(
      'INSERT OR REPLACE INTO tree_issues_cache (rel_path, mtime_ms, size, verdict_fp, report_json, epoch_fp) VALUES (?, ?, ?, NULL, ?, ?)',
    ).run(relPath, mtimeUs, size, JSON.stringify({ hasRed, verdictRejected: false }), epoch)
  } else {
    db.prepare(
      'INSERT OR REPLACE INTO tree_issues_cache (rel_path, mtime_ms, size, verdict_fp, report_json) VALUES (?, ?, ?, NULL, ?)',
    ).run(relPath, mtimeUs, size, JSON.stringify({ hasRed, verdictRejected: false }))
  }
}

describe('R55-D-3：章级缓存行纪元戳', () => {
  it('行级纪元：同锚命中、异锚 miss、无锚（null）一律 miss', () => {
    const root = bareDir()
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        syncTreeIssuesEpoch(db, root, null)
        writeTreeIssuesCache(
          db,
          '写作/正文/001-第1章.md',
          111,
          222,
          null,
          { hasRed: true, verdictRejected: false },
          'ep-A',
        )
        // 同锚命中
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, 'ep-A')).toEqual({
          hasRed: true,
          verdictRejected: false,
        })
        // 异锚 miss（他进程新纪元行不被旧基线误读——本修复的核心面）
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, 'ep-B')).toBeNull()
        // 无锚 miss（基线缺席时宁重算勿混纪元）
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, null)).toBeNull()
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('旧格式行（epoch_fp NULL）按 miss：一次性失效重算，不抛错', () => {
    const root = bareDir()
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        syncTreeIssuesEpoch(db, root, null)
        // 绕过写函数直插旧行（epoch_fp 缺省 NULL——存量库补列后旧行的形态）
        db.prepare(
          'INSERT INTO tree_issues_cache (rel_path, mtime_ms, size, verdict_fp, report_json) VALUES (?, ?, ?, NULL, ?)',
        ).run('写作/正文/001-第1章.md', 111, 222, '{"hasRed":true,"verdictRejected":false}')
        // 指纹全中但纪元戳 NULL → miss（修复前：命中旧行返回脏结果）
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, 'ep-A')).toBeNull()
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('存量库迁移：旧 schema 经 ensureTreeIssuesTables 幂等补列，旧行 miss、新行带戳可读', () => {
    const root = bareDir()
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        // 手建旧 schema（无 epoch_fp）并种旧行——模拟存量书仓 .cache/index.db
        db.exec(`CREATE TABLE IF NOT EXISTS tree_issues_cache (
          rel_path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
          verdict_fp TEXT, report_json TEXT NOT NULL)`)
        db.prepare(
          'INSERT INTO tree_issues_cache (rel_path, mtime_ms, size, verdict_fp, report_json) VALUES (?, ?, ?, NULL, ?)',
        ).run('写作/正文/001-第1章.md', 7, 8, '{"hasRed":false,"verdictRejected":false}')
        db.exec(`CREATE TABLE IF NOT EXISTS tree_issues_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)

        ensureTreeIssuesTables(db)

        // 补列成功且幂等（重复 ensure 不抛）
        const cols = db.prepare('PRAGMA table_info(tree_issues_cache)').all() as Array<{ name: string }>
        expect(cols.some((c) => c.name === 'epoch_fp')).toBe(true)
        expect(() => ensureTreeIssuesTables(db)).not.toThrow()
        // 旧行（NULL 戳）按 miss；新写行带戳可读
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 7, 8, null, 'ep-A')).toBeNull()
        writeTreeIssuesCache(
          db,
          '写作/正文/001-第1章.md',
          7,
          8,
          null,
          { hasRed: false, verdictRejected: false },
          'ep-A',
        )
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 7, 8, null, 'ep-A')).toEqual({
          hasRed: false,
          verdictRejected: false,
        })
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('集成：异纪元缓存行不混入本轮聚合（红章的「未检出」旧行被拒读、重算回真）', () => {
    const root = makeEpochColumnBook()
    try {
      const relPath = '写作/正文/001-第1章.md'
      // 首轮：建库 + 建表 + 记纪元（真实全局指纹 G）
      collectTreeIssues(root, () => undefined)
      const docId = [...readManifest(join(root, '项目', '文档清单.jsonl')).entries.keys()][0]!

      // 模拟他进程在轮中按「另一纪元」写入的行：章指纹真实（本轮 stat 未变）、
      // 内容「未检出」（假）——修复前本轮按章指纹误读 → 红章漏报
      const st = statSync(join(root, '写作/正文/001-第1章.md'), { bigint: true })
      const mtimeUs = Number(st.mtimeNs / 1000n)
      const size = Number(st.size)
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        insertRowWithEpoch(db, relPath, mtimeUs, size, 'stale-epoch', false)
      } finally {
        db.close()
      }

      // 本轮：全局输入未变 → sync 不清表，行级纪元戳是唯一防线
      const second = collectTreeIssues(root, () => undefined)
      expect(second.issues[docId]).toEqual({ hasRed: true, verdictRejected: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── R33D-17（并入档；原 r33d-batch-b.test.ts）：章缓存批量落盘单事务 ──
// writeTreeIssuesCacheBatch 单事务包批（行数正确落盘 + 批失败回退逐行）。

describe('R33D-17：章缓存批量落盘单事务', () => {
  function makeBatchDb(): DatabaseSync {
    const root = mkdtempTracked(join(tmpdir(), 'epoch-column-batch-'))
    const db = new DatabaseSync(join(root, 'index.db'))
    ensureTreeIssuesTables(db)
    return db
  }

  it('多行一次批量写入 → 全部可读（单 COMMIT）', () => {
    const db = makeBatchDb()
    const rows: TreeIssuesCacheRow[] = Array.from({ length: 50 }, (_, i) => ({
      relPath: `写作/正文/${String(i + 1).padStart(3, '0')}-章.md`,
      chapterFp: 1_700_000_000_000_000 + i,
      size: 100 + i,
      verdictFp: null,
      value: { hasRed: i % 2 === 0, verdictRejected: false },
      // R55-D-3：行级纪元戳（读写同锚即命中）
      epochFp: 'ep-a',
    }))
    writeTreeIssuesCacheBatch(db, rows)
    for (const r of rows) {
      const got = readTreeIssuesCache(db, r.relPath, r.chapterFp, r.size, r.verdictFp, 'ep-a')
      expect(got).toEqual(r.value)
    }
    db.close()
  })

  it('空数组 → no-op 不抛', () => {
    const db = makeBatchDb()
    expect(() => writeTreeIssuesCacheBatch(db, [])).not.toThrow()
    db.close()
  })
})

// ── P1-18（全项目源码二轮独立复审）：机检代次由检查器规则表哈希生成 ──
//
// 原状：CHECKER_GENERATION 是手工字面量（'a1-v2'），检查器语义演进漏 bump 时旧缓存
// 按章指纹照常命中，红黄项静默陈旧。现契约：代次 = 各检查器模块导出规则面（正则/
// 词表/阈值/升红集/导出函数名·参数个数·源文本）的机械哈希（checker-generation.ts）。
// 用例锚「规则变更必变代次」的可观察面，不锚代次字面量值——回退成字面量时
// 「同快照可复算」「逐条敏感」两用例即红。
describe('机检代次：规则表哈希（P1-18）', () => {
  it('代次 = 规则快照哈希（同快照可复算，非手工字面量）', () => {
    expect(computeCheckerGeneration(CHECKER_RULE_SNAPSHOT)).toBe(CHECKER_GENERATION)
  })

  it('任一规则表条目变更 → 代次必变（逐条敏感；反回退手工字面量）', () => {
    const entries = Object.entries(CHECKER_RULE_SNAPSHOT)
    // 规则面须有实质规模（空/单条快照 = 哈希机制形同虚设）
    expect(entries.length).toBeGreaterThan(50)
    for (const [key, value] of entries) {
      const mutated = { ...CHECKER_RULE_SNAPSHOT, [key]: `${value}\u0003mutation` }
      expect(computeCheckerGeneration(mutated), `规则「${key}」未参与代次哈希`).not.toBe(CHECKER_GENERATION)
    }
  })

  it('快照由规则表机械导出：关键条目与模块导出常量同源', () => {
    // 若把快照换成手写字面量，此处与真实规则表脱钩即红
    expect(CHECKER_RULE_SNAPSHOT['count.SIMILE_RE']).toBe(canonicalRuleValue(SIMILE_RE))
    expect(CHECKER_RULE_SNAPSHOT['count-dialogue.SPEECH_VERBS']).toBe(canonicalRuleValue(SPEECH_VERBS))
    expect(CHECKER_RULE_SNAPSHOT['quotes.QUOTED_SPAN_RE']).toBe(canonicalRuleValue(QUOTED_SPAN_RE))
    expect(CHECKER_RULE_SNAPSHOT['strict-short.STRICT_SHORT_CHECK_IDS']).toBe(
      canonicalRuleValue(STRICT_SHORT_CHECK_IDS),
    )
  })

  it('新并入模块的规则面已入哈希：与真实导出同源且变异必换代次', () => {
    // 这五个模块参与负载判定，其导出面必须入代次表（lead-updates/outline-leads/realms/
    // iron-rules/sentences）：否则改其函数体或常量不换代次，旧缓存按章指纹继续命中，
    // 红黄项静默陈旧。逐条锚「在快照内 + 脱胎于真实导出 + 变异必变代次」。
    const anchors: ReadonlyArray<readonly [string, unknown]> = [
      ['lead-updates.leadEvidenceMatchesBody', leadEvidenceMatchesBody],
      ['outline-leads.outlineDeclarationForChapter', outlineDeclarationForChapter],
      ['realms.extractExactRealmFromEvidence', extractExactRealmFromEvidence],
      ['iron-rules.parseIronRules', parseIronRules],
      ['sentences.ngramRepeatRate', ngramRepeatRate],
      ['ai-patterns.CLICHE_WORDS', CLICHE_WORDS],
      ['ai-patterns.AI_PATTERN_RULES', AI_PATTERN_RULES],
      // count-style 两条判定正则：未导出时藏于闭包/模块内，改它不动代次（旧缓存供旧判定）；
      // 导出 + 收编后改任一即换代次。此处逐条钉住。
      ['count-style.DE_RUN_SPLIT_RE', DE_RUN_SPLIT_RE],
      ['count-style.POSSESSIVE_UNIT_RE', POSSESSIVE_UNIT_RE],
    ]
    for (const [key, value] of anchors) {
      expect(CHECKER_RULE_SNAPSHOT[key], `规则「${key}」未入快照（模块未收编或导出改名）`).toBe(
        canonicalRuleValue(value),
      )
      const mutated = { ...CHECKER_RULE_SNAPSHOT, [key]: `${CHECKER_RULE_SNAPSHOT[key]}\u0003mutation` }
      expect(computeCheckerGeneration(mutated), `规则「${key}」未参与代次哈希`).not.toBe(CHECKER_GENERATION)
    }
  })

  it('函数体逻辑变更 → 代次必变（同模块同签名，仅体内实现不同）', () => {
    // 同名同参数个数的一对替身，仅体内实现差一处（`>` → `>=` 型演进）。名字与参数个数
    // 用 defineProperty 钉平（转译器给函数表达式改名不属被测语义）：两条规范串的唯一
    // 差异只能是函数体源文本。「名 + 参数个数」面判不出这类改动（两条相等 → 代次不变，
    // 缓存按章指纹继续命中，红黄项静默陈旧）；收源文本后代次必变。
    const narrow = function leadProbe(body: string, evidence: string): boolean {
      return body.includes(evidence)
    }
    const widened = function leadProbe(body: string, evidence: string): boolean {
      return body.includes(evidence) || evidence.length === 0
    }
    for (const fn of [narrow, widened]) {
      Object.defineProperty(fn, 'name', { value: leadEvidenceMatchesBody.name, configurable: true })
    }
    expect(narrow.length).toBe(leadEvidenceMatchesBody.length)
    expect(widened.length).toBe(narrow.length)
    const real = canonicalRuleValue(leadEvidenceMatchesBody)
    const narrowed = canonicalRuleValue(narrow)
    const widenedCanon = canonicalRuleValue(widened)
    expect(real).not.toBeNull()
    expect(narrowed).not.toBeNull()
    expect(widenedCanon).not.toBeNull()
    expect(widenedCanon).not.toBe(narrowed)
    const key = 'lead-updates.leadEvidenceMatchesBody'
    const base = { ...CHECKER_RULE_SNAPSHOT, [key]: real! }
    const changed = { ...CHECKER_RULE_SNAPSHOT, [key]: widenedCanon! }
    // base 与现行代次一致 = 该键的值确为真实导出函数的规范串（非同名占位）
    expect(computeCheckerGeneration(base)).toBe(CHECKER_GENERATION)
    expect(computeCheckerGeneration(changed)).not.toBe(CHECKER_GENERATION)
  })

  it('未变快照恒同串（确定性：重复计算 / 键序无关）', () => {
    expect(computeCheckerGeneration({ ...CHECKER_RULE_SNAPSHOT })).toBe(CHECKER_GENERATION)
    const reversed: Record<string, string> = {}
    for (const key of Object.keys(CHECKER_RULE_SNAPSHOT).reverse()) reversed[key] = CHECKER_RULE_SNAPSHOT[key]!
    expect(computeCheckerGeneration(reversed)).toBe(CHECKER_GENERATION)
  })

  it('代次参与全局纪元指纹首段（规则变 → 纪元变 → 整表缓存失效的接线锚）', () => {
    const root = bareDir()
    try {
      expect(computeTreeIssuesGlobalFp(root, null).startsWith(`${CHECKER_GENERATION}|`)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── 低精度 mtime 卷（FAT/exFAT/SMB）：章级缓存行降级 ────────────────────
// 粗粒度卷的 mtime 粒度粗于毫秒 → 同尺寸改写可落在同一刻度内，章级行身份
// （rel_path + (mtime,size) + verdict 指纹 + 纪元）逐位不变。降级判据 =
// isCoarseMtimeNs（整毫秒对齐），该卷既不读行也不落行（本轮真机检，见
// collectChapterRedDots 的 coarseMtime 注）。

describe('低精度 mtime 卷：章级缓存行降级（同尺寸改写不返回陈旧红点）', () => {
  /** 2 章书；第 1 章正文由 body 给出的同字节长度替换（红源有无切换）。 */
  function makeCoarseBook(): string {
    return makeCheckBook({ prefix: 'coarse-mtime-', chapterCount: 2 })
  }

  const chapterRel = '写作/正文/001-第1章.md'
  const redBody = '山门外的雨夜里，玉佩，连响了三下。\n' // 硬禁词命中（标点夹持）
  const plainBody = '山门外的雨夜里，灯火，连响了三下。\n' // 同字节长度、无禁词
  const chapterText = (body: string): string =>
    `---\n章号: 1\n标题: 第1章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${body}`
  const docIdOf = (root: string): string =>
    [...readManifest(join(root, '项目', '文档清单.jsonl')).entries.values()].find((e) => e.path === chapterRel)!.id

  it('同尺寸改写落在同一粗粒度刻度 → 二次聚合仍检出红点（不命中陈旧行）', () => {
    const root = makeCoarseBook()
    const fp = join(root, '写作', '正文', '001-第1章.md')
    try {
      // 无红源起步 + 粗粒度帧（同尺寸改写下 stat 逐位不变）
      writeFileSync(fp, chapterText(plainBody), 'utf-8')
      registerCoarseFrame(fp, statSync(fp, { bigint: true }).size)

      const first = collectTreeIssues(root, () => undefined)
      expect(first.issues[docIdOf(root)]).toBeUndefined() // 首轮无红源

      // 同尺寸改写引入红源（灯火 → 玉佩，等长替换）
      writeFileSync(fp, chapterText(redBody), 'utf-8')
      // 修复前：行指纹全同 → 命中首轮「未检出」行，红点被假阴性固化；修复后：该卷不缓存 → 重算检出
      const second = collectTreeIssues(root, () => undefined)
      expect(second.issues[docIdOf(root)]).toEqual({ hasRed: true, verdictRejected: false })
    } finally {
      coarseStatFrames.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('该卷零落盘：粗粒度章的缓存行不落表（降级即不驻留）', () => {
    const root = makeCoarseBook()
    const fp = join(root, '写作', '正文', '001-第1章.md')
    try {
      writeFileSync(fp, chapterText(redBody), 'utf-8')
      registerCoarseFrame(fp, statSync(fp, { bigint: true }).size)
      collectTreeIssues(root, () => undefined)

      const db = new DatabaseSync(join(root, '.cache', 'index.db'), { readOnly: true })
      try {
        // 粗粒度章零行；同书未登记帧的精修章照常落行——降级面按逐个章文件的 stat 判定
        const rows = db.prepare('SELECT rel_path FROM tree_issues_cache').all() as Array<{ rel_path: string }>
        expect(rows.map((r) => r.rel_path)).toEqual(['写作/正文/002-第2章.md'])
      } finally {
        db.close()
      }
    } finally {
      coarseStatFrames.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('精修卷（非整毫秒对齐）不降级：同指纹二次聚合走缓存行（降级面只对粗粒度卷生效）', () => {
    const root = makeCoarseBook()
    const fp = join(root, '写作', '正文', '001-第1章.md')
    try {
      writeFileSync(fp, chapterText(plainBody), 'utf-8')
      // 登记非对齐帧（ns 级精度卷形态）：同帧即判「盘上未变」
      const size = statSync(fp, { bigint: true }).size
      const fine = { size, mtimeNs: 1_700_000_002_000_000_123n }
      coarseStatFrames.set(fp, fine)
      try {
        coarseStatFrames.set(join(realpathSync(dirname(fp)), basename(fp)), fine)
      } catch {
        /* realpath 失败：词法键已登记 */
      }

      const first = collectTreeIssues(root, () => undefined)
      expect(first.issues[docIdOf(root)]).toBeUndefined()
      // 同帧（指纹未变）改写：行命中 → 与既有「stat 撞车命中」同口径（缓存行确实落了盘）
      writeFileSync(fp, chapterText(redBody), 'utf-8')
      const second = collectTreeIssues(root, () => undefined)
      expect(second.issues[docIdOf(root)]).toBeUndefined()

      const db = new DatabaseSync(join(root, '.cache', 'index.db'), { readOnly: true })
      try {
        const rows = db.prepare('SELECT COUNT(*) AS n FROM tree_issues_cache').get() as { n: number }
        expect(rows.n).toBe(2) // 两章各一行（降级未误伤精修卷的落盘）
      } finally {
        db.close()
      }
    } finally {
      coarseStatFrames.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
