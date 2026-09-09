/**
 * 重评-P3-23（2026-09-09 全量代码重评）回归：knowledge-commit flag() 不吞下一个 flag 名。
 *
 * 修复前：flag() 直取 argv[i+1]——`--source-ref --note "x"` 时 `--note` 被当成 sourceRef
 * 的值静默写进 manifest（source_ref 无存在性校验，直通入库）。
 * 修复后：值缺失或以 `--` 开头按缺参处理，走脚本既有「用法 + 退出码 1」参数错误出口，
 * 在触达 manifest 之前退出（登记零落盘）。
 * 手法：同目录 r51-j2-corpus-commit-nonarray.test.ts 的 spawnSync tsx 冷启动形态。
 * scripts/knowledge-commit.ts 此前无对应测试文件，本文件为其首个；用例全部走失败路径，
 * 不写任何文件，并以真实 知识层/_manifest.json 字节不变断言兜底。
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const script = fileURLToPath(new URL('../../scripts/knowledge-commit.ts', import.meta.url))
const manifest = join(repoRoot, '知识层', '_manifest.json')

function run(args: string[]) {
  return spawnSync('node', ['--import', 'tsx', script, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
  })
}

test('重评-P3-23: `--source-ref --note "x"` → --note 不被吞成值，按缺参报错退出且 manifest 零写入', () => {
  const before = readFileSync(manifest, 'utf-8')
  const r = run(['知识层/p3-23-占位定稿.md', '--source-ref', '--note', 'x'])
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('参数错误：--source-ref 缺少值')
  expect(r.stderr).toContain('用法：npm run knowledge:commit')
  // 缺参在触达 manifest 前退出——真实 _manifest.json 字节不变（不静默写入 source_ref:'--note'）
  expect(readFileSync(manifest, 'utf-8')).toBe(before)
}, 60_000)

test('重评-P3-23: flag 缺值（`--source-ref` 收尾无值）同走缺参出口', () => {
  const before = readFileSync(manifest, 'utf-8')
  const r = run(['知识层/p3-23-占位定稿.md', '--source-ref'])
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('参数错误：--source-ref 缺少值')
  expect(readFileSync(manifest, 'utf-8')).toBe(before)
}, 60_000)

test('重评-P3-23: 值形态正常时不误伤——失败发生在登记面（定稿文件不存在）而非参数面', () => {
  const before = readFileSync(manifest, 'utf-8')
  // 占位 target 不在盘 → 走到登记面报「定稿文件不存在」；证明 --note 的值被正常消费、
  // 未被一刀切误判成 flag 名（防「见 -- 就拒」式过修）
  const r = run(['知识层/p3-23-不存在-占位.md', '--note', 'x'])
  expect(r.status).toBe(1)
  expect(r.stderr).not.toContain('参数错误')
  expect(r.stderr).toContain('定稿文件不存在')
  expect(readFileSync(manifest, 'utf-8')).toBe(before)
}, 60_000)
