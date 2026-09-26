/**
 * 语料回归域汇总的坏形状防御：summarizeFalsePositives 对手编辑坏档不炸整轮。
 *
 * 档源：原 r71-update-nonarray.test.ts（R71-35）与
 * （原 r0912-2-manifest-field-guard）的 P3 组同属「语料 JSON 坏形状跳过」一族，
 * 按被测行为合并；断言逐条保留、去重 0 条（非数组 / 坏项 / 缺 excerpt 三档互不重叠）。
 *
 * - R71-35（十九轮）：parse 成功但非数组的语料文件（手编辑成 `{}` 等）不炸整轮——
 *   对齐坏 JSON 跳过口径 continue；缺 excerpt 的 silent 条目被滤（不再渲染成
 *   「> undefined」）。
 * - 重评-0912-2 P3：corpus JSON 数组含 null/非对象项 → e.expect TypeError 崩整轮
 *   汇总（R71-35 只修了非数组形态）。修后：坏项跳过 + warn 留痕，不崩整轮。
 */
import { describe, it, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeFalsePositives } from '../../src/knowledge/update.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

describe('语料回归域坏形状防御', () => {
  it('parse 成功但非数组（{}）→ 跳过不崩；其余文件正常汇总', () => {
    const root = mkdtempTracked(join(tmpdir(), 'knowledge-corpus-shape-'))
    const corpusDir = join(root, 'corpus')
    try {
      mkdirSync(corpusDir, { recursive: true })
      // 修复前：JSON.parse 成功 → entries.filter TypeError 崩整轮
      writeFileSync(join(corpusDir, 'hand-edited.json'), JSON.stringify({ note: '手编辑成对象' }), 'utf8')
      writeFileSync(
        join(corpusDir, 'body-parts.json'),
        JSON.stringify([{ excerpt: '山门外落了整夜的风雪。', expect: 'silent' }]),
        'utf8',
      )
      const s = summarizeFalsePositives(corpusDir)
      expect(s).toHaveLength(1)
      expect(s[0]!.checkId).toBe('body-parts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺 excerpt 的 silent 条目被滤——excerpts 不含 undefined', () => {
    const root = mkdtempTracked(join(tmpdir(), 'knowledge-corpus-shape-'))
    const corpusDir = join(root, 'corpus')
    try {
      mkdirSync(corpusDir, { recursive: true })
      writeFileSync(
        join(corpusDir, 'no-excerpt.json'),
        JSON.stringify([
          { expect: 'silent' }, // 缺 excerpt
          { excerpt: '钟声一声比一声沉。', expect: 'silent' },
        ]),
        'utf8',
      )
      const s = summarizeFalsePositives(corpusDir)
      expect(s).toHaveLength(1)
      expect(s[0]!.silent).toBe(2)
      // 修复前：[undefined, '钟声…']——草稿渲染成「> undefined」
      expect(s[0]!.excerpts).toEqual(['钟声一声比一声沉。'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('corpus JSON 数组含 null/非对象项 → 跳过 + warn，其余条目正常汇总', () => {
    const root = mkdtempTracked(join(tmpdir(), 'knowledge-corpus-shape-'))
    const corpusDir = join(root, 'corpus')
    mkdirSync(corpusDir, { recursive: true })
    // 修复前：e.expect 在 null 项上 TypeError 崩整轮汇总
    writeFileSync(
      join(corpusDir, 'bad-items.json'),
      JSON.stringify([null, { excerpt: '山门外落了整夜的风雪。', expect: 'silent' }, 42, { excerpt: '排比。', expect: 'fire' }]),
      'utf8',
    )
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const s = summarizeFalsePositives(corpusDir)
      expect(s).toHaveLength(1)
      expect(s[0]!.checkId).toBe('bad-items')
      expect(s[0]!.silent).toBe(1)
      expect(s[0]!.fire).toBe(1) // 坏项不计入 fire
      expect(s[0]!.excerpts).toEqual(['山门外落了整夜的风雪。'])
      expect(warnSpy.mock.calls.some((c) => String(c[1]).includes('坏形状'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
