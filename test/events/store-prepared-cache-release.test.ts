/**
 * events 侧 prepared 语句缓存滞留的同根因防线（结构契约）。
 *
 * 根因与 RAG 侧同（见 test/rag/rag-prepared-cache-release.test.ts 头注）：node:sqlite
 * StatementSync 强引用 DatabaseSync，与 R46-42 preparedByDb 弱键构成 ephemeron 环，close
 * 后不随 GC 消失（每次开/关滞留 ~0.35KB）。断链序本体已收编 shared/sqlite-prepared.ts
 * 单源，事件库是每会话一开的长连接（引用计数制），泄漏量级远小于 RAG。
 *
 * 为何保留为源码级断言：泄漏面在无 --expose-gc 的 CI 里不可观测（功能实测在 RAG 侧
 * gc 门控用例 + soak 兜底，机制同一处），事件域可钉的只剩两条架构不变量——
 * ① 单源本体的断链序不得倒置；② 事件库句柄的 close 一律经 closeEventsDb 委托单源
 * （裸 db.close() 断不开环，是该 bug 的唯一复发路径）。两条都无外部行为面可观测。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const srcRoot = join(import.meta.dirname, '../../src')
const sharedSrc = readFileSync(join(srcRoot, 'shared', 'sqlite-prepared.ts'), 'utf8')
const storeSrc = readFileSync(join(srcRoot, 'events', 'store.ts'), 'utf8')

/** 逐行剥注释后的代码文本（注释里对 close 时序的描述不算调用点）。 */
function stripComments(src: string): string {
  return src
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join(String.fromCharCode(10))
}

describe('R0911-G-P3-4: events prepared 缓存滞留——结构契约', () => {
  it('单源本体：先 preparedByDb.delete 再 db.close（断链序不得倒置）', () => {
    // 断言「delete 在 close 之前」，不锚空白形态（重排缩进/换行不应变红）
    const body = /export function closeWithPrepared\(db: DatabaseSync\): void \{([\s\S]*?)\n\}/.exec(sharedSrc)?.[1]
    expect(body, 'closeWithPrepared 本体须在位').toBeTruthy()
    const delAt = body!.indexOf('preparedByDb.delete(db)')
    const closeAt = body!.indexOf('db.close()')
    expect(delAt, 'closeWithPrepared 必须先摘缓存（preparedByDb.delete）').toBeGreaterThanOrEqual(0)
    expect(closeAt, 'closeWithPrepared 必须关库（db.close）').toBeGreaterThan(delAt)
  })

  it('events 域不裸关且委托单源：store.ts 零裸 db.close() + closeEventsDb 走 closeWithPrepared', () => {
    // 裸关（含 helper 体内）即断链序流通路：ephemeron 环断不开，滞留复发
    const bare = [...stripComments(storeSrc).matchAll(/\bdb\.close\(\)/g)]
    expect(bare, `裸 close 点位：${bare.map((m) => storeSrc.slice(0, m.index).split(String.fromCharCode(10)).length).join(', ')}`).toHaveLength(0)
    expect(stripComments(storeSrc)).toContain('closeWithPrepared(db)')
  })
})
