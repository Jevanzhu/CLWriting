/**
 * R69-1（十七轮）：legacy 冒号 docId 编码族差异面回归。
 *
 * 六十八轮修复批（R68-2/3/4）与六十九轮修复批（R69-3/4）改动了 docId 落文件名的
 * 读写口径（写侧恒编码 `:`→`_`、读侧双候选/反解），此前测试全部用无冒号 id
 * （literal===encoded 单候选），差异面零覆盖 + ai-track 一处假覆盖。本文件统一造
 * legacy:xxx 形态（字面/编码双落盘）锁行为：
 * - decodeDocDirName / analysisPathCandidates 纯函数
 * - writeAnalysis 合并基迁移（字面存量 kind 随写迁入编码文件不丢）
 * - purgeTrash 连删 分析信封+journal+版本目录（双候选，R69-4）
 * - state healthCheck journal 名反解自愈（编码名 + mac 存量字面名，R69-3）
 * - 孤儿 journal 归档（move 类证实无主）vs save 类保守报红（R69-4）
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeDocDirName, encodeDocDirName, writeVersion, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import {
  analysisPathCandidates,
  existingAnalysisPath,
  readAnalysis,
  writeAnalysis,
} from '../../src/document/analysis.js'
import { purgeTrash } from '../../src/document/trash.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { appendPending, appendMovePending, findUnsettled } from '../../src/document/journal.js'
import { detectState } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { makeGitBook } from '../helpers/book.js'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r69-enc-'))
})
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

// ── 纯函数 ───────────────────────────────────────

test('decodeDocDirName：legacy_ 前缀逆推冒号，真 legacy 字面与其余 id 原样', () => {
  expect(decodeDocDirName('legacy_abc')).toBe('legacy:abc')
  expect(decodeDocDirName('legacy:abc')).toBe('legacy:abc') // mac 存量字面名原样即 docId
  expect(decodeDocDirName('doc_a')).toBe('doc_a')
  expect(decodeDocDirName('folder_x')).toBe('folder_x')
  // 往返
  expect(decodeDocDirName(encodeDocDirName('legacy:deep'))).toBe('legacy:deep')
})

test('analysisPathCandidates：legacy id 双候选（R70-1 编码在前=权威位优先），无冒号单候选', () => {
  const two = analysisPathCandidates(root, 'legacy:abc')
  expect(two).toHaveLength(2)
  expect(two![0]).toBe(join(root, '项目', '分析', 'legacy_abc.json'))
  expect(two![1]).toBe(join(root, '项目', '分析', 'legacy:abc.json'))
  expect(analysisPathCandidates(root, 'doc_a')).toHaveLength(1)
  expect(analysisPathCandidates(root, 'bad/../id')).toBeNull()
})

// ── 分析信封读写 ─────────────────────────────────

test.skipIf(process.platform === 'win32')( // R70-8：字面冒号文件/目录仅 mac/Linux 可造（NTFS EINVAL），编码路径由其余用例覆盖
  'writeAnalysis：字面存量迁移——kind 迁入编码文件不丢 + R70-1/2 收口（写后删字面、二次写不清首次 kind）', () => {
  mkdirSync(join(root, '项目', '分析'), { recursive: true })
  const literal = join(root, '项目', '分析', 'legacy:abc.json')
  const encoded = join(root, '项目', '分析', 'legacy_abc.json')
  // mac 存量：字面文件已有 score（信封三字段齐 isEnvelope 才认）
  const env = (payload: unknown) => ({ generatedAt: 't1', model: 'm', sourceHash: 'sha256:x', payload })
  writeFileSync(literal, JSON.stringify({ score: env({ score: 8 }) }), 'utf-8')
  // 第一次写 emotion（R68-3：写侧恒落编码路径；第 4 参是完整信封）
  writeAnalysis(root, 'legacy:abc', 'emotion', env({ marks: [] }))
  // R70-1：写后字面源删除（读侧权威位收敛编码，不再被字面旧信封遮蔽）
  expect(existsSync(literal)).toBe(false)
  expect(existingAnalysisPath(root, 'legacy:abc')).toBe(encoded)
  const score = readAnalysis(root, 'legacy:abc', 'score')
  expect(score?.payload).toEqual({ score: 8 })
  const emotion = readAnalysis(root, 'legacy:abc', 'emotion')
  expect(emotion?.payload).toEqual({ marks: [] })
  // R70-2：第二次写 hooks——合并基为编码文件（含迁入的 score），首次写的 emotion 不被清除
  writeAnalysis(root, 'legacy:abc', 'hooks', env({ hooks: ['x'], density: '中' }))
  expect(readAnalysis(root, 'legacy:abc', 'emotion')?.payload).toEqual({ marks: [] })
  expect(readAnalysis(root, 'legacy:abc', 'score')?.payload).toEqual({ score: 8 })
  expect(readAnalysis(root, 'legacy:abc', 'hooks')?.payload).toEqual({ hooks: ['x'], density: '中' })
})

// ── purgeTrash 清除面（R69-4）────────────────────

async function makeTrashedLegacyBook(): Promise<void> {
  mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
  writeFileSync(join(root, '工作区', '.trash', 'legacy_purge-旧稿.md'), '旧内容', 'utf-8')
  writeFileSync(
    join(root, '工作区', '.trash', '.trash-manifest.jsonl'),
    JSON.stringify({
      id: 'legacy:purge',
      originalPath: '写作/正文/0001-旧稿.md',
      trashedPath: '工作区/.trash/legacy_purge-旧稿.md',
      trashedAt: '',
      role: 'chapter',
    }) + '\n',
    'utf-8',
  )
  // 版本目录：mac 存量字面 + 新写编码 双目录
  for (const name of ['legacy:purge', 'legacy_purge']) {
    mkdirSync(join(root, '工作区', VERSIONS_DIR_NAME, name), { recursive: true })
    writeFileSync(join(root, '工作区', VERSIONS_DIR_NAME, name, 'v1.md'), '快照', 'utf-8')
  }
  // 分析信封：字面 + 编码 双文件
  mkdirSync(join(root, '项目', '分析'), { recursive: true })
  writeFileSync(join(root, '项目', '分析', 'legacy:purge.json'), '{"score":{}}', 'utf-8')
  writeFileSync(join(root, '项目', '分析', 'legacy_purge.json'), '{"emotion":{}}', 'utf-8')
  // journal：编码名 + 未结算 save pending（含全文快照行）
  mkdirSync(join(root, '工作区', '.journal'), { recursive: true })
  await appendPending(join(root, '工作区', '.journal', 'legacy_purge.jsonl'), 'legacy:purge', 'sha256:x', '崩溃前全文')
  // 清单（供 purge 后孤儿判定对照：该 doc 不在清单）
  mkdirSync(join(root, '项目'), { recursive: true })
  writeManifest(join(root, '项目', '文档清单.jsonl'), readManifest(join(root, '项目', '文档清单.jsonl')))
}

test.skipIf(process.platform === 'win32')( // R70-8：字面冒号文件/目录仅 mac/Linux 可造（NTFS EINVAL），编码路径由其余用例覆盖
  'purgeTrash：连删 分析信封双候选 + journal 编码名 + 版本双目录（不可逆承诺不留残留）', async () => {
  await makeTrashedLegacyBook()
  const r = await purgeTrash(root, 'legacy:purge')
  expect(r.ok).toBe(true)
  expect(existsSync(join(root, '项目', '分析', 'legacy:purge.json'))).toBe(false)
  expect(existsSync(join(root, '项目', '分析', 'legacy_purge.json'))).toBe(false)
  expect(existsSync(join(root, '工作区', '.journal', 'legacy_purge.jsonl'))).toBe(false)
  expect(existsSync(join(root, '工作区', VERSIONS_DIR_NAME, 'legacy:purge'))).toBe(false)
  expect(existsSync(join(root, '工作区', VERSIONS_DIR_NAME, 'legacy_purge'))).toBe(false)
})

test.skipIf(process.platform === 'win32')( // R70-8：字面冒号文件/目录仅 mac/Linux 可造（NTFS EINVAL），编码路径由其余用例覆盖
  'purgeTrash 后 healthCheck：无幽灵 crashedWrite（journal 已随 purge 清除）', async () => {
  await makeTrashedLegacyBook()
  await purgeTrash(root, 'legacy:purge')
  // R70-33：无条件锚——journal 已随 purge 删除（恒可断言）；detectState 路由态取决于
  // fixture 其余形状（无正文章会走他态），「无幽灵」保持条件断言但锚已防恒空过
  expect(existsSync(join(root, '工作区', '.journal', 'legacy_purge.jsonl'))).toBe(false)
  const d = detectState(root, DEFAULT_CONFIG)
  if (d.state === 1) {
    expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
  }
})

// ── state healthCheck journal 名反解自愈（R69-3）────

async function makeLegacyMovePendingBook(pos: 'new' | 'old'): Promise<{ root: string; docId: string; journalName: string }> {
  const b = makeGitBook()
  const docId = 'legacy:mv1'
  const oldRel = '写作/正文/0001-旧.md'
  const newRel = '写作/正文/0002-新.md'
  mkdirSync(join(b, '写作', '正文'), { recursive: true })
  if (pos === 'new') writeFileSync(join(b, newRel), '# 第 2 章\n\n新内容', 'utf-8')
  else writeFileSync(join(b, oldRel), '# 第 1 章\n\n旧内容', 'utf-8')
  mkdirSync(join(b, '项目'), { recursive: true })
  const manifestPath = join(b, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: docId, nodeType: 'document', path: oldRel, parentId: null })
  writeManifest(manifestPath, m)
  // 写侧恒编码：盘上 journal 名 = legacy_mv1.jsonl
  const journalName = `${encodeDocDirName(docId)}.jsonl`
  mkdirSync(join(b, '工作区', '.journal'), { recursive: true })
  await appendMovePending(join(b, '工作区', '.journal', journalName), docId, oldRel, newRel)
  return { root: b, docId, journalName }
}

test('legacy move pending（编码名 journal）：自愈补清单 + settled 落在被扫的编码名文件', async () => {
  const { root: b, docId, journalName } = await makeLegacyMovePendingBook('new')
  try {
    const d = detectState(b, DEFAULT_CONFIG)
    // 清单键 = 真实 legacy:xxx（此前不反解时 heal 对清单全 miss：不补路径仍标 settled）
    expect(readManifest(join(b, '项目', '文档清单.jsonl')).entries.get(docId)?.path).toBe('写作/正文/0002-新.md')
    if (d.state === 1) expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
    // settled 追加到被扫的编码名文件（不是 legacy:mv1.jsonl 字面新文件）
    const jDir = join(b, '工作区', '.journal')
    expect(findUnsettled(join(jDir, journalName))).toHaveLength(0)
    expect(existsSync(join(jDir, 'legacy:mv1.jsonl'))).toBe(false) // 未另写字面名文件
    expect(readdirSync(jDir).filter((f) => f.endsWith('.jsonl'))).toEqual([journalName])
  } finally {
    rmSync(b, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')( // R70-8：字面冒号文件/目录仅 mac/Linux 可造（NTFS EINVAL），编码路径由其余用例覆盖
  'mac 存量字面名 journal：settled 同样落在被扫的字面文件（沿用被扫文件口径）', async () => {
  const b = makeGitBook()
  try {
    const docId = 'legacy:lit1'
    const oldRel = '写作/正文/0001-旧.md'
    const newRel = '写作/正文/0002-新.md'
    mkdirSync(join(b, '写作', '正文'), { recursive: true })
    writeFileSync(join(b, newRel), '# 第 2 章\n\n新内容', 'utf-8')
    mkdirSync(join(b, '项目'), { recursive: true })
    const manifestPath = join(b, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    upsertEntry(m, { id: docId, nodeType: 'document', path: oldRel, parentId: null })
    writeManifest(manifestPath, m)
    // mac 存量：编码收口之前写的字面名 journal
    const literalJournal = join(b, '工作区', '.journal', 'legacy:lit1.jsonl')
    mkdirSync(join(b, '工作区', '.journal'), { recursive: true })
    await appendMovePending(literalJournal, docId, oldRel, newRel)

    detectState(b, DEFAULT_CONFIG)
    expect(readManifest(manifestPath).entries.get(docId)?.path).toBe(newRel)
    expect(findUnsettled(literalJournal)).toHaveLength(0) // settled 落在被扫字面文件
    expect(existsSync(join(b, '工作区', '.journal', 'legacy_lit1.jsonl'))).toBe(false) // 未分流到编码新文件
  } finally {
    rmSync(b, { recursive: true, force: true })
  }
})

// ── 孤儿 journal 归档（R69-4）────────────────────

test('孤儿 journal（清单无登记 + move 两端都不在）→ 归档 .orphaned 不报 crashedWrite', async () => {
  mkdirSync(join(root, '工作区', '.journal'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  // 空清单（文档已删）
  writeManifest(join(root, '项目', '文档清单.jsonl'), readManifest(join(root, '项目', '文档清单.jsonl')))
  const j = join(root, '工作区', '.journal', 'legacy_ghost.jsonl')
  await appendMovePending(j, 'legacy:ghost', '写作/正文/0001-已删.md', '写作/正文/0002-也没了.md')
  const d = detectState(root, DEFAULT_CONFIG)
  if (d.state === 1) expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
  expect(existsSync(j)).toBe(false)
  expect(readdirSync(join(root, '工作区', '.journal')).some((f) => f.startsWith('legacy_ghost.jsonl.orphaned-'))).toBe(true)
})

test('孤儿判定保守面：save pending（无路径字段无法证实无主）→ 仍报 crashedWrite', async () => {
  mkdirSync(join(root, '工作区', '.journal'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeManifest(join(root, '项目', '文档清单.jsonl'), readManifest(join(root, '项目', '文档清单.jsonl')))
  const j = join(root, '工作区', '.journal', 'legacy_save.jsonl')
  await appendPending(j, 'legacy:save', 'sha256:x', '全文快照')
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state === 1) {
    expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(true)
  }
  expect(existsSync(j)).toBe(true) // 不归档
})

// ── writeVersion 编码写 + 反解读（ai-track 假覆盖补位，非 git 库走版本档案后端）────

test('writeVersion 恒编码 + ai-track listTrackedDocs 非 git 后端反解（R68-4 真覆盖）', async () => {
  const { listTrackedDocs } = await import('../../src/git/ai-track.js')
  // 非 git 库（无 git init）→ listTrackedDocs 走版本档案后端分支（test/git 的既有用例
  // 因 beforeEach git init 恒走 ref 后端，从未触达该分支 = 假覆盖）
  const id1 = writeVersion(join(root, '工作区', VERSIONS_DIR_NAME), 'legacy:abc', '内容一', { origin: 'ai' })
  const id2 = writeVersion(join(root, '工作区', VERSIONS_DIR_NAME), 'doc_b', '内容二', { origin: 'ai' })
  expect(id1).not.toBeNull()
  expect(id2).not.toBeNull()
  // 写侧恒编码：目录名不含冒号
  expect(existsSync(join(root, '工作区', VERSIONS_DIR_NAME, 'legacy_abc'))).toBe(true)
  const docs = listTrackedDocs(root)
  expect(docs).toContain('legacy:abc') // 反解回真实 id（此前收割对 legacy 文档静默失明）
  expect(docs).toContain('doc_b')
})
