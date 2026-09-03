/**
 * R40-16/17（四十轮）回归：知识层登记判重折叠 + 坏行降级 + fm 注入行尾/BOM 保真。
 *
 * - R40-16：commitKnowledgeFile 判重改走 caseFoldKey（win32 折叠）——此前精确比较与
 *   校验器折叠口径分裂，大小写漂移可重登双条目；坏形状行（null/缺 target）跳过 +
 *   warn 留痕，不再 TypeError 崩整个登记。
 * - R40-17：injectFrontMatterKeys 宿主行尾/BOM 保真——CRLF 宿主注入后不再混排、
 *   BOM 宿主不再静默丢 BOM（joinFrontMatter R39-10 + BOM 记账补回）。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitKnowledgeFile } from '../../src/knowledge/update.js'
import { KNOWLEDGE_MANIFEST } from '../../src/knowledge/manifest.js'
import { log } from '../../src/log/index.js'

const dirs: string[] = []
function tempProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'clw-r40-knowledge-'))
  dirs.push(d)
  mkdirSync(join(d, '知识层'), { recursive: true })
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
})

function writeManifest(root: string, entries: unknown[]): void {
  // version: 1 必填——commitKnowledgeFile 末尾走 validateKnowledgeManifest 对账，
  // 缺 version 会被对账拒绝（ok:false + 「manifest.version 必须是 1」），与被测语义无关
  writeFileSync(join(root, KNOWLEDGE_MANIFEST), JSON.stringify({ version: 1, generated_at: '2026-01-01T00:00:00+08:00', entries }), 'utf-8')
}

const SEED_ENTRY = {
  target: '知识层/a.md',
  source: '语料回归域',
  source_ref: 'test/corpus/x.json',
  license: 'internal',
  category: '设定',
  sha256: 'sha256:' + 'a'.repeat(64),
  registered_at: '2026-01-01T00:00:00+08:00',
}

describe('R40-16: 登记判重 win32 折叠', () => {
  it('win32：知识层/a.md 已登记 → 知识层/A.md 拒绝重复（折叠同键）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const root = tempProject()
    writeManifest(root, [SEED_ENTRY])
    const r = commitKnowledgeFile(root, { target: '知识层/A.md', source: 's', license: 'l' })
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.message.includes('不得重复登记'))).toBe(true)
  })

  it('未登记的新名通过判重（走到文件存在性检查才被拦）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const root = tempProject()
    writeManifest(root, [SEED_ENTRY])
    const r = commitKnowledgeFile(root, { target: '知识层/b.md', source: 's', license: 'l' })
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.message.includes('不得重复登记'))).toBe(false)
  })

  it('posix：大小写敏感语义保持（A.md 与 a.md 是两个键）', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const root = tempProject()
    writeManifest(root, [SEED_ENTRY])
    const r = commitKnowledgeFile(root, { target: '知识层/A.md', source: 's', license: 'l' })
    expect(r.issues.some((i) => i.message.includes('不得重复登记'))).toBe(false)
  })

  it('坏形状行（null）不崩登记、warn 留痕、条目保留', () => {
    const root = tempProject()
    writeManifest(root, [null, SEED_ENTRY])
    writeFileSync(join(root, '知识层', 'c.md'), '坏行宿主正文。\n', 'utf-8') // 登记要求定稿文件在盘
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const r = commitKnowledgeFile(root, { target: '知识层/c.md', source: 's', license: 'l' })
    expect(r.issues.some((i) => i.message.includes('不得重复登记'))).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls.some((c) => String(c[1]).includes('坏形状'))).toBe(true)
    // 坏行原样保留进全量重写（写入侧不静默增删改）
    const after = JSON.parse(readFileSync(join(root, KNOWLEDGE_MANIFEST), 'utf-8')) as { entries: unknown[] }
    expect(after.entries[0]).toBeNull()
    expect(after.entries.some((e) => (e as { target?: string })?.target === '知识层/c.md')).toBe(true)
  })
})

describe('R40-17: fm 注入行尾/BOM 规范形（批一翻转）', () => {
  it('CRLF 无 fm 宿主 → 注入后整文件归一 LF（保真契约翻转）', () => {
    const root = tempProject()
    writeManifest(root, [])
    const fp = join(root, '知识层', 'x.md')
    writeFileSync(fp, '第一段正文。\r\n\r\n第二段正文。\r\n', 'utf-8')
    const r = commitKnowledgeFile(root, { target: '知识层/x.md', source: 's', license: 'l' })
    expect(r.ok).toBe(true)
    const after = readFileSync(fp, 'utf-8')
    expect(after.startsWith('---')).toBe(true) // fm 注入在位
    expect(after.includes('source: s')).toBe(true)
    expect(after.includes('\r')).toBe(false) // 规范形：无 \r 残留
  })

  it('BOM 宿主 → 注入后 BOM 剥除（写侧规范形，读侧容忍不变）', () => {
    const root = tempProject()
    writeManifest(root, [])
    const fp = join(root, '知识层', 'y.md')
    writeFileSync(fp, '\uFEFF带 BOM 的正文。', 'utf-8')
    const r = commitKnowledgeFile(root, { target: '知识层/y.md', source: 's', license: 'l' })
    expect(r.ok).toBe(true)
    const after = readFileSync(fp, 'utf-8')
    expect(after.includes('\uFEFF')).toBe(false) // BOM 随规范形写回收口剥除
    expect(after.startsWith('---')).toBe(true) // fm 注入在位
  })

  it('LF 无 BOM 宿主 → 逐字节形态不变（无 \\r 引入）', () => {
    const root = tempProject()
    writeManifest(root, [])
    const fp = join(root, '知识层', 'z.md')
    writeFileSync(fp, '---\n场景: 战斗\n---\n\n既有 fm 正文。\n', 'utf-8')
    const r = commitKnowledgeFile(root, { target: '知识层/z.md', source: 's2', license: 'l2' })
    expect(r.ok).toBe(true)
    const after = readFileSync(fp, 'utf-8')
    expect(after.includes('\r')).toBe(false)
    expect(after.includes('场景: 战斗')).toBe(true) // 既有键保留
    expect(after.includes('source: s2')).toBe(true) // 新键注入
  })
})
