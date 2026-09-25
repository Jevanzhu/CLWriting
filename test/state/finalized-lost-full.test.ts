/**
 * C-5（二十九轮）回归：finalizedLost 核对范围放宽 + 探测失败不静默。
 *
 * 背景：healthCheck 的已定稿丢失核对原先只看固定四前缀（写作/正文/设定/大纲/布线），
 * 定稿在四前缀之外的登记文档（manifest.finalizedRevision 是唯一定稿标记）丢失零出口。
 * 修复后按清单全量核对；同时 stat 出错（EACCES/ENOTDIR 等不可探测形态）同样计入
 * lost（保守报红），并 log.warn 留痕——不可读 ≠ 不在盘，不再静默。
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { detectState } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { makeGitBookWithChapters } from '../helpers/book.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

/** 在健康书上追加一条四前缀之外的定稿登记（盘上无此文件）。 */
function registerFinalizedOutsidePrefixes(root: string, rel: string): void {
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  upsertEntry(m, {
    id: 'doc_c5_out',
    nodeType: 'document',
    path: rel,
    parentId: null,
    finalizedRevision: 'sha256:abc',
    finalizedAt: new Date().toISOString(),
  })
  writeManifest(manifestPath, m)
}

test('C-5: 四前缀之外的定稿登记丢失 → finalizedLost（旧前缀过滤下零出口）', async () => {
  const root = makeGitBookWithChapters(2, { commitEach: false })
  try {
    registerFinalizedOutsidePrefixes(root, '附录/旧稿.md')
    expect(existsSync(join(root, '附录', '旧稿.md'))).toBe(false)
    const d = await detectState(root, DEFAULT_CONFIG)
    expect(d.state).toBe(1)
    if (d.state !== 1) return
    const lost = d.issues.find((i) => i.kind === 'finalizedLost')
    expect(lost).toBeDefined()
    expect(lost?.files).toContain('附录/旧稿.md')
    expect(lost?.humanMsg).toContain('附录/旧稿.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('C-5: 探测出错（ENOTDIR：父段是普通文件）→ 同样计入 lost（不静默）', async () => {
  const root = makeGitBookWithChapters(2, { commitEach: false })
  try {
    // 「附录」是普通文件而非目录 → statSync('附录/旧稿.md') 抛 ENOTDIR（非 ENOENT，
    // 走 stat 错误分支：计入 lost + warn 留痕）
    writeFileSync(join(root, '附录'), '占位：同名普通文件', 'utf-8')
    registerFinalizedOutsidePrefixes(root, '附录/旧稿.md')
    const d = await detectState(root, DEFAULT_CONFIG)
    expect(d.state).toBe(1)
    if (d.state !== 1) return
    const lost = d.issues.find((i) => i.kind === 'finalizedLost')
    expect(lost).toBeDefined()
    expect(lost?.files).toContain('附录/旧稿.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('C-5: 定稿文件全在盘 → 无 finalizedLost（全量核对不误报）', async () => {
  const root = makeGitBookWithChapters(2, { commitEach: false })
  try {
    // 四前缀之外但文件在盘的定稿登记 → 不报
    mkdirSync(join(root, '附录'), { recursive: true })
    writeFileSync(join(root, '附录', '外传.md'), '---\n标题: 外传\n---\n\n正文\n', 'utf-8')
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    upsertEntry(m, {
      id: 'doc_c5_ok',
      nodeType: 'document',
      path: '附录/外传.md',
      parentId: null,
      finalizedRevision: 'sha256:def',
      finalizedAt: new Date().toISOString(),
    })
    writeManifest(manifestPath, m)
    const d = await detectState(root, DEFAULT_CONFIG)
    if (d.state === 1) {
      expect(d.issues.some((i) => i.kind === 'finalizedLost')).toBe(false)
    }
    expect(d.state).not.toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
