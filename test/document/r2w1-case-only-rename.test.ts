/**
 * R2W-1（win 平台专项复审 R2）：纯大小写文档改名——大小写不敏感 FS（win NTFS/mac
 * APFS）上「目标与源是同一物理文件」不再误判 ALREADY_EXISTS（对齐书级 R71-8 口径）。
 * win 上修复前 existsSync(newSafe) 恒真 → 恒 409；posix 上走常规落位路径（回归保护）。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { legacyId } from '../../src/document/stable-id.js'

function makeSvc(): { root: string; svc: DocumentService } {
  const root = mkdtempSync(join(tmpdir(), 'clw-r2w1-case-'))
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

describe('纯大小写文档改名（R2W-1）', () => {
  it('0001-Dragon.md → 0001-dragon.md：ok、盘上单文件、正文保持、清单跟随', async () => {
    const { root, svc } = makeSvc()
    try {
      const dir = join(root, '写作', '正文')
      mkdirSync(dir, { recursive: true })
      const oldName = '0001-Dragon.md'
      writeFileSync(join(dir, oldName), '---\n标题: Dragon\n---\n正文内容', 'utf-8')
      const docId = legacyId(`写作/正文/${oldName}`)

      const r = await svc.renameDocument({ docId, newName: '0001-dragon.md' })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.path).toBe('写作/正文/0001-dragon.md')

      // 盘上单文件（win 上两个词法名指向同一物理文件；修复前此处 409 且旧名保持）
      const files = readdirSync(dir)
      expect(files).toEqual(['0001-dragon.md'])
      expect(readFileSync(join(dir, '0001-dragon.md'), 'utf-8')).toContain('正文内容')
      // 清单 path 跟随大小写更新
      const manifest = readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')
      expect(manifest).toContain('0001-dragon.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('目标位存在语义不同的他文件 → 仍 ALREADY_EXISTS（不误吞）', async () => {
    const { root, svc } = makeSvc()
    try {
      const dir = join(root, '写作', '正文')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '0001-a.md'), '源', 'utf-8')
      writeFileSync(join(dir, '0001-b.md'), '别章', 'utf-8')
      const r = await svc.renameDocument({ docId: legacyId('写作/正文/0001-a.md'), newName: '0001-b.md' })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('ALREADY_EXISTS')
      expect(readFileSync(join(dir, '0001-b.md'), 'utf-8')).toBe('别章')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
