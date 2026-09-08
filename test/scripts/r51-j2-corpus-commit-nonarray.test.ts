/**
 * R51-J-2（五十一轮）回归：corpus-commit 对「合法但非数组」存量 JSON 的防御。
 *
 * 修复前：存量 <checkId>.json 是合法 JSON 但非数组（手工编辑成对象等）时，`existing.map`
 * 裸 TypeError 崩整轮合并循环——后续 checkId 一并不落盘，且只有崩溃栈无人话指引。
 * 修复后：口径同 R63-11（解析失败）——人话 warn、跳过该档、原文件保持原样、计数进
 * 尾部标红哨兵（退出码 1），其余 checkId 照常入库。
 * 手法：本目录 r51-j1-harvest-keywords.test.ts 既有 spawnSync tsx 冷启动形态；
 * corpusDir 传第二可选参隔离，不触仓库 test/corpus/checks。
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'

const script = fileURLToPath(new URL('../../scripts/corpus-commit.ts', import.meta.url))

function setup(): { bookRoot: string; corpusDir: string; poisoned: string } {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'r51j2-book-'))
  const corpusDir = mkdtempTracked(join(tmpdir(), 'r51j2-corpus-'))
  // 两个勾选节：style-repeat 命中毒档（合法 JSON 非数组）；simile-density 走新档
  const candidate = [
    '### checkId: style-repeat',
    '- [x] 章号 1 ｜ 判定：误报 ｜ 摘录："雪落在了城墙上"（第 1 段）',
    '',
    '### checkId: simile-density',
    '- [x] 章号 1 ｜ 判定：误报 ｜ 摘录："纸像蝉翼一样薄"（第 2 段）',
    '',
  ].join('\n')
  mkdirSync(join(bookRoot, '工作区', '语料候选'), { recursive: true })
  writeFileSync(join(bookRoot, '工作区', '语料候选', '误报候选.md'), candidate, 'utf-8')
  const poisoned = join(corpusDir, 'style-repeat.json')
  writeFileSync(poisoned, '{"note": "手工编辑成了对象"}', 'utf-8')
  return { bookRoot, corpusDir, poisoned }
}

test('R51-J-2: 存量非数组 → 人话跳过 + 原档原样 + 其余 checkId 照常入库（退出码标红）', () => {
  const { bookRoot, corpusDir, poisoned } = setup()
  const before = readFileSync(poisoned, 'utf-8')
  const r = spawnSync('node', ['--import', 'tsx', script, bookRoot, corpusDir], {
    cwd: join(fileURLToPath(new URL('../../', import.meta.url))),
    encoding: 'utf-8',
    stdio: 'pipe',
  })
  // 未完全成功哨兵标红（failedExisting>0），但不再是裸 TypeError 崩溃
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('存量语料是合法 JSON 但不是数组')
  expect(r.stderr).toContain('style-repeat.json')
  // 毒档保持原样（不按空数组整写覆盖，R63-11 同款）
  expect(readFileSync(poisoned, 'utf-8')).toBe(before)
  // 崩溃不再殃及同轮其余 checkId：simile-density 照常入库
  const sibling = join(corpusDir, 'simile-density.json')
  expect(existsSync(sibling)).toBe(true)
  expect(JSON.parse(readFileSync(sibling, 'utf-8'))).toEqual([{ excerpt: '纸像蝉翼一样薄', expect: 'silent' }])
  expect(r.stdout).toContain('完成：2 条入库（1 个检查器）')
}, 60_000)

test('R51-J-2: 存量为合法数组 → 不受防御影响照常合并（防收窄误伤）', () => {
  const { bookRoot, corpusDir, poisoned } = setup()
  // 命中节已有同 excerpt 条目（expect 误标 fire）——重标以最近一次为准（silent 覆盖）
  writeFileSync(poisoned, JSON.stringify([{ excerpt: '雪落在了城墙上', expect: 'fire' }]), 'utf-8')
  const r = spawnSync('node', ['--import', 'tsx', script, bookRoot, corpusDir], {
    cwd: join(fileURLToPath(new URL('../../', import.meta.url))),
    encoding: 'utf-8',
    stdio: 'pipe',
  })
  expect(r.status).toBe(0)
  const merged = JSON.parse(readFileSync(poisoned, 'utf-8')) as Array<{ excerpt: string; expect: string }>
  expect(merged).toEqual([{ excerpt: '雪落在了城墙上', expect: 'silent' }])
}, 60_000)

// ── 重评-P2-5（2026-09-09 全量代码重评）：R51-J-2 防的是整档非数组，P2-5 补到元素级──
// 存量「是数组」但元素形状坏（null/字符串）此前在 `existing.map` 处零校验直透：null 元素
// 裸 TypeError 崩整轮合并循环（无告警无退出哨兵）、字符串元素 excerpt=undefined 静默写回
// 成回归门输入。口径：坏条丢弃 + 人话告警 + failedExisting 哨兵；全部坏则整档跳过、原文件
// 保持原样（R51-J-2/R63-11 同款）。

/** 数组毒档夹具：style-repeat 存量写 existingJson，simile-density 走新档（幸存锚点） */
function setupArrayPoison(existingJson: string): { bookRoot: string; corpusDir: string; poisoned: string } {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'p25-book-'))
  const corpusDir = mkdtempTracked(join(tmpdir(), 'p25-corpus-'))
  const candidate = [
    '### checkId: style-repeat',
    '- [x] 章号 1 ｜ 判定：误报 ｜ 摘录："雪落在了城墙上"（第 1 段）',
    '',
    '### checkId: simile-density',
    '- [x] 章号 1 ｜ 判定：误报 ｜ 摘录："纸像蝉翼一样薄"（第 2 段）',
    '',
  ].join('\n')
  mkdirSync(join(bookRoot, '工作区', '语料候选'), { recursive: true })
  writeFileSync(join(bookRoot, '工作区', '语料候选', '误报候选.md'), candidate, 'utf-8')
  const poisoned = join(corpusDir, 'style-repeat.json')
  writeFileSync(poisoned, existingJson, 'utf-8')
  return { bookRoot, corpusDir, poisoned }
}

