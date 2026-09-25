/**
 * R0916-7-P3-26（0916-7 批）回归：书级 URL 单源（api/url.ts 的 bookUrl）与迁移面锚。
 *
 * ① bookUrl 逐形态产出的路径与收编前的模板逐字一致——表驱动钉住编码口径：
 *    书名/段各自 encodeURIComponent（书名里的 `/`、空格、`+&?#` 一律编掉）、
 *    无段 = 书根端点、查询串不进 bookUrl（由调用方在外拼接）。
 *    期望值是收编前模板产出的字面串（非现算），改动编码口径即红。
 *
 * ② 迁移面锚：api/ 层与 useHeartbeat/useSse 不得再出现 `/api/books/${` 手拼模板
 *    （收编前 78 + 5 处）——新端点若绕开 bookUrl 手拼，此处即红。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bookUrl } from '../../../src/studio/web-next/src/api/url'

const API_DIR = 'src/studio/web-next/src/api'

/** 表驱动：书名 + 段 → 收编前模板产出的字面路径 */
const CASES: Array<[string, string[], string]> = [
  ['书A', [], '/api/books/%E4%B9%A6A'],
  ['书A', ['tree'], '/api/books/%E4%B9%A6A/tree'],
  ['书A', ['rag', 'status'], '/api/books/%E4%B9%A6A/rag/status'],
  ['书A', ['documents', 'batch-finalize'], '/api/books/%E4%B9%A6A/documents/batch-finalize'],
  ['书C', ['trash', 'id-1', 'restore'], '/api/books/%E4%B9%A6C/trash/id-1/restore'],
  // 需编码字符：空格 / 斜杠 / `+&?#`——书名与段各自整值编码（斜杠不当作路径分隔）
  ['我的 书/名', ['documents', 'd/1', 'content'], '/api/books/%E6%88%91%E7%9A%84%20%E4%B9%A6%2F%E5%90%8D/documents/d%2F1/content'],
  ['书+&?#', ['file'], '/api/books/%E4%B9%A6%2B%26%3F%23/file'],
  // 空书名照旧编码为空段（不特殊处理——调用方不该传空，口径如实钉住）
  ['', ['trash'], '/api/books//trash'],
]

describe('R0916-7-P3-26: bookUrl 书级 URL 单源', () => {
  it.each(CASES)('书名 %j + 段 %j → %s', (name, segments, expected) => {
    expect(bookUrl(name, ...segments)).toBe(expected)
  })

  it('查询串不进 bookUrl：与手拼查询组合后仍是收编前的字面串', () => {
    const url = `${bookUrl('书A', 'file')}?file=${encodeURIComponent('正文/第1章.md')}`
    expect(url).toBe('/api/books/%E4%B9%A6A/file?file=%E6%AD%A3%E6%96%87%2F%E7%AC%AC1%E7%AB%A0.md')
  })

  it('迁移面：api/ 与 useHeartbeat/useSse 零 `/api/books/${` 手拼（78 + 5 处已收编）', () => {
    const files = readdirSync(API_DIR)
      .filter((f) => f.endsWith('.ts') && f !== 'url.ts') // url.ts = 单源本体，模板在它这里
      .map((f) => join(API_DIR, f))
      .concat([
        'src/studio/web-next/src/composables/useHeartbeat.ts',
        'src/studio/web-next/src/composables/useSse.ts',
      ])
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // 书级 URL 只能出自 bookUrl；剩下的书级模板 = 绕开单源的漏网点
      if (src.includes('/api/books/${')) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  it('迁移面：两个 api 层外的调用方（心跳 / SSE）取 bookUrl', () => {
    for (const f of [
      'src/studio/web-next/src/composables/useHeartbeat.ts',
      'src/studio/web-next/src/composables/useSse.ts',
    ]) {
      expect(readFileSync(f, 'utf8')).toContain("import { bookUrl } from '../api/url'")
    }
  })
})
