/**
 * R2W-2（win 平台专项复审 R2）：账本推进主文件带 BOM 时归档判定不失明。
 *
 * 记事本「UTF-8 with BOM」保存的 他章推进草稿（首行 \uFEFF# 第N章）此前 ^# 不中
 * → 误判「无标签旧格式」跳过归档 → 下次生成静默覆盖丢失。修复后：归档发生、
 * 主文件让位；同章标签仍不归档（覆盖语义保持）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archivePendingLeadUpdates } from '../../src/process/lead-update-draft.js'
import { LEAD_UPDATES_FILE, LEAD_UPDATES_ARCHIVE_DIR } from '../../src/check/lead-updates.js'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-r2w2-bom-'))
  mkdirSync(join(root, '工作区'), { recursive: true })
  return root
}

const BOM = '\uFEFF'

describe('账本推进归档 BOM 容忍（R2W-2）', () => {
  it('BOM + 他章标签 + 有条目 → 归档到 暂存/第3章.md（修复前静默跳过）', () => {
    const root = makeRoot()
    try {
      const main = join(root, LEAD_UPDATES_FILE)
      writeFileSync(main, `${BOM}# 第3章 账本推进\n\n- [ ] 甲：玉佩线索推进（未确认）\n`, 'utf-8')

      archivePendingLeadUpdates(root, 5) // 当前在写第 5 章 → 第 3 章草稿应归档

      expect(existsSync(main)).toBe(false)
      const archived = join(root, LEAD_UPDATES_ARCHIVE_DIR, '第3章.md')
      expect(existsSync(archived)).toBe(true)
      expect(readFileSync(archived, 'utf-8')).toContain('玉佩线索推进')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BOM + 同章标签 → 不归档（同章覆盖语义保持）', () => {
    const root = makeRoot()
    try {
      const main = join(root, LEAD_UPDATES_FILE)
      writeFileSync(main, `${BOM}# 第3章 账本推进\n\n- [ ] 甲：本章推进\n`, 'utf-8')

      archivePendingLeadUpdates(root, 3)

      expect(existsSync(main)).toBe(true)
      expect(existsSync(join(root, LEAD_UPDATES_ARCHIVE_DIR))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
