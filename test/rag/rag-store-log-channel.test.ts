/**
 * R66-10（十四轮）回归：RAG 迁移侧车告警走 log 通道而非 console。
 * Electron 生产环境 console.* 不被采集——迁移丢失线索（R65-4 场景：主库已迁、
 * -wal 侧车 rename 失败滞留旧处）必须落文件日志才能被作者/支持侧看到。
 *
 * 注：侧车在位由 existsSync 注入（真实 sqlite 打开主库时会清理失配的遗留 -wal，
 * 物理伪造无法存活到 rename 步）；本用例主张的是告警通道，非 fs 语义。
 */
import { describe, it, expect, vi } from 'vitest'

const state = vi.hoisted(() => ({ failOn: '', calls: [] as string[] }))
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return {
    ...orig,
    existsSync: (p: string) => (state.failOn !== '' && p.includes(state.failOn) ? true : orig.existsSync(p)),
    renameSync: (from: string, to: string) => {
      state.calls.push(from)
      if (state.failOn !== '' && from.includes(state.failOn)) throw new Error('EACCES: 杀软占用（mock）')
      return orig.renameSync(from, to)
    },
  }
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveRagDbPath } from '../../src/rag/store.js'
import { log, resetLoggingForTest } from '../../src/log/index.js'

describe('R66-10: 迁移侧车告警走 log 通道', () => {
  it("侧车 rename 失败 → log.warn('rag') 落痕（修复前 console.warn 不被 Electron 采集）", () => {
    resetLoggingForTest()
    const warn = vi.spyOn(log, 'warn')
    const dir = mkdtempSync(join(tmpdir(), 'clw-rag-log-'))
    try {
      // 主库为非 sqlite 字节：checkpoint 打不开（回落纯 rename 迁移）——R65-4 记档的
      // 「checkpoint 失败 + rename 失败」双降级场景
      const legacy = join(dir, '.rag.db')
      writeFileSync(legacy, 'legacy-main-bytes')
      state.failOn = '-wal'
      const resolved = resolveRagDbPath(dir)
      // 主库迁移照常成功（新路径），侧车 rename 被真实尝试且失败
      expect(resolved).toBe(join(dir, '.cache', 'rag.db'))
      expect(state.calls.some((c) => c.includes('-wal'))).toBe(true)
      // 告警经 log 通道：tag=rag + 含丢失语义
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toBe('rag')
      expect(String(warn.mock.calls[0]![1])).toContain('迁移侧车失败')
    } finally {
      state.failOn = ''
      state.calls.length = 0
      warn.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