function runCommit(bookRoot: string, corpusDir: string) {
  return spawnSync('node', ['--import', 'tsx', script, bookRoot, corpusDir], {
    cwd: join(fileURLToPath(new URL('../../', import.meta.url))),
    encoding: 'utf-8',
    stdio: 'pipe',
  })
}

test('重评-P2-5: 存量数组含 null 元素 → 不裸崩、人话告警、退出码标红，合法条目照常合并', () => {
  const { bookRoot, corpusDir, poisoned } = setupArrayPoison(JSON.stringify([{ excerpt: '雪落在了城墙上', expect: 'fire' }, null]))
  const r = runCommit(bookRoot, corpusDir)
  // null 元素此前在此裸 TypeError 崩整轮循环——不再崩，且走 failedExisting 尾部哨兵标红
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('形状异常')
  expect(r.stderr).toContain('style-repeat.json')
  expect(r.stderr).not.toContain('TypeError')
  // 坏条（null）丢弃、合法条目保留并与新勾选合并（重标以最近一次为准）
  expect(JSON.parse(readFileSync(poisoned, 'utf-8'))).toEqual([{ excerpt: '雪落在了城墙上', expect: 'silent' }])
  expect(r.stdout).toContain('完成：2 条入库')
}, 60_000)

test('重评-P2-5: 存量数组含字符串元素 → 坏条不入库不写回（excerpt=undefined 不落回归门）', () => {
  const { bookRoot, corpusDir, poisoned } = setupArrayPoison(
    JSON.stringify(['手滑写坏的纯字符串', { excerpt: '雪落在了城墙上', expect: 'fire' }]),
  )
  const r = runCommit(bookRoot, corpusDir)
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('形状异常')
  const merged = JSON.parse(readFileSync(poisoned, 'utf-8')) as Array<{ excerpt: unknown }>
  // 修复前：字符串元素以 {excerpt: undefined} 形态静默写回；修复后只剩合法条目
  expect(merged).toEqual([{ excerpt: '雪落在了城墙上', expect: 'silent' }])
  for (const e of merged) expect(typeof e.excerpt).toBe('string')
}, 60_000)

test('重评-P2-5: 存量元素全部坏 → 整档跳过原样保留（不静默清空），其余 checkId 照常入库', () => {
  const { bookRoot, corpusDir, poisoned } = setupArrayPoison(JSON.stringify(['纯字符串', null]))
  const before = readFileSync(poisoned, 'utf-8')
  const r = runCommit(bookRoot, corpusDir)
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('跳过合并（原文件保持原样')
  // 毒档保持原样（同 R63-11 口径：不按「只剩新条目」整写覆盖既有回归门档）
  expect(readFileSync(poisoned, 'utf-8')).toBe(before)
  // 崩溃/跳过不殃及同轮其余 checkId
  const sibling = join(corpusDir, 'simile-density.json')
  expect(JSON.parse(readFileSync(sibling, 'utf-8'))).toEqual([{ excerpt: '纸像蝉翼一样薄', expect: 'silent' }])
}, 60_000)
