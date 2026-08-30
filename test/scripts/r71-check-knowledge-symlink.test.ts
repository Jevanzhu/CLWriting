/**
 * R71-39（十九轮）回归：check-knowledge 反向扫描对 symlink→目录 fail-closed——
 * 修复前 Dirent.isDirectory() 对 symlink 恒 false，指向目录的 symlink 被静默跳过
 * （目录内资产整树逃 R62-53 反向门）；修复后资产收集遇 symlink→目录即抛（收集函数
 * 现名 collectKnowledgeAssetFiles，R27-135 更名扩面前的 collectMdFiles；经
 * scanUnregisteredKnowledgeAssets 传播，main 转人话报错 + exit(1)）。
 * symlink→文件按普通资产参与反向扫描（R27-135 起不限 .md）：未登记即 unmatched
 * （不豁免、不误跳）。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanUnregisteredKnowledgeAssets } from '../../scripts/check-knowledge.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// Windows 建 symlink 需开发者模式（无防护 symlinkSync 直建 EPERM），该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('R71-39: symlink→目录 → fail-closed 抛错（不再静默跳过整树）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r71-ck-'))
  try {
    const knowledgeRoot = join(root, '知识层')
    const outside = join(root, '外部目录')
    mkdirSync(knowledgeRoot, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, '逃逸.md'), '未登记内容', 'utf8')
    symlinkSync(outside, join(knowledgeRoot, '目录链接'))

    // 修复前：isDirectory() 对 symlink 恒 false → 静默跳过（反向门被绕过）
    expect(() => scanUnregisteredKnowledgeAssets(root, [])).toThrowError(/指向目录的 symlink/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')('R71-39: symlink→文件 按普通资产参与反向扫描（未登记即 unmatched）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r71-ck-file-'))
  try {
    const knowledgeRoot = join(root, '知识层')
    const outside = join(root, '外部文件.md')
    mkdirSync(knowledgeRoot, { recursive: true })
    writeFileSync(outside, '未登记内容', 'utf8')
    symlinkSync(outside, join(knowledgeRoot, '文件链接.md'))

    const unmatched = scanUnregisteredKnowledgeAssets(root, [])
    expect(unmatched).toContain('知识层/文件链接.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
