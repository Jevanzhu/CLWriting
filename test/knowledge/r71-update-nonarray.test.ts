/**
 * R71-35（十九轮）回归：summarizeFalsePositives 对「parse 成功但非数组」的语料
 * 文件（手编辑成 `{}` 等）不炸整轮——对齐坏 JSON 跳过口径 continue；缺 excerpt
 * 的 silent 条目被滤（不再渲染成「> undefined」）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeFalsePositives } from '../../src/knowledge/update.js'

describe('R71-35: 语料回归域非数组/缺 excerpt 防御', () => {
  it('parse 成功但非数组（{}）→ 跳过不崩；其余文件正常汇总', () => {
    const root = mkdtempSync(join(tmpdir(), 'r71-knowledge-'))
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
    const root = mkdtempSync(join(tmpdir(), 'r71-knowledge-'))
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
})
