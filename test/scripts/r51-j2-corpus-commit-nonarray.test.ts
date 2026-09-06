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
