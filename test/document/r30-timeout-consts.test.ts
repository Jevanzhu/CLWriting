/**
 * R30-18（三十轮）回归：锁超时档常量收口——6 处 `export let` 改 `export const` +
 * `__setXxxTimeoutForTest` 注入函数（照抄 src/ai/calls.ts 的
 * `__setAiCallsLockTimeoutForTest` 模式）。
 *
 * 背景：export let 可被任一 import 方静默改写（events/store.ts R26-105 同款认定），
 * 测试注入与生产默认值共用一个可变导出，外部模块一次赋值就永久改掉全进程锁档。
 * 修后：导出值恒为生产默认档，测试只能经注入钩子改「生效值」。
 *
 * 验证口径：
 * 1. 六个导出档的值与文档一致（防档位漂移）；宿主模块层面尝试赋值（ESM 只读绑定
 *    会抛 TypeError）——vitest 对模块命名空间有转译层，抛错与否随宿主实现差异，
 *    因此只断言「赋值路径不影响行为」，const 语义由 tsc + ESM 语言层保证；
 * 2. 注入钩子仍真实生效：清单锁被他进程（活 pid 探针锁）持有时，注入 0ms 档 →
 *    withManifestLock 快速 fail-closed 抛错（远小于 5s 默认档），证明「注入值驱动
 *    生效值、导出常量只是默认档」的分层成立。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import * as serviceMod from '../../src/document/service.js'
import * as journalMod from '../../src/document/journal.js'
import * as manifestMod from '../../src/document/manifest.js'
import * as leadMod from '../../src/document/lead-finalize.js'
import * as pauseMod from '../../src/state/batch-pause.js'
import { withManifestLock, __setManifestLockTimeoutForTest } from '../../src/document/manifest.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'

describe('R30-18 / 锁超时档常量化', () => {
  it('六个导出档为生产默认值，且外部赋值不可达生效路径（值恒不变）', () => {
    const cases: [string, object, string, number][] = [
      ['service.META', serviceMod, 'META_SAVE_LOCK_TIMEOUT_MS', 5_000],
      ['service.WIRING', serviceMod, 'WIRING_SAVE_LOCK_TIMEOUT_MS', 5_000],
      ['journal', journalMod, 'JOURNAL_LOCK_TIMEOUT_MS', 2_000],
      ['manifest', manifestMod, 'MANIFEST_LOCK_TIMEOUT_MS', 5_000],
      ['lead-finalize', leadMod, 'LEAD_FINALIZE_LOCK_TIMEOUT_MS', 5_000],
      ['batch-pause', pauseMod, 'PAUSE_LOCK_TIMEOUT_MS', 2_000],
    ]
    for (const [name, mod, key, expected] of cases) {
      // ESM 只读绑定下赋值抛 TypeError；转译层可能吞掉抛错——两种形态都不允许改到值
      try {
        ;(mod as unknown as Record<string, number>)[key] = 999_999
      } catch {
        /* 预期形态之一 */
      }
      expect((mod as unknown as Record<string, unknown>)[key], name).toBe(expected)
    }
  })

  it('注入钩子仍生效：清单锁在持时按注入档快速 fail-closed（远小于 5s 默认档）', () => {
    const root = mkdtempSync(join(tmpdir(), 'r30-consts-'))
    try {
      const manifestPath = join(root, '项目', '文档清单.jsonl')
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeFileSync(manifestPath, '{"version":1,"type":"header"}\n', 'utf-8')
      // 模拟他进程持清单锁（活 pid 探针锁，内容格式与锁基建一致）
      const lockPath = `${manifestPath}.lock`
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
      __setManifestLockTimeoutForTest(0) // 注入 0ms → 2 轮均立即失败
      const t0 = Date.now()
      expect(() => withManifestLock(manifestPath, () => '不应执行')).toThrow(/清单锁获取超时/)
      // 有界：2 轮 × 0ms + 50ms 间隔，远小于默认 2×5s（若注入失效本断言超时）
      expect(Date.now() - t0).toBeLessThan(2_000)
    } finally {
      __setManifestLockTimeoutForTest(5_000)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
