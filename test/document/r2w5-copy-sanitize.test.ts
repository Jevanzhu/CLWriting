/**
 * R2W-5（win 平台专项复审 R2）：doCopy 目录段净化——不存在的目录段过
 * sanitizeFileNamePart（R33-9 move 侧同款口径），「设定/CON./笔记.md」形目标不再
 * mkdir EINVAL 裸 500；既有目录段身份不动。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { legacyId } from '../../src/document/stable-id.js'

describe('doCopy 目录段净化（R2W-5）', () => {
  it('保留设备名目录段（CON.）→ 净化为 _CON 落位，不裸 500', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clw-r2w5-copy-'))
    try {
      const bodyDir = join(root, '写作', '正文')
      mkdirSync(bodyDir, { recursive: true })
      writeFileSync(join(bodyDir, '0001-a.md'), '---\n标题: a\n---\n正文', 'utf-8')
      const svc = new DocumentService({ bookRoot: root })

      const r = await svc.copyDocument({ docId: legacyId('写作/正文/0001-a.md'), relPath: '设定/CON./笔记.md' })
      expect(r.ok).toBe(true)
      // 落位在净化后的目录段下（sanitizeFileNamePart：尾点剥离 + 保留名避让）
      const settingDir = join(root, '设定')
      expect(existsSync(settingDir)).toBe(true)
      expect(readdirSync(settingDir)).toContain('_CON')
      expect(existsSync(join(root, '设定', '_CON', '笔记.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('既有目录段身份不动（净化不重写已存在的合法段）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clw-r2w5-copy2-'))
    try {
      const bodyDir = join(root, '写作', '正文')
      mkdirSync(bodyDir, { recursive: true })
      writeFileSync(join(bodyDir, '0001-a.md'), '---\n标题: a\n---\n正文', 'utf-8')
      const svc = new DocumentService({ bookRoot: root })

      const r = await svc.copyDocument({ docId: legacyId('写作/正文/0001-a.md'), relPath: '设定/角色/笔记.md' })
      expect(r.ok).toBe(true)
      expect(existsSync(join(root, '设定', '角色', '笔记.md'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
