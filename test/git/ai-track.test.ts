/**
 * 改稿轨迹旁路 ref 单测（文风系统重整 S2）。
 * 写读列删、legacy docId 编码、时间序、reset --hard 免疫、非 git 目录容错。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordAiVersion,
  listAiVersions,
  readAiVersion,
  deleteAiVersions,
  encodeRefSegment,
  decodeRefSegment,
  listTrackedDocs,
} from '../../src/git/ai-track.js'
import { git } from '../../src/git/exec.js'
import { legacyId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 测试自备 add+commit（exec.addCommit 已随去 git 清理删除）。返回 commit hash。 */
function commit(root: string, msg: string): { ok: boolean; hash: string } {
  for (const args of [['add', '-A'], ['commit', '-m', msg], ['rev-parse', 'HEAD']] as string[][]) {
    const r = git(args, root)
    if (!r.ok) return { ok: false, hash: '' }
    if (args[0] === 'rev-parse') return { ok: true, hash: r.stdout.trim() }
  }
  return { ok: false, hash: '' }
}


let root = ''

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clwriting-ai-track-'))
  git(['init'], root)
  git(['config', 'user.email', 'test@test.com'], root)
  git(['config', 'user.name', 'test'], root)
  git(['config', 'commit.gpgsign', 'false'], root)
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('recordAiVersion / listAiVersions / readAiVersion', () => {
  it('写一版 → 列出一条 → 读回原文（中文多行无损）', () => {
    const content = '第一段。\n\n「他说什么？」\n第二段落。'
    const ref = recordAiVersion(root, 'doc_TESTID001', content)
    expect(ref).toMatch(/^refs\/clwriting\/ai\/doc_TESTID001\/[0-9A-Z]{26}$/)
    const versions = listAiVersions(root, 'doc_TESTID001')
    expect(versions).toHaveLength(1)
    expect(versions[0]!.ref).toBe(ref)
    expect(readAiVersion(root, 'doc_TESTID001', versions[0]!.sha)).toBe(content)
  })

  it('多版按 ulid 升序（时间序）；不同文档互不串', () => {
    recordAiVersion(root, 'doc_A', '版本一')
    recordAiVersion(root, 'doc_A', '版本二')
    recordAiVersion(root, 'doc_B', '别的文档')
    const a = listAiVersions(root, 'doc_A')
    expect(a).toHaveLength(2)
    expect(a[0]!.ulid <= a[1]!.ulid).toBe(true)
    expect(readAiVersion(root, 'doc_A', a[1]!.sha)).toBe('版本二')
    expect(listAiVersions(root, 'doc_B')).toHaveLength(1)
  })

  it('legacy docId（含冒号）编码进 ref 且可回查', () => {
    const docId = legacyId('工作区/草稿-2.md')
    expect(docId).toContain(':')
    expect(encodeRefSegment(docId)).not.toContain(':')
    const ref = recordAiVersion(root, docId, 'AI 草稿全文')
    expect(ref).not.toBeNull()
    const versions = listAiVersions(root, docId)
    expect(versions).toHaveLength(1)
    expect(readAiVersion(root, docId, versions[0]!.sha)).toBe('AI 草稿全文')
  })

  it('空内容不记；hex sha 在无 git 书库读不回（cat-file 失败 → null 不崩）', () => {
    expect(recordAiVersion(root, 'doc_A', '   ')).toBeNull()
    expect(readAiVersion(root, 'doc_A', 'deadbeef')).toBeNull()
  })
})

// ── X-P2-3：无 git 书库（v3 新书）双后端 → 工作区/.版本（origin 'ai'） ────────

