/**
 * R0911-G-P3-4（2026-09-11 全量重评 GLM-5.3 修复批）：prepared 语句缓存滞留回归。
 * 根因（裸 .mjs 40k 次开/关 bisect 定位）：node:sqlite StatementSync 强引用
 * DatabaseSync，与 R46-45 preparedByDb（WeakMap<db, Map<sql, stmt>>）弱键构成
 * ephemeron 环——close 后条目不随 GC 消失，每次开/关滞留 ~0.35KB（语句是否执行过
 * 无关，入缓存即滞留；WAL/busy_timeout/table_info/部分索引均经 bisect 排除）。
 * RAG 召回每次开库两回，长会话线性堆积（soak 实测 60k 召回 +52MB）。修复 =
 * closeRagDb（先 preparedByDb.delete 再 close）断链，30k 次开/关实测归零。
 *
 * 两层守护：
 * 1. 结构契约（CI 常跑）：RAG 库句柄的 close 全走 closeRagDb，不得裸 db.close()——
 *    防后续改动绕开 helper 把滞留 reintroduce（功能层泄漏在无 --expose-gc 的 CI 里
 *    测不出，结构层是 CI 唯一门）。
 * 2. 功能实测（gc 门控）：openRagDb/closeRagDb 高频开/关下堆增长有界——需
 *    --expose-gc（NODE_OPTIONS=--expose-gc），普通 CI 跳过；本地与 soak（tag CI）
 *    兜底功能面。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openRagDb, closeRagDb } from '../../src/rag/store.js'

const here = join(import.meta.dirname, '../../src')

describe('R0911-G-P3-4: RAG prepared 缓存滞留——结构契约', () => {
  it('closeRagDb 本体：先 preparedByDb.delete 再 db.close（断链序不得倒置）', () => {
    const src = readFileSync(join(here, 'rag/store.ts'), 'utf8')
    const m = /export function closeRagDb\(db: DatabaseSync\): void \{\s*preparedByDb\.delete\(db\)\s*db\.close\(\)\s*\}/.exec(src)
    expect(m, 'closeRagDb 必须先摘缓存再关库').not.toBeNull()
  })

  it('rag/index.ts 不得出现裸 db.close()（RAG 句柄 close 一律 closeRagDb）', () => {
    const src = readFileSync(join(here, 'rag/index.ts'), 'utf8')
    const bare = [...src.matchAll(/\bdb2?\.close\(\)/g)]
    expect(bare, `裸 close 点位：${bare.map((m) => src.slice(0, m.index).split('\n').length).join(', ')}`).toHaveLength(0)
  })

  it('studio/server/api/rag.ts 不得出现裸 db.close()（状态端点轮询路径）', () => {
    const src = readFileSync(join(here, 'studio/server/api/rag.ts'), 'utf8')
    expect(src).not.toMatch(/\bdb\.close\(\)/)
  })
})

describe('R0911-G-P3-4: openRagDb/closeRagDb 高频开/关不滞留（功能实测）', () => {
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
      try {
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
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
