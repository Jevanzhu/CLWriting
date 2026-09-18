/**
 * 四轮-D404（2026-09-18 全量源码独立重评四轮修复批）回归：
 * 定稿标题回退（fm 无 标题 → basenameNoExt）剥扩展名正则 /\.md$/ 缺 i 标志——
 * 全库 isMdFileName 均大小写不敏感（version.ts R42-39 先例），win 资源管理器把
 * `.md` 改成 `.MD` 后回退标题带尾巴（`0001-第一章.MD`）。
 * 修复：加 i 标志。断言：`.MD` 章定稿后版本档案 reason 的回退标题不带扩展名
 * （版本 fm 无路径字段，可全档断言不含 `.MD`）。
 */
import { test, expect } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { finalizeRevision } from '../../src/document/finalize.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { scaffoldBook } from '../helpers/book.js'

test('四轮-D404: `.MD` 扩展名回退标题不带尾巴（fm 无 标题 → basenameNoExt）', () => {
  const { root } = scaffoldBook({
    prefix: 'd404-finalize-',
    flatRoot: true,
    files: [
      // fm 无 标题 键 → 定稿标题走 basenameNoExt(relPath) 回退
      { rel: '写作/正文/0001-第一章.MD', content: '---\n章号: 1\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文而已。\n' },
    ],
  })
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  const docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '写作/正文/0001-第一章.MD', parentId: null })
  writeManifest(manifestPath, m)
  try {
    const r = finalizeRevision(root, docId)
    expect(r.ok).toBe(true)
    const versionsDir = join(root, '工作区', '.版本', docId)
    const files = readdirSync(versionsDir).filter((n) => n.endsWith('.md'))
    expect(files).toHaveLength(1)
    const content = readFileSync(join(versionsDir, files[0]!), 'utf-8')
    // 回退标题 = `0001-第一章`（`.MD` 尾巴已剥）
    expect(content).toContain('定稿 ch:0001 0001-第一章')
    expect(content).not.toContain('.MD')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
