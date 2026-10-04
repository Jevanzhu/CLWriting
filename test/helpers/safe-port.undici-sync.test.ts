/**
 * 受限端口黑名单 × undici 真值同步守卫（多库多窗批立档）。
 *
 * 背景：`safe-port.ts` 的 RESTRICTED_PORTS 是手抄副本（2026-09-01），与 undici
 * 现行常量表（node_modules/undici/lib/web/fetch/constants.js 的 badPorts）曾漂移缺
 * 4190/6679 两条——落在作者机自定义动态段（1024-15000）内时，测试服务器随机抽中即
 * 「fetch failed / bad port」整档红（全量并行负载下先现、单跑不复现）。本守卫把
 * 「抄本随正本动」从注释约定升为机器门：读 undici 真值双向比对，缺项/多项即红。
 *
 * 读源方式：正则摘 undici 常量源文本（不 import——该文件是 undici 内部实现路径，
 * 无公开导出面；源文本形态稳定，undici 大版本变更时本守卫会以「未匹配到 badPorts」
 * 明确红，而不是静默放行）。放宽面：undici 后续版本**新增**受限端口时本守卫红，
 * 按提示把新项补进 safe-port.ts 即可（正是守卫的目的）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RESTRICTED_PORTS } from './safe-port.js'

/** undici 现行受限端口表（badPorts）真值——源文本摘取，见文件头注。 */
function undiciBadPorts(): number[] {
  const req = createRequire(import.meta.url)
  const pkg = req.resolve('undici/package.json')
  const src = readFileSync(join(dirname(pkg), 'lib', 'web', 'fetch', 'constants.js'), 'utf-8')
  const start = src.indexOf('const badPorts =')
  expect(start, 'undici 源文本未匹配到 badPorts 声明（undici 结构变更？按新形态改本守卫读取）').toBeGreaterThan(-1)
  const seg = src.slice(start, src.indexOf('])', start))
  const ports = [...seg.matchAll(/'(\d+)'/g)].map((m) => Number(m[1]))
  expect(ports.length, 'undici badPorts 解析为空（源文本形态漂移？）').toBeGreaterThan(50)
  return ports
}

describe('受限端口黑名单与 undici 真值同步（safe-port 抄本随正本动）', () => {
  it('无缺项：undici 表内每条都须在黑名单内（缺项 = 随机抽中即 bad port 红）', () => {
    const missing = undiciBadPorts().filter((p) => !RESTRICTED_PORTS.has(p))
    expect(
      missing,
      `safe-port.ts 黑名单缺 undici 现行受限端口 ${missing.join(', ')}——` +
        '补进 test/helpers/safe-port.ts 的 RESTRICTED_PORTS（缺项落本机动态段时测试随机红）。',
    ).toEqual([])
  })

  it('无多项：黑名单内每条都须在 undici 表内（防误抽/防历史遗留项挡住合法端口）', () => {
    const undici = new Set(undiciBadPorts())
    const extra = [...RESTRICTED_PORTS].filter((p) => !undici.has(p))
    expect(extra, `safe-port.ts 黑名单含 undici 表外端口 ${extra.join(', ')}——核对后移除或注明保留理由`).toEqual([])
  })
})
