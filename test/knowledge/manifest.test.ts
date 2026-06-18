import { test, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hashFileSha256,
  validateKnowledgeManifest,
  type KnowledgeManifest,
} from '../../src/knowledge/manifest.js'

function makeKnowledgeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'clwriting-knowledge-'))
  mkdirSync(join(root, '知识层', '题材'), { recursive: true })
  writeFileSync(
    join(root, '知识层', '题材', 'README.md'),
    [
      '---',
      'source: fixture-source',
      'license: MIT',
      '---',
      '',
      '# 题材',
      '',
    ].join('\n'),
    'utf-8',
  )
  writeManifest(root, {
    version: 1,
    generated_at: '2026-06-18T00:00:00.000Z',
    summary: { migrated: 1, deferred: 0, review_assets: 0 },
    entries: [
      {
        target: '知识层/题材/README.md',
        source: 'fixture-source',
        source_ref: 'fixture',
        license: 'MIT',
        sha256: hashFileSha256(join(root, '知识层', '题材', 'README.md')),
        category: '题材',
      },
    ],
  })
  return root
}

function writeManifest(root: string, manifest: KnowledgeManifest): void {
  writeFileSync(join(root, '知识层', '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
}

test('validateKnowledgeManifest: 当前仓库知识层 manifest 与落地文件一致', () => {
  const report = validateKnowledgeManifest(process.cwd())
  expect(report.ok).toBe(true)
  expect(report.manifest?.entries.length).toBe(9)
  expect(report.manifest?.entries.some((entry) => entry.source.includes('oh-story-claudecode'))).toBe(true)
})

test('validateKnowledgeManifest: 合法 manifest 通过', () => {
  const root = makeKnowledgeProject()
  const report = validateKnowledgeManifest(root)
  expect(report.ok).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('validateKnowledgeManifest: hash 不匹配时报错', () => {
  const root = makeKnowledgeProject()
  const manifest = validateKnowledgeManifest(root).manifest!
  manifest.entries[0]!.sha256 = 'sha256:bad'
  writeManifest(root, manifest)

  const report = validateKnowledgeManifest(root)
  expect(report.ok).toBe(false)
  expect(report.issues.some((issue) => issue.message.includes('sha256 不匹配'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('validateKnowledgeManifest: 拒绝知识层外路径', () => {
  const root = makeKnowledgeProject()
  const manifest = validateKnowledgeManifest(root).manifest!
  manifest.entries[0]!.target = 'Dev/ignored.md'
  writeManifest(root, manifest)

  const report = validateKnowledgeManifest(root)
  expect(report.ok).toBe(false)
  expect(report.issues.some((issue) => issue.message.includes('target 必须位于知识层'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('validateKnowledgeManifest: Markdown 文件必须保留 source/license 元信息', () => {
  const root = makeKnowledgeProject()
  writeFileSync(join(root, '知识层', '题材', 'README.md'), '# 题材\n', 'utf-8')
  const manifest = validateKnowledgeManifest(root).manifest!
  manifest.entries[0]!.sha256 = hashFileSha256(join(root, '知识层', '题材', 'README.md'))
  writeManifest(root, manifest)

  const report = validateKnowledgeManifest(root)
  expect(report.ok).toBe(false)
  expect(report.issues.some((issue) => issue.message.includes('source 元信息'))).toBe(true)
  expect(report.issues.some((issue) => issue.message.includes('license 元信息'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})
