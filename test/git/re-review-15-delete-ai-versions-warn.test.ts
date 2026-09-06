/**
 * 重评-15（全库代码重评审 2026-09-05）回归：deleteAiVersions 版本档案后端（无 .git
 * 书库，工作区/.版本）逐版删除失败此前 catch 空吞零留痕——调用方只拿到偏小的
 * deleted 计数，部分失败不可观测（对照：git 后端对应分支整批失败至少返回 0 可察觉）。
 * 修复：catch 内补 log.warn 留痕；控制流不变（不上抛）——轨迹删除是旁路数据
 * best-effort 语义，绝不阻断调用方主流程。
 * R51-RED-1（五十一轮，2026-09-06 recover 合并整编失同步）：实现侧 R48-68 已把裸
 * unlinkSync 换成 rmWithRetry（内部 rmSync({force:true}) + EPERM/EBUSY 退避重试），
 * 本测试 mock 面随行改钉 rmSync（failFrom 起恒抛 EPERM——退避重试的每次调用都计数，
 * 失败版本即耗尽重试上抛进 warn 分支）；断言不变：warn 留痕、不抛、deleted 如实、
 * 未删净的剩余版本可查。
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordAiVersion, listAiVersions, deleteAiVersions } from '../../src/git/ai-track.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// 按调用计数抛 EPERM 的 rmSync 替身（failFrom = Infinity 时全透传，供清理路径用；
// rmWithRetry 对 EPERM 退避重试 3 次，重试调用同样计数、同样命中 failFrom 恒抛）
const rmMock = vi.hoisted(() => ({ failFrom: Number.POSITIVE_INFINITY, calls: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    rmSync: (p: Parameters<typeof actual.rmSync>[0], opts?: Parameters<typeof actual.rmSync>[1]) => {
      rmMock.calls++
      if (rmMock.calls >= rmMock.failFrom) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }
      return actual.rmSync(p, opts)
    },
  }
})

describe('重评-15：deleteAiVersions 版本档案删除失败补 warn 留痕', () => {
  afterEach(() => {
    rmMock.failFrom = Number.POSITIVE_INFINITY
    rmMock.calls = 0
  })

  it('第 2 版删除耗尽退避 → warn 留痕、不抛、deleted=1 如实、剩余版本可查', () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clwriting-rep15-'))
    try {
      recordAiVersion(plain, 'doc_A', 'AI 版本一')
      recordAiVersion(plain, 'doc_A', 'AI 版本二')
      expect(listAiVersions(plain, 'doc_A')).toHaveLength(2)
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      rmMock.calls = 0
      rmMock.failFrom = 2 // 首版删除成功、次版起恒 EPERM（含退避重试）
      let deleted = 0
      expect(() => {
        deleted = deleteAiVersions(plain, 'doc_A')
      }).not.toThrow()
      expect(deleted).toBe(1) // 计数如实：只有首版删除成功
      expect(warn).toHaveBeenCalledTimes(1)
      const msg = String(warn.mock.calls[0]?.[1] ?? '')
      expect(msg).toContain('doc_A') // 失败版本路径留痕（作者知情权定位到版）
      warn.mockRestore()
      // 未删净可查：部分失败不误报删净
      expect(listAiVersions(plain, 'doc_A')).toHaveLength(1)
    } finally {
      rmMock.failFrom = Number.POSITIVE_INFINITY // 清理自身走 rmSync，先复位勿被拦截
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('全部失败 → 每版一条 warn、deleted=0、重复调用仍不抛', () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clwriting-rep15-'))
    try {
      recordAiVersion(plain, 'doc_A', '一')
      recordAiVersion(plain, 'doc_A', '二')
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
      rmMock.calls = 0
      rmMock.failFrom = 1
      expect(deleteAiVersions(plain, 'doc_A')).toBe(0)
      expect(warn).toHaveBeenCalledTimes(2)
      // 二次调用（版本仍在，前次全败）：同样不抛（best-effort 语义不因连续失败劣化）
      expect(() => deleteAiVersions(plain, 'doc_A')).not.toThrow()
    } finally {
      rmMock.failFrom = Number.POSITIVE_INFINITY // 清理自身走 rmSync，先复位勿被拦截
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
