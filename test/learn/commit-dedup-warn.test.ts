/**
 * R28-7（二十八轮）回归：learn-commit 去重命中留痕。
 *
 * commitDeduped 指纹只含 kind+场景+正文——同批同场景同正文但技法指令不同的第二条
 * 此前静默去重、指令丢失无提示；修后命中去重时 log.warn 留痕（既有条目路径 + 被吞
 * 条目的技法指令摘要）。未 initLogging 时镜像 console.warn，spy 断言即可。
 *
 * 放置说明：commit.ts 既有幂等测锚在 test/studio/r27-batch-c.test.ts（二十七轮批 C
 * 跨域回归文件，不在本修复批可改范围），故按「新建最小直测」落 learn 域本目录。
 */
import { test, expect, vi } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commitSamples } from '../../src/learn/commit.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('R28-7: 去重命中 warn 留痕（既有条目路径 + 被吞条目的技法指令摘要）', () => {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'r28-learn-'))
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    commitSamples(bookRoot, [
      { 章号: 1, 打分: 5, 场景: '战斗', 技法指令: '指令甲', 出处: '《甲》第1章', 正文: '同一句正文。' },
    ])
    warnSpy.mockClear()
    // 同场景同正文、不同技法指令：指纹相同 → 去重命中且 warn（修复前静默吞、指令丢失）
    const out = commitSamples(bookRoot, [
      { 章号: 2, 打分: 5, 场景: '战斗', 技法指令: '指令乙', 出处: '《乙》第2章', 正文: '同一句正文。' },
    ])
    expect(out).toHaveLength(1) // 幂等返回值不变
    const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warnText).toContain('去重命中')
    expect(warnText).toContain('指令乙') // 被吞条目的技法指令摘要留痕
    expect(warnText).toContain('文风/条目/样章/') // 既有条目路径留痕
    // 条目仍只落一份（幂等语义不变）
    const dir = join(bookRoot, '文风', '条目', '样章')
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.md'))).toHaveLength(1)
  } finally {
    warnSpy.mockRestore()
  }
})
