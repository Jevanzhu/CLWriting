/**
 * R0911-E-P3-2（2026-09-11 全量重评 GLM-5.3 修复批）回归：scanSummaries 的
 * readdirSync TOCTOU 守卫。
 *
 * 同域 readdir 容错家族（format/draft.ts R37-9、check/run.ts、check/runner.ts）
 * 早已把「existsSync 过后的列举间隙目录消失/路径被同名文件占用」降级为空列表 +
 * warn 留痕，唯独 scanSummaries 裸 readdirSync：瞬时竞态直穿炸穿整个 rebuild
 * 事务（fail-loud 把一次列举间隙误报成源损坏）。两分支分别锁：
 * - ENOENT：注入删除模拟列举间隙目录被瞬删（walk-md 与 scanSummaries 对同一目录
 *   各列举一次——realpath 口径归一计数，第二次即 scanSummaries 的裸列举点）；
 * - ENOTDIR：章摘要路径被同名文件占用（existsSync 对文件同为 true，确定性触发，
 *   无需注入）。
 * 其余错误码照抛的家族口径由同域先例测试面覆盖，此处不重复。
 */
import { test, expect, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, realpathSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── mock node:fs：注入开启且为该目录第二次列举（scanSummaries 裸列举点）时，
// 先真删目录再透传真 readdirSync → 由真实文件系统抛出 ENOENT（组织方式对齐
// backlog-r61c1-read-fail-warn.test.ts 的 vi.hoisted + importOriginal 透传惯例；
// 工厂内只引用 actual，不触外层 import——vi.mock 工厂提升后外层绑定未初始化）──
const TOCTOU = vi.hoisted(() => ({ inject: false, dir: '', hits: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof readdirSync>) => {
      const raw = typeof args[0] === 'string' ? args[0] : ''
      if (raw) {
        // realpath 口径归一：macOS tmpdir 的 /var→/private/var 使 walk-md（传
        // realpath）与 scanSummaries（传原始 join 路径）对同一目录形态不同，计数
        // 需按真实目录归一
        let key = raw
        try {
          key = actual.realpathSync(raw)
        } catch {
          /* 已被删/不可解析：保持原值 */
        }
        if (TOCTOU.inject && key === TOCTOU.dir) {
          TOCTOU.hits++
          if (TOCTOU.hits === 2) {
            // 模拟列举间隙目录被瞬删（TOCTOU）：第一次列举（walkSourceStats 的
            // walk-md）照常，第二次（scanSummaries）删后透传 → 真 ENOENT
            actual.rmSync(key, { recursive: true, force: true })
          }
        }
      }
      return actual.readdirSync(...args)
    }) as typeof readdirSync,
  }
})

import { rebuild } from '../../src/cache/rebuild.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 最小长篇书骨架（口径同 rebuild-walk-symlink.test.ts 的 makeLongBook）。 */
function makeBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r0911-e-p3-2-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'book:\n  title: 测试书\n  genre: 悬疑\nleads:\n  enabled: []\n', 'utf-8')
  return root
}

afterEach(() => {
  TOCTOU.inject = false
  TOCTOU.hits = 0
  vi.restoreAllMocks()
})

test('R0911-E-P3-2: 列举间隙目录被瞬删（ENOENT）→ rebuild 不炸，按空目录降级 + warn 留痕', () => {
  const root = makeBook()
  // 摘要目录有合法摘要：守卫降级「按空目录」后本轮不入库（summaryCount=0）
  writeFileSync(join(root, '定稿', '摘要', '章摘要', '1.md'), '第一章摘要内容。', 'utf-8')
  TOCTOU.dir = realpathSync(join(root, '定稿', '摘要', '章摘要'))
  TOCTOU.hits = 0
  TOCTOU.inject = true
  const warnSpy = vi.spyOn(log, 'warn')

  // 修复前：裸 readdirSync 的 ENOENT 直穿炸穿 rebuild 事务（此处抛出即红）
  const r = rebuild(root, join(root, '.cache', 'index.db'))

  expect(r.errors).toHaveLength(0)
  expect(r.summaryCount).toBe(0) // 按空目录处理：该轮摘要不入库
  const hit = warnSpy.mock.calls.find(([tag, msg]) => tag === 'rebuild' && msg.includes('章摘要'))
  expect(hit).toBeTruthy() // 降级必留痕（含路径与错误码）
  expect(hit![1]).toContain('ENOENT')
  rmSync(root, { recursive: true, force: true })
})

test('R0911-E-P3-2: 章摘要路径被同名文件占用（ENOTDIR）→ 同款降级不炸', () => {
  const root = makeBook()
  rmSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true, force: true })
  // existsSync 对文件同为 true → 前置守卫直通 → readdirSync ENOTDIR（确定性触发）
  writeFileSync(join(root, '定稿', '摘要', '章摘要'), 'not a directory', 'utf-8')
  const warnSpy = vi.spyOn(log, 'warn')

  const r = rebuild(root, join(root, '.cache', 'index.db'))

  expect(r.errors).toHaveLength(0)
  expect(r.summaryCount).toBe(0)
  const hit = warnSpy.mock.calls.find(([tag]) => tag === 'rebuild')
  expect(hit).toBeTruthy()
  expect(hit![1]).toContain('ENOTDIR')
  rmSync(root, { recursive: true, force: true })
})

test('R0911-E-P3-2: 正常摘要目录不受守卫影响（照常入库，无误伤 warn）', () => {
  const root = makeBook()
  writeFileSync(join(root, '定稿', '摘要', '章摘要', '1.md'), '第一章摘要内容。', 'utf-8')
  const warnSpy = vi.spyOn(log, 'warn')

  const r = rebuild(root, join(root, '.cache', 'index.db'))

  expect(r.summaryCount).toBe(1)
  expect(warnSpy.mock.calls.filter(([tag]) => tag === 'rebuild')).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})
