/**
 * R59 清偿批（R55-D-3）回归：章级缓存行加纪元戳（tree_issues_cache.epoch_fp）。
 *
 * 修复前：章级行按「rel_path + 正文 stat + verdict 指纹」命中，不含纪元——双进程
 * 并发校验且轮中全局输入变更时，他进程按新纪元 sync 清表后写入的新纪元行，会被
 * 本进程（轮基线仍是旧纪元）按章指纹误读：单轮响应混入异纪元结果（持久层由轮后
 * 终核兜住不毒化，下一轮自愈，但该轮红点口径错）。
 *
 * 修复后契约（本文件锁定）：
 * 1. 行记落行时纪元（run.ts 传轮基线），读侧锚不匹配一律按 miss；
 * 2. 读侧无锚（null）一律按 miss——无法验证归属时宁重算勿混纪元；
 * 3. 旧格式行（epoch_fp NULL，存量库经 ensureTreeIssuesTables 补列后的旧行）天然
 *    不匹配 → 一次性失效重算（可接受），解析向后兼容不抛错。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { collectTreeIssues } from '../../src/check/run.js'
import { syncTreeIssuesEpoch, readTreeIssuesCache, writeTreeIssuesCache } from '../../src/check/tree-issues-cache.js'
import { ensureTreeIssuesTables } from '../../src/cache/schema.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 最小造书：1 章 + 布线（含禁词红源「玉佩」，保证重算必红） */
function makeBook(dirPrefix: string): string {
  const root = mkdtempTracked(join(tmpdir(), dirPrefix))
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
  return mkdtempTracked(join(tmpdir(), 'backlog-epoch-bare-'))
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
        writeTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, { hasRed: true, verdictRejected: false }, 'ep-A')
        // 同锚命中
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 111, 222, null, 'ep-A')).toEqual({ hasRed: true, verdictRejected: false })
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
        writeTreeIssuesCache(db, '写作/正文/001-第1章.md', 7, 8, null, { hasRed: false, verdictRejected: false }, 'ep-A')
        expect(readTreeIssuesCache(db, '写作/正文/001-第1章.md', 7, 8, null, 'ep-A')).toEqual({ hasRed: false, verdictRejected: false })
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('集成：异纪元缓存行不混入本轮聚合（红章的「未检出」旧行被拒读、重算回真）', () => {
    const root = makeBook('backlog-epoch-int-')
    try {
      const relPath = '写作/正文/001-第1章.md'
      const verdictOf = (): undefined => undefined
      // 首轮：建库 + 建表 + 记纪元（真实全局指纹 G）
      collectTreeIssues(root, verdictOf)
      const docId = [...readManifest(join(root, '项目', '文档清单.jsonl')).entries.keys()][0]!

      // 模拟他进程在轮中按「另一纪元」写入的行：章指纹真实（本轮 stat 未变）、
      // 内容「未检出」（假）——修复前本轮按章指纹误读 → 红章漏报
      const st = statSync(join(root, '写作', '正文', '001-第1章.md'), { bigint: true })
      const mtimeUs = Number(st.mtimeNs / 1000n)
      const size = Number(st.size)
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        insertRowWithEpoch(db, relPath, mtimeUs, size, 'stale-epoch', false)
      } finally {
        db.close()
      }

      // 本轮：全局输入未变 → sync 不清表，行级纪元戳是唯一防线
      const second = collectTreeIssues(root, verdictOf)
      expect(second.issues[docId]).toEqual({ hasRed: true, verdictRejected: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
