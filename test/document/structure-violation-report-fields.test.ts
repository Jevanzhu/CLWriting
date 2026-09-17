/**
 * 0918独立重评修复批（B007）回归：StructureViolation.targetDocId 死字段删除。
 *
 * targetDocId 原恒 null（盘面扫描拿不到清单 id，:55 注释宣称的「清单 id 回落」从未
 * 布线），health 消费侧 `v.targetDocId ? [v.targetDocId] : [v.targetPath]` 的真臂
 * 永不可达（死臂）。修复 = 删字段 + health 报文回归 targetPath 分支。
 * 本件钉死：违规条目无 targetDocId 字段（运行时形态）+ healthCheck structurePending
 * 报文 files 恒 [targetPath]。既有结构违规用例（structure-crash.test.ts）全绿为并
 * 行验收门。锚：0918独立重评修复批 B007。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectStructureViolations } from '../../src/document/structure.js'
import { healthCheck } from '../../src/state/health.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let bookRoot = ''

afterEach(() => {
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
  bookRoot = ''
})

/** 最小违规盘面：目标章 fm 并入 已登记、源章仍存活正文（合并①后崩溃形态）。 */
function scaffoldViolationBook(): { targetRel: string; sourceRel: string } {
  bookRoot = mkdtempTracked(join(tmpdir(), 'clw-struct-violation-'))
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  const targetRel = '写作/正文/0001-目标.md'
  const sourceRel = '写作/正文/0002-源章.md'
  writeFileSync(join(bookRoot, targetRel), '---\n章号: 1\n标题: 目标\n并入: [2]\n---\n\n目标正文\n', 'utf8')
  writeFileSync(join(bookRoot, sourceRel), '---\n章号: 2\n标题: 源章\n---\n\n源章正文\n', 'utf8')
  return { targetRel, sourceRel }
}

describe('0918独立重评修复批 B007: StructureViolation 死字段删除', () => {
  it('detectStructureViolations 条目无 targetDocId 字段，定位字段齐备', () => {
    const { targetRel } = scaffoldViolationBook()
    const violations = detectStructureViolations(bookRoot)
    expect(violations).toHaveLength(1)
    const v = violations[0]!
    expect('targetDocId' in v).toBe(false)
    expect(v.targetPath).toBe(targetRel)
    expect(v.targetChapterNo).toBe(1)
    expect(v.targetTitle).toBe('目标')
    expect(v.sourceChapterNo).toBe(2)
  })

  it('healthCheck structurePending 报文 files 回归 targetPath 分支（恒 [targetPath]）', async () => {
    const { targetRel } = scaffoldViolationBook()
    const issues = await healthCheck(bookRoot, { version: 1, entries: new Map() })
    const pending = issues.filter((i) => i.kind === 'structurePending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.files).toEqual([targetRel])
    expect(pending[0]!.humanMsg).toContain('第1章')
    expect(pending[0]!.humanMsg).toContain('第 2 章')
  })
})
