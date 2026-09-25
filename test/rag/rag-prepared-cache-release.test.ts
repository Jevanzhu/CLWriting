/**
 * R0911-G-P3-4：prepared 语句缓存滞留回归（RAG 侧）。
 *
 * 根因（裸 .mjs 40k 次开/关 bisect 定位）：node:sqlite StatementSync 强引用 DatabaseSync，
 * 与 R46-45 preparedByDb（WeakMap<db, Map<sql, stmt>>）弱键构成 ephemeron 环——close 后
 * 条目不随 GC 消失，每次开/关滞留 ~0.35KB（语句是否执行过无关，入缓存即滞留）。
 * RAG 召回每次开库两回，长会话线性堆积（soak 实测 60k 召回 +52MB）。修复 = closeRagDb
 * （先 preparedByDb.delete 再 close）断链，30k 次开/关实测归零。
 *
 * 两层守护：
 * 1. 功能实测（gc 门控）：openRagDb/closeRagDb 高频开/关下堆增长有界——需 --expose-gc
 *    （NODE_OPTIONS=--expose-gc），普通 CI 跳过；本地与 soak（tag CI）兜底功能面。
 * 2. 结构契约（CI 常跑）：断链序单源本体不得倒置 + RAG 域句柄的 close 一律走 closeRagDb
 *    （裸 db.close() 断不开 ephemeron 环，是该 bug 的唯一复发路径；无 --expose-gc 时
 *    不可观测，结构层是 CI 唯一门。同族 events 侧见 test/events/store-prepared-cache-release.test.ts）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeRagDb, openRagDb } from '../../src/rag/store.js'

const srcRoot = join(import.meta.dirname, '../../src')
const NL = String.fromCharCode(10)

/** 逐行剥注释后的代码文本（注释里对 close 时序的描述不算调用点）。 */
function stripComments(src: string): string {
  return src
    .split(NL)
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join(NL)
}

describe('R0911-G-P3-4: RAG prepared 缓存滞留——结构契约', () => {
  it('单源本体：先 preparedByDb.delete 再 db.close（断链序不得倒置）', () => {
    const shared = readFileSync(join(srcRoot, 'shared', 'sqlite-prepared.ts'), 'utf8')
    // 断言「delete 在 close 之前」，不锚空白形态（重排缩进/换行不应变红）
    const body = /export function closeWithPrepared\(db: DatabaseSync\): void \{([\s\S]*?)\n\}/.exec(shared)?.[1]
    expect(body, 'closeWithPrepared 本体须在位').toBeTruthy()
    const delAt = body!.indexOf('preparedByDb.delete(db)')
    const closeAt = body!.indexOf('db.close()')
    expect(delAt, 'closeWithPrepared 必须先摘缓存（preparedByDb.delete）').toBeGreaterThanOrEqual(0)
    expect(closeAt, 'closeWithPrepared 必须关库（db.close）').toBeGreaterThan(delAt)
  })

  it('RAG 域不裸关且委托单源（表驱动覆盖各消费点）', () => {
    // 消费点表：RAG 库句柄的 close 一律 closeRagDb；裸 db.close()/db2.close() 即复发路径
    const sites = ['rag/store.ts', 'rag/index.ts', 'studio/server/api/rag.ts']
    const offenders: string[] = []
    for (const rel of sites) {
      const raw = readFileSync(join(srcRoot, rel), 'utf-8')
      for (const m of stripComments(raw).matchAll(/\bdb2?\.close\(\)/g)) {
        offenders.push(`${rel}:${raw.slice(0, m.index).split(NL).length}`)
      }
    }
    expect(offenders, `RAG 句柄须走 closeRagDb；裸 close 点位：${offenders.join(', ')}`).toEqual([])
    // 薄封装确实委托单源（防「只删调用」式假绿）
    expect(stripComments(readFileSync(join(srcRoot, 'rag', 'store.ts'), 'utf-8'))).toContain('closeWithPrepared(db)')
  })
})

describe('R0911-G-P3-4: openRagDb/closeRagDb 高频开/关不滞留（功能实测）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it.skipIf(typeof (globalThis as { gc?: unknown }).gc !== 'function')(
    'gc 门控：N 次开/关堆增长有界（修复前线性 ~0.35KB/次）',
    () => {
      const gc = (globalThis as unknown as { gc: () => void }).gc
      const settled = () => {
        let m = Infinity
        for (let i = 0; i < 5; i++) {
          gc()
          m = Math.min(m, process.memoryUsage().heapUsed)
        }
        return m
      }
      const dir = mkdtempSync(join(tmpdir(), 'r0911-g-p3-4-close-'))
      dirs.push(dir)
      mkdirSync(dir, { recursive: true })
      const N = 8_000
      for (let i = 0; i < 1_000; i++) {
        const db = openRagDb(dir)
        closeRagDb(db)
      }
      const before = settled()
      for (let i = 0; i < N; i++) {
        const db = openRagDb(dir)
        closeRagDb(db)
      }
      const after = settled()
      const growthMB = (after - before) / 1048576
      // 修复前实测 ≈ 2.7MB（0.35KB × 8000）；修复后 ≈ 0。1.5MB 界于两者之间，
      // 留足噪声余量同时必捕回归。
      expect(growthMB, `高频开/关后堆增长 ${growthMB.toFixed(2)}MB 超界（修复前形态 ~2.7MB）`).toBeLessThan(1.5)
    },
  )
})
