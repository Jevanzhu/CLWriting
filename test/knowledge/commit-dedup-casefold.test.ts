/**
 * 知识层登记判重的平台折叠口径：commitKnowledgeFile 判重走 caseFoldKey（win32 折叠）。
 *
 * 档源：原 r40-knowledge.test.ts 的 R40-16 组（同文件 R40-17 fm 注入行尾/BOM 保真组
 * 另拆 commit-fm-inject-line-ending-fidelity.test.ts）。
 *
 * R40-16（四十轮）：此前精确比较与校验器折叠口径分裂，大小写漂移可重登双条目；
 * 坏形状行（null/缺 target）跳过 + warn 留痕，不再 TypeError 崩整个登记（坏行面在
 * manifest-malformed-shape-guard.test.ts 同族锁定，此处保留 null 行的登记侧回归锁）。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { commitKnowledgeFile } from '../../src/knowledge/update.js'
import { KNOWLEDGE_MANIFEST } from '../../src/knowledge/manifest.js'
import { log } from '../../src/log/index.js'

const dirs: string[] = []
function tempProject(): string {
  const d = mkdtempTracked(join(tmpdir(), 'knowledge-commit-dedup-'))
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
  writeFileSync(
    join(root, KNOWLEDGE_MANIFEST),
    JSON.stringify({ version: 1, generated_at: '2026-01-01T00:00:00+08:00', entries }),
    'utf-8',
  )
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

describe('登记判重 win32 折叠', () => {
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
