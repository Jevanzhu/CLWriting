/**
 * R51-E-N4（五十一轮）回归：dirFp 只计 .md——非 .md 文件不再计入纪元指纹。
 *
 * 修复前：目录混入临时文件（编辑器 swap/同步盘半写残留/手放笔记）即纪元指纹变化 →
 * 整表清空，增量缓存永久失效（且每轮重扫全树）。修复后：指纹只随 .md 变化——机检
 * 对这些目录（布线/章纲/文风/暂存归档/写作·正文）的消费面本就只吃 .md。
 * 手法：test/check/r47-tree-issues-epoch.test.ts 既有「临时书 + compute 全局指纹
 * 比对」形态（dirFp 为模块私有，经导出的 compute*Fp 间接驱动）。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { computeTreeIssuesGlobalFp, computeLeadsBookFp } from '../../src/check/tree-issues-cache.js'

describe('R51-E-N4：dirFp 只计 .md（临时文件不炸纪元）', () => {
  it('文风/ 混入非 .md 临时文件 → 纪元指纹不变；.md 变更仍失效（含 .MD 大写）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'r51en4-wf-'))
    mkdirSync(join(root, '文风'), { recursive: true })
    writeFileSync(join(root, '文风', '文风铁律.md'), '# 铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
    const base = computeTreeIssuesGlobalFp(root, null)

    // 临时文件（编辑器 swap / 同步盘残留两种扩展形态）混入：修复前指纹必变（红形态）
    writeFileSync(join(root, '文风', '文风铁律.md.swp'), 'vim swap', 'utf-8')
    writeFileSync(join(root, '文风', '.~lock.铁律.ods'), 'lockfile', 'utf-8')
    writeFileSync(join(root, '文风', '随手记.txt'), '不是机检输入', 'utf-8')
    expect(computeTreeIssuesGlobalFp(root, null)).toBe(base)

    // .md 仍是机检输入：内容变更必须失效（防「收窄误伤」反向回归）
    appendFileSync(join(root, '文风', '文风铁律.md'), '- 长枪\n', 'utf-8')
    expect(computeTreeIssuesGlobalFp(root, null)).not.toBe(base)
    // R38-9：.MD 大写扩展名同属 .md 家族，不得因只计 .md 而漏
    writeFileSync(join(root, '文风', '样章.MD'), '# 样章\n', 'utf-8')
    const afterMd = computeTreeIssuesGlobalFp(root, null)
    expect(afterMd).not.toBe(base)
    writeFileSync(join(root, '文风', '样章2.MD'), '# 样章二\n', 'utf-8')
    expect(computeTreeIssuesGlobalFp(root, null)).not.toBe(afterMd)
  })

  it('computeLeadsBookFp（写作·正文 目录指纹）同口径：临时文件不失效，.md 变更失效', () => {
    const root = mkdtempTracked(join(tmpdir(), 'r51en4-body-'))
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(
      join(root, '写作', '正文', '0001-第一章.md'),
      '---\n章号: 1\n标题: 第一章\n---\n\n雪落在了城墙上。\n',
      'utf-8',
    )
    const base = computeLeadsBookFp(root, null)
    writeFileSync(join(root, '写作', '正文', '.0001-第一章.md.tmp'), '半写残留', 'utf-8')
    expect(computeLeadsBookFp(root, null)).toBe(base)
    appendFileSync(join(root, '写作', '正文', '0001-第一章.md'), '雪压断了枝。\n', 'utf-8')
    expect(computeLeadsBookFp(root, null)).not.toBe(base)
  })
})
