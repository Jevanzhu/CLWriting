/**
 * R2W-8（win 平台专项复审 R2）：.md 过滤大小写不敏感（R34D-11 家族补齐）。
 *
 * style-entry readEntries：'样例.MD'（资源管理器改名形态）此前被大小写敏感过滤
 * 静默跳过（不进注入/禁词）——以「errors 中出现该文件」证明扫描器已看到它
 * （占位内容必然产出解析错误；修复前该文件连 errors 都不进）。
 * prepare 侧 findChapterByNumber 为模块私有，同一行口径与 walk-md（已有回归）一致，
 * 由存量 prepare 套件回归保护。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEntries } from '../../src/format/style-entry.js'

describe('.md 过滤大小写不敏感（R2W-8）', () => {
  it('.MD 文件进入 readEntries 扫描面（errors 可见即证明被扫到）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clw-r2w8-mdcase-'))
    try {
      const kindDir = join(dir, '样章')
      mkdirSync(kindDir, { recursive: true })
      writeFileSync(join(kindDir, '样例.MD'), '---\n无效段: x\n---\n占位', 'utf-8')

      const { errors } = readEntries(dir, '样章')
      // 占位内容不是合法条目 → 必有解析错误；错误里含该文件名 = 扫描器未漏掉 .MD
      expect(errors.some((e) => e.file.includes('样例.MD') || e.file.includes('样例.md'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
