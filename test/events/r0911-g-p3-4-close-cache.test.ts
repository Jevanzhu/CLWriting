/**
 * R0911-G-P3-4（2026-09-11 全量重评 GLM-5.3 修复批）：events 侧同根因的结构契约。
 * 根因与 RAG 侧同（见 test/rag/r0911-g-p3-4-close-cache.test.ts 头注）：node:sqlite
 * StatementSync 强引用 DatabaseSync，与 R46-42 preparedByDb 弱键构成 ephemeron 环，
 * close 后不随 GC 消失。事件库是每会话一开的长连接（引用计数制），泄漏量级远小于
 * RAG，故本文件只钉结构契约（close 一律走 closeEventsDb），功能面由 RAG 侧 gc 门控
 * 测试 + soak 兜底（机制同一处）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const storeSrc = readFileSync(join(import.meta.dirname, '../../src/events/store.ts'), 'utf8')

describe('R0911-G-P3-4: events prepared 缓存滞留——结构契约', () => {
  it('closeEventsDb 本体：先 preparedByDb.delete 再 db.close（断链序不得倒置）', () => {
    const m = /function closeEventsDb\(db: DatabaseSync\): void \{\s*preparedByDb\.delete\(db\)\s*db\.close\(\)\s*\}/.exec(storeSrc)
    expect(m, 'closeEventsDb 必须先摘缓存再关库').not.toBeNull()
  })

  it('events/store.ts 事件库句柄不得裸 db.close()（注释提及不算；checkpoint 连接 cp 不入缓存不查）', () => {
    const bare: number[] = []
    for (const m of storeSrc.matchAll(/\bdb\.close\(\)/g)) {
      const lineNo = storeSrc.slice(0, m.index).split('\n').length
      // R38-15 等注释里对 close 时序的文字描述不算裸调用点位
      const lineText = storeSrc.split('\n')[lineNo - 1]?.trim() ?? ''
      if (lineText.startsWith('//') || lineText.startsWith('*') || lineText.startsWith('/*')) continue
      bare.push(lineNo)
    }
    const helperBody = /function closeEventsDb[\s\S]*?\n\}/.exec(storeSrc)
    const helperStart = helperBody ? storeSrc.slice(0, helperBody.index).split('\n').length : -1
    const helperEnd = helperStart + (helperBody ? helperBody[0]!.split('\n').length : 0)
    const outside = bare.filter((ln) => ln < helperStart || ln > helperEnd)
    expect(outside, `helper 外裸 close 点位行号：${outside.join(', ')}`).toHaveLength(0)
  })
})
