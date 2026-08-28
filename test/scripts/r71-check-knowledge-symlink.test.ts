/**
 * R71-39（十九轮）回归：check-knowledge 反向扫描对 symlink→目录 fail-closed——
 * 修复前 Dirent.isDirectory() 对 symlink 恒 false，指向目录的 symlink 被静默跳过
 * （目录内 .md 整树逃 R62-53 反向门）；修复后 collectMdFiles 遇 symlink→目录即抛
 * （经 scanUnregisteredKnowledgeMd 传播，main 转人话报错 + exit(1)）。
 * symlink→文件沿用 .md 名字口径：未登记即 unmatched（不豁免、不误跳）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanUnregisteredKnowledgeMd } from '../../scripts/check-knowledge.js'

// Windows 建 symlink 需开发者模式（无防护 symlinkSync 直建 EPERM），该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('R71-39: symlink→目录 → fail-closed 抛错（不再静默跳过整树）', () => {
  const root = mkdtempSync(join(tmpdir(), 'r71-ck-'))
  try {
    const knowledgeRoot = join(root, '知识层')
    const outside = join(root, '外部目录')
    mkdirSync(knowledgeRoot, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, '逃逸.md'), '未登记内容', 'utf8')
    symlinkSync(outside, join(knowledgeRoot, '目录链接'))

    // 修复前：isDirectory() 对 symlink 恒 false → 静默跳过（反向门被绕过）
    expect(() => scanUnregisteredKnowledgeMd(root, [])).toThrowError(/指向目录的 symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')('R71-39: symlink→文件 按 .md 名字口径参与反向扫描（未登记即 unmatched）', () => {
  const root = mkdtempSync(join(tmpdir(), 'r71-ck-file-'))
  try {
    const knowledgeRoot = join(root, '知识层')
    const outside = join(root, '外部文件.md')
    mkdirSync(knowledgeRoot, { recursive: true })
    writeFileSync(outside, '未登记内容', 'utf8')
    symlinkSync(outside, join(knowledgeRoot, '文件链接.md'))

    const unmatched = scanUnregisteredKnowledgeMd(root, [])
    expect(unmatched).toContain('知识层/文件链接.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
