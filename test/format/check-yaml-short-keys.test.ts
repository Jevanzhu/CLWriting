/**
 * B-7（二十九轮）：book.yaml short 段数值键坏值留痕 + opening_env_chars 显式 0 关检语义。
 *
 * 此前非法数值键静默丢弃（「配置写了但不生效」无迹可查）；`opening_env_chars: 0`
 * 落不进 config（>0 收口），「关检查」只能靠删行——与「未设 = 默认 300」不可区分。
 */
import { test, expect, vi } from 'vitest'
import { parseBookConfig, stringifyBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'

/** 抓 log.warn 的 console 镜像（未 initLogging 时逐字镜像 console.warn） */
function captureWarn(): { warns: string[]; restore: () => void } {
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(' '))
  })
  return { warns, restore: () => spy.mockRestore() }
}

const SHORT_PREFIX = 'spec_version: 1\nkind: short\nbook:\n  title: T\n'

test('B-7: short 数值键非法值 → warn 留痕 + 按未设（回落缺省）', () => {
  const { warns, restore } = captureWarn()
  try {
    const r = parseBookConfig(SHORT_PREFIX + 'short:\n  word_min: abc\n  section_count: -3\n  simile_threshold: \n')
    // 全部键非法 → shortConfig 空 → 整段 undefined（回落缺省链）
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.short).toBeUndefined()
    expect(warns.some((w) => w.includes('short.word_min') && w.includes('abc'))).toBe(true)
    expect(warns.some((w) => w.includes('short.section_count') && w.includes('-3'))).toBe(true)
    // 空值（`key:` 写空）同样留痕——Number('')=0 不得冒充合法值/关检
    expect(warns.some((w) => w.includes('short.simile_threshold'))).toBe(true)
  } finally {
    restore()
  }
})

test('B-7: opening_env_chars 显式 0 = 关闭检查（落键 0，区别于未设）；合法正值照常', () => {
  const { warns, restore } = captureWarn()
  try {
    const r = parseBookConfig(SHORT_PREFIX + 'short:\n  opening_env_chars: 0\n  word_min: 5000\n')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.short?.opening_env_chars).toBe(0)
    expect(r.config.short?.word_min).toBe(5000)
    // 显式 0 是合法语义，不是坏值 → 无 warn
    expect(warns.some((w) => w.includes('opening_env_chars'))).toBe(false)
    // round-trip 保真：0 写回不丢（写回后仍解析为 0 = 关检）
    const text = stringifyBookConfig(r.config)
    expect(text).toContain('opening_env_chars: 0')
    const back = parseBookConfig(text)
    expect(back.ok && back.config.short?.opening_env_chars).toBe(0)
  } finally {
    restore()
  }
})

test('B-7: opening_env_chars 写空（非显式 0）→ warn 按未设（Number(\'\')=0 不得冒充关检）', () => {
  const { warns, restore } = captureWarn()
  try {
    const r = parseBookConfig(SHORT_PREFIX + 'short:\n  opening_env_chars: \n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.short).toBeUndefined()
    expect(warns.some((w) => w.includes('short.opening_env_chars'))).toBe(true)
  } finally {
    restore()
  }
})

test('B-7: opening_env_chars 负值 → warn 按未设', () => {
  const { warns, restore } = captureWarn()
  try {
    const r = parseBookConfig(SHORT_PREFIX + 'short:\n  opening_env_chars: -5\n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.short?.opening_env_chars).toBeUndefined()
    expect(warns.some((w) => w.includes('short.opening_env_chars'))).toBe(true)
  } finally {
    restore()
  }
})

/** 防御性锚：DEFAULT_CONFIG 不含 short 段（短篇阈值走缺省参数，不烘焙全局） */
test('B-7: DEFAULT_CONFIG 不含 short 段（关检语义只来自显式 0）', () => {
  expect(DEFAULT_CONFIG.short).toBeUndefined()
})
