/**
 * r0914b（全库重评-0914 修复批 B）P3-16：book.title 空值守卫（对齐 genre 归一先例）。
 *
 * parse 侧：`title: ''` 空占位不写穿 bucket（与「没写」同义）——book 段起步值
 * DEFAULT_CONFIG.book.title 本为 ''，解析结果零观察差，锁定不劣化为 'undefined'；
 * get 侧：'' → undefined，patchBookConfigText 差分口径显式清空 = 删行（与 genre 同语义）。
 */
import { test, expect } from 'vitest'
import { parseBookConfig, stringifyBookConfig, patchBookConfigText } from '../../src/format/yaml.js'

test('r0914b P3-16: `title: ""` 空占位解析安全（不走穿、重存仍出 title 行）', () => {
  const r = parseBookConfig(['book:', '  title: ""', ''].join('\n'))
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // 空串归一 undefined 后回落 DEFAULT 骨架值，仍是 ''（绝非 'undefined' 串）
  expect(r.config.book.title).toBe('')
  expect(stringifyBookConfig(r.config)).toContain('title: ""')
})

test('r0914b P3-16: get 侧空串归一 undefined——patch 清空 title = 删行（genre 同语义）', () => {
  const raw = ['book:', '  title: 旧书名', '  volume_size: 40', ''].join('\n')
  const parsed = parseBookConfig(raw)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  const next = structuredClone(parsed.config)
  next.book.title = ''
  const out = patchBookConfigText(raw, parsed.config, next)
  expect(out).not.toContain('旧书名')
  expect(out).not.toContain('title:')
  // 段内其余子键不受连带
  expect(out).toContain('volume_size: 40')
})

test('r0914b P3-16: 对照——非空 title 改名照旧改行（守卫不误伤正常路径）', () => {
  const raw = ['book:', '  title: 旧书名', ''].join('\n')
  const parsed = parseBookConfig(raw)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  const next = structuredClone(parsed.config)
  next.book.title = '新书名'
  const out = patchBookConfigText(raw, parsed.config, next)
  expect(out).toContain('title: 新书名')
  expect(out).not.toContain('旧书名')
})
