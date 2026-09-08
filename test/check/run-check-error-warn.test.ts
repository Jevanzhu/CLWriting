/**
 * 重审-11（2026-09-07 全量代码重审 §四.11）回归：单章机检 checkWithDb 的 catch
 * 只把异常转 CHECK_ERROR 信封不回写日志。
 *
 * 树聚合路径对单章机检失败已有 warn（collectTreeIssues 的「章机检失败（红点可能
 * 缺失）」），单章端点（机检/三审）此前静默——服务日志零线索，CHECK_ERROR 500 的
 * 病因只存在于响应信封里。修复 = catch 补 log.warn（tag 'check' 对齐本文件现有
 * 用法）带文档路径与异常信息。
 *
 * 注入手法：mock ../../src/check/runner.js 的 runAllChecks 抛内部错误（其余导出
 * 透传），走 runCheckForDocument（单章端点入口）验证 warn 被调用。
 */
import { test, expect, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/check/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/check/runner.js')>()
  return {
    ...actual,
    runAllChecks: () => {
      const err = new Error('boom: 注入的机检内部错误') as NodeJS.ErrnoException
      err.code = 'EIO'
      throw err
    },
  }
})

import { runCheckForDocument } from '../../src/check/run.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const FM = '---\n章号: 1\n标题: 首章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n'

test('重审-11: 机检内部抛错 → CHECK_ERROR 信封不变 + log.warn 带文档路径（现状零留痕 → 红）', () => {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'clwriting-r11-check-'))
  const draftPath = join(bookRoot, '0001-首章.md')
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 留痕书\nhost: cc\nleads:\n  enabled: []\n', 'utf8')
  writeFileSync(draftPath, FM + '首章正文。', 'utf8')
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const outcome = runCheckForDocument(bookRoot, draftPath, null)
    // 信封契约不变（既有语义回归锚）
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('CHECK_ERROR')
      expect(outcome.error).toContain('boom')
    }
    // 重审-11 修复面：warn 留痕（tag 'check'，带文档路径 + 异常信息）
    expect(warnSpy).toHaveBeenCalled()
    const warned = warnSpy.mock.calls.map((c) => `${String(c[0])} ${String(c[1] ?? '')}`).join('\n')
    expect(warned).toContain('check')
    expect(warned).toContain(draftPath)
    expect(warned).toContain('boom')
  } finally {
    warnSpy.mockRestore()
  }
})
