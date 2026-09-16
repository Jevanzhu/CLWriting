/**
 * R0916-6-nano-1（2026-09-16 评审修复批）：repeat_chars_threshold 非正整数夹紧回归
 * ——镜像姊妹键 repeat_threshold 的 R0912-3 夹紧用例形态（runner 级 + 检查器直调级）。
 * yaml 解析层只验 >0（R52 口径），手写 0.5 直穿后 repeatChars > 0.5 近乎恒真 = 绝对
 * 字数口径形同恒报黄；现消费点夹紧：非正整数 warn 留痕 + 回落默认值 200。
 */
import { test, expect, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRepeat } from '../../src/check/count.js'
import { runAllChecks } from '../../src/check/runner.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import type { ChapterMeta } from '../../src/format/types.js'

const REP = '他推开门走了出去，雪落了下来，屋里的灯还亮着。'
// 30 连句：复读率 ≈0.967（r0912-3 同款）；绝对重复字符量 3480 字（29×15 窗 × 8 字）
const REP_BODY = REP.repeat(30)
const CH: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }

const repeatItems = (report: ReturnType<typeof runAllChecks>) =>
  report.sections.flatMap((s) => s.items).filter((i) => i.checkId === 'repeat')

test('R0916-6-nano-1: repeat_chars_threshold 0.5 → 夹紧回落默认 200 + warn 留痕（不再近乎恒报黄于无痕）', () => {
  const tmp = mkdtempTracked(join(tmpdir(), 'clwriting-r0916-6-nano1-'))
  const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
  try {
    const cfg = structuredClone(DEFAULT_CONFIG)
    // 比率阈 1 关比率口径，专看绝对字数口径的夹紧
    cfg.checks = { repeat_threshold: 1, repeat_chars_threshold: 0.5 }
    const items = repeatItems(runAllChecks({ bookRoot: tmp, config: cfg, chapter: CH, body: REP_BODY, fileName: '001-雪夜.md' }))
    // 回落到默认 200（而非 0.5 恒真形态）——message 注明回落后的实际阈值
    expect(items).toHaveLength(1)
    expect(items[0]!.message).toContain('超绝对阈值 200 字')
    // 留痕：warn 点名键与回落动作
    const hits = warnSpy.mock.calls.filter((c) => String(c[1]).includes('repeat_chars_threshold') && String(c[1]).includes('回落'))
    expect(hits).toHaveLength(1)
  } finally {
    warnSpy.mockRestore()
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('R0916-6-nano-1: 合法正整数原样生效零 warn；≤0/NaN 同判回落', () => {
  const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
  try {
    // 合法值 300：原样生效（repeatChars 3480 > 300 照报，阈值如实显示），零 warn
    const ok = checkRepeat(REP_BODY, 1, 300)
    expect(ok.items).toHaveLength(1)
    expect(ok.items[0]!.message).toContain('超绝对阈值 300 字')
    // 边界默认值 200 本身合法：不夹紧不 warn
    const boundary = checkRepeat(REP_BODY, 1, 200)
    expect(boundary.items[0]!.message).toContain('超绝对阈值 200 字')
    expect(warnSpy.mock.calls.filter((c) => String(c[1]).includes('repeat_chars_threshold'))).toHaveLength(0)
    // ≤0（解析层拒后再直调兜底）与 NaN 同判回落 200 + warn
    for (const bad of [0, -1, Number.NaN]) {
      const r = checkRepeat(REP_BODY, 1, bad)
      expect(r.items[0]!.message).toContain('超绝对阈值 200 字')
    }
    expect(warnSpy.mock.calls.filter((c) => String(c[1]).includes('repeat_chars_threshold'))).toHaveLength(3)
  } finally {
    warnSpy.mockRestore()
  }
})