describe('X-P2-3 版本档案后端（无 .git 书库）', () => {
  it('recordAiVersion → 落 工作区/.版本；list/read/listTrackedDocs/delete 全链可用', () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clwriting-not-git-'))
    try {
      // 修复前：无 git 静默返回 null（自愈/改写轨迹全丢）；现在落版本档案
      const id = recordAiVersion(plain, 'doc_A', 'AI 版本一')
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      recordAiVersion(plain, 'doc_A', 'AI 版本二')
      recordAiVersion(plain, 'doc_B', '别的文档')

      const a = listAiVersions(plain, 'doc_A')
      expect(a).toHaveLength(2)
      expect(a[0]!.ulid <= a[1]!.ulid).toBe(true) // 升序口径与 git 路径一致
      expect(readAiVersion(plain, 'doc_A', a[1]!.sha)).toBe('AI 版本二')
      expect(readAiVersion(plain, 'doc_A', a[0]!.sha)).toBe('AI 版本一')

      expect(listTrackedDocs(plain)).toContain('doc_A')
      expect(listTrackedDocs(plain)).toContain('doc_B')

      expect(deleteAiVersions(plain, 'doc_A')).toBe(2)
      expect(listAiVersions(plain, 'doc_A')).toHaveLength(0)
      expect(listAiVersions(plain, 'doc_B')).toHaveLength(1)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('编辑快照（非 ai 来源）不混入 AI 轨迹列表', async () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clwriting-not-git-'))
    try {
      const { writeVersion } = await import('../../src/document/version.js')
      writeVersion(join(plain, '工作区', '.版本'), 'doc_A', '手编辑内容', { origin: 'manual' })
      recordAiVersion(plain, 'doc_A', 'AI 版本')
      const a = listAiVersions(plain, 'doc_A')
      expect(a).toHaveLength(1) // manual 快照不进 AI 轨迹
      expect(readAiVersion(plain, 'doc_A', a[0]!.sha)).toBe('AI 版本')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('旁路语义', () => {
  it('reset --hard 免疫：回退分支后轨迹 ref 原样在', () => {
    writeFileSync(join(root, 'a.md'), '第一稿', 'utf-8')
    const c1 = commit(root, 'ch:0001 第一章')
    expect(c1.ok).toBe(true)
    recordAiVersion(root, 'doc_A', 'AI 初版全文')
    writeFileSync(join(root, 'a.md'), '第二稿', 'utf-8')
    expect(commit(root, 'ch:0002 第二章').ok).toBe(true)
    // 回滚到第一章 commit
    const hash = c1.ok ? c1.hash : ''
    expect(git(['reset', '--hard', hash], root).ok).toBe(true)
    const versions = listAiVersions(root, 'doc_A')
    expect(versions).toHaveLength(1)
    expect(readAiVersion(root, 'doc_A', versions[0]!.sha)).toBe('AI 初版全文')
  })

  it('旁路 ref 不进 git log（不污染 ch: 链）', () => {
    writeFileSync(join(root, 'a.md'), '正文', 'utf-8')
    expect(commit(root, 'ch:0001 第一章').ok).toBe(true)
    recordAiVersion(root, 'doc_A', 'AI 版')
    const log = git(['log', '--all', '--oneline'], root)
    expect(log.ok).toBe(true)
    expect(log.ok ? log.stdout : '').not.toContain('clwriting')
  })

  it('deleteAiVersions：删净某文档轨迹，别的文档不动', () => {
    recordAiVersion(root, 'doc_A', '一')
    recordAiVersion(root, 'doc_A', '二')
    recordAiVersion(root, 'doc_B', '三')
    expect(deleteAiVersions(root, 'doc_A')).toBe(2)
    expect(listAiVersions(root, 'doc_A')).toHaveLength(0)
    expect(listAiVersions(root, 'doc_B')).toHaveLength(1)
  })

  it('listTrackedDocs：列全书轨迹文档，legacy docId 反解还原冒号', () => {
    const legacy = legacyId('工作区/草稿-3.md')
    recordAiVersion(root, 'doc_A', '一')
    recordAiVersion(root, 'doc_A', '二')
    recordAiVersion(root, legacy, '三')
    const docs = listTrackedDocs(root)
    expect(docs).toHaveLength(2)
    expect(docs).toContain('doc_A')
    expect(docs).toContain(legacy)
    // 纯函数往返
    expect(decodeRefSegment(encodeRefSegment(legacy))).toBe(legacy)
    expect(decodeRefSegment('doc_A')).toBe('doc_A')
  })
})

// ── R65-28（第六十五轮）：listTrackedDocs meta 读去重缓存——结果与逐版直读恒等 ──

describe('R65-28: listTrackedDocs 版本档案后端（meta 缓存路径）', () => {
  it('混合 origin 多文档：只列含 ai 版本的 docId，且与逐 doc 独立 listAiVersions 结果一致', async () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clwriting-r65-28-'))
    try {
      const { writeVersion } = await import('../../src/document/version.js')
      const vdir = join(plain, '工作区', '.版本')
      // doc_A：ai 两版 + manual 一版（应列出）；doc_B：纯 manual（不应列出）；doc_C：纯 ai（应列出）
      writeVersion(vdir, 'doc_A', '手编辑', { origin: 'manual' })
      recordAiVersion(plain, 'doc_A', 'AI 一版')
      recordAiVersion(plain, 'doc_A', 'AI 二版')
      writeVersion(vdir, 'doc_B', '纯手写', { origin: 'autosave' })
      recordAiVersion(plain, 'doc_C', 'AI 轨迹')
      const tracked = listTrackedDocs(plain).sort()
      expect(tracked).toEqual(['doc_A', 'doc_C'])
      // 与逐 doc 独立调用（不共享缓存）口径一致
      expect(listAiVersions(plain, 'doc_A')).toHaveLength(2)
      expect(listAiVersions(plain, 'doc_B')).toHaveLength(0)
      expect(listAiVersions(plain, 'doc_C')).toHaveLength(1)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
