import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  doConfirm,
  checkConfirmGate,
  readConfirm,
  clearConfirm,
  hashFile,
  hashContent,
  confirmPath,
} from '../../src/gate/confirm.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), '北境往事-'))
}

// ── 哈希（#11 第 4 节）────────────────────────────

test('hashContent: SHA-256 稳定 + sha256: 前缀', () => {
  const h = hashContent('细纲内容')
  expect(h).toMatch(/^sha256:[0-9a-f]{64}$/)
  // 同输入同输出
  expect(hashContent('细纲内容')).toBe(h)
  // 改一个字就变
  expect(hashContent('细纲内客')).not.toBe(h)
})

test('hashFile: 原始字节哈希', () => {
  const dir = makeWorkDir()
  const fp = join(dir, '细纲.md')
  writeFileSync(fp, '第152章 细纲内容', 'utf-8')
  expect(hashFile(fp)).toMatch(/^sha256:[0-9a-f]{64}$/)
  rmSync(dir, { recursive: true, force: true })
})

// ── confirm 命令（#11 第 3 节）────────────────────

test('doConfirm: manual 模式写记录 + 哈希绑定', () => {
  const dir = makeWorkDir()
  const outline = join(dir, '细纲.md')
  writeFileSync(outline, '第152章内容', 'utf-8')

  const r = doConfirm(dir, 152, outline, 'manual', DEFAULT_CONFIG)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.record.chapter).toBe(152)
    expect(r.record.mode).toBe('manual')
    expect(r.record.outline_hash).toMatch(/^sha256:/)
    // 记录写盘
    const read = readConfirm(dir)
    expect(read).not.toBeNull()
    expect(read!.chapter).toBe(152)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('doConfirm: auto 模式需 book.yaml 开关（#11 第 6 节）', () => {
  const dir = makeWorkDir()
  const outline = join(dir, '细纲.md')
  writeFileSync(outline, '内容', 'utf-8')

  // 关着 auto.confirm_outline → 拒绝
  const cfgOff: BookConfig = { ...DEFAULT_CONFIG, auto: { ...DEFAULT_CONFIG.auto, confirm_outline: false } }
  const r1 = doConfirm(dir, 1, outline, 'auto', cfgOff)
  expect(r1.ok).toBe(false)
  if (!r1.ok) expect(r1.reason).toContain('自动确认')

  // 开着 → 放行
  const cfgOn: BookConfig = { ...DEFAULT_CONFIG, auto: { ...DEFAULT_CONFIG.auto, confirm_outline: true } }
  const r2 = doConfirm(dir, 1, outline, 'auto', cfgOn)
  expect(r2.ok).toBe(true)

  rmSync(dir, { recursive: true, force: true })
})

// ── 备料闸三态（#11 第 5 节）──────────────────────

test('checkConfirmGate: 无记录 → 拒绝（细纲还没拍板）', () => {
  const dir = makeWorkDir()
  const outline = join(dir, '细纲.md')
  writeFileSync(outline, '内容', 'utf-8')
  const r = checkConfirmGate(dir, outline)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('细纲还没拍板')
  rmSync(dir, { recursive: true, force: true })
})

test('checkConfirmGate: 哈希一致 → 放行', () => {
  const dir = makeWorkDir()
  const outline = join(dir, '细纲.md')
  writeFileSync(outline, '第152章内容', 'utf-8')
  doConfirm(dir, 152, outline, 'manual', DEFAULT_CONFIG)
  const r = checkConfirmGate(dir, outline)
  expect(r.ok).toBe(true)
  rmSync(dir, { recursive: true, force: true })
})

test('checkConfirmGate: 细纲改过后哈希不一致 → 拒绝（#11 第 5 节防偷改）', () => {
  const dir = makeWorkDir()
  const outline = join(dir, '细纲.md')
  writeFileSync(outline, '原始细纲', 'utf-8')
  doConfirm(dir, 152, outline, 'manual', DEFAULT_CONFIG)

  // 偷改细纲
  writeFileSync(outline, '被篡改的细纲', 'utf-8')

  const r = checkConfirmGate(dir, outline)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('改过了')
  rmSync(dir, { recursive: true, force: true })
})

test('clearConfirm: 删除确认记录', () => {
  const dir = makeWorkDir()
  const outline = join(dir, '细纲.md')
  writeFileSync(outline, '内容', 'utf-8')
  doConfirm(dir, 1, outline, 'manual', DEFAULT_CONFIG)
  expect(readConfirm(dir)).not.toBeNull()
  clearConfirm(dir)
  expect(readConfirm(dir)).toBeNull()
  rmSync(dir, { recursive: true, force: true })
})

test('确认记录写在工作区 .confirm.json（机器域）', () => {
  const dir = makeWorkDir()
  const outline = join(dir, '细纲.md')
  writeFileSync(outline, '内容', 'utf-8')
  doConfirm(dir, 1, outline, 'manual', DEFAULT_CONFIG)
  // 文件名是 .confirm.json
  const raw = JSON.parse(readFileSync(confirmPath(dir), 'utf-8'))
  expect(raw.chapter).toBe(1)
  expect(raw.outline_hash).toMatch(/^sha256:/)
  rmSync(dir, { recursive: true, force: true })
})
