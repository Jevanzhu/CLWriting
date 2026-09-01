/**
 * R36-10（三十六轮批 D）：工作区/导出/ 收编进 isInternalBookPath 内部簿记前缀回归。
 *
 * 机理：导出产物目录（src/export/index.ts 落 工作区/导出/）此前不在内部簿记前缀清单，
 * 文档 CRUD 可按路径直达写/删导出产物目录（产物可再生、危害低，但属内部簿记——导出
 * 专用通道维护）。修复后对导出路径返回 true（内部 = 拒绝外部 CRUD 直达）。
 */
import { describe, it, expect } from 'vitest'
import { isInternalBookPath, layoutOf, capabilitiesOf } from '../../src/document/layout.js'

describe('R36-10 导出目录收编进内部簿记', () => {
  it('工作区/导出/ 下任意路径 → isInternalBookPath true（含前导 ./ 与反斜杠形态）', () => {
    for (const p of [
      '工作区/导出/全书.txt',
      '工作区/导出/分卷/第一卷.md',
      '工作区/导出/合并.txt',
      './工作区/导出/提交稿.txt',
      '工作区\\导出\\分卷\\第2卷.md',
    ]) {
      expect(isInternalBookPath(p), p).toBe(true)
    }
  })

  it('能力面拒绝：导出路径 write/rename/move/copy/trash 全拒（与其它内部簿记同口径），read 不拒', () => {
    const c = capabilitiesOf('note', '工作区/导出/分卷/第一卷.md')
    expect(c.write).toBe(false)
    expect(c.rename).toBe(false)
    expect(c.move).toBe(false)
    expect(c.copy).toBe(false)
    expect(c.trash).toBe(false)
    expect(c.read).toBe(true)
    const lay = layoutOf('工作区/导出/成品.txt')
    expect(lay.capabilities.write).toBe(false)
    expect(lay.role).toBe('note') // role 不因收编改变（仍属工作区运行时资产）
  })

  it('前缀带斜杠：工作区/导出.md（同名前缀文件，非目录内）不误伤', () => {
    expect(isInternalBookPath('工作区/导出.md')).toBe(false)
  })

  it('既有内部簿记前缀不受影响（回归护栏）', () => {
    for (const p of ['工作区/.journal/doc.jsonl', '工作区/.版本/doc', '工作区/待定稿/doc.md']) {
      expect(isInternalBookPath(p), p).toBe(true)
    }
    expect(isInternalBookPath('写作/正文/0001-开篇.md')).toBe(false)
  })
})