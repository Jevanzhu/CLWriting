/**
 * R27-131（二十七轮 I 域）回归：knowledge:update 空汇总不再落草稿。
 *
 * 根因：scripts/knowledge-update.ts 原实现无条件 writeFalsePositiveDraft 之后才判
 * summaries 为空打印「未产草稿」——只有说明行的占位草稿照落盘，对外口径与实际产物
 * 不一致（占位文件还落在 check:knowledge 反向扫描的「草稿」豁免面里）。
 * 语义：汇总为空 → 不落任何文件（连 知识层/ 目录都不建），draftRel=null；
 * 非空 → 行为不变。测法：直测脚本导出的 runKnowledgeUpdate（主体已收进可注入
 * 纯编排函数 + 直跑守卫，import 无副作用），空/非空语料两态对照。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runKnowledgeUpdate } from '../../scripts/knowledge-update.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造语料夹具：withSilent=false 时全 fire（汇总为空）。知识层目录不预建——锁「零落盘」。 */
function fixture(withSilent: boolean): { root: string; corpusDir: string } {
  const root = mkdtempTracked(join(tmpdir(), 'r27-know-update-'))
  const corpusDir = join(root, 'corpus')
  mkdirSync(corpusDir, { recursive: true })
  writeFileSync(
    join(corpusDir, 'c1.json'),
    JSON.stringify(withSilent ? [{ excerpt: '样例', expect: 'silent' }] : [{ excerpt: '样例', expect: 'fire' }]),
    'utf8',
  )
  return { root, corpusDir }
}

describe('R27-131：knowledge:update 空汇总不再落草稿', () => {
  it('汇总为空 → draftRel=null，不落占位文件（连 知识层/ 目录都不建），「未产草稿」口径与磁盘一致', () => {
    const { root, corpusDir } = fixture(false)
    const r = runKnowledgeUpdate(root, corpusDir, '2026-08-30')
    expect(r.summaries).toEqual([])
    expect(r.draftRel).toBeNull()
    // 修复前：writeFalsePositiveDraft 先落占位草稿（还顺带建了 知识层/ 目录）
    expect(existsSync(join(root, '知识层', '机检误报-草稿-2026-08-30.md'))).toBe(false)
    expect(existsSync(join(root, '知识层'))).toBe(false)
  })

  it('汇总非空 → 行为不变：草稿照常落盘、相对路径照常返回', () => {
    const { root, corpusDir } = fixture(true)
    const r = runKnowledgeUpdate(root, corpusDir, '2026-08-30')
    expect(r.summaries).toHaveLength(1)
    expect(r.draftRel).toBe('知识层/机检误报-草稿-2026-08-30.md')
    expect(existsSync(join(root, r.draftRel!))).toBe(true)
  })
})
