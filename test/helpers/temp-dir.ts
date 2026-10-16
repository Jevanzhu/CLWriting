/**
 * R72-21（二十轮 G-3）测试基建：临时目录自动回收兜底。
 *
 * 重脚手架测试文件的既有口径是「测试体尾行 rmSync」——断言一旦失败清理行不可达，
 * 临时目录在 $TMPDIR 无限累积（不污染结果，但失败跑批持续泄漏）。本助手提供
 * mkdtempTracked：创建即登记，文件级 afterEach 兜底移除。与测试体尾行 rmSync
 * 并存：通过用例先走尾行清理，afterEach 的 force:true 幂等 no-op；失败用例由
 * afterEach 收走。注意：beforeAll 创建、跨测试共享的目录不得登记（afterEach 会在
 * 首个测试后提前删共享目录），此类（如 resolve-book-root 的 isoTmp）保持手工
 * beforeAll/afterAll 对。
 *
 * 双体系现状与收编口径（重评-0914-三轮 nano R7-2 记档；2026-09-15 临时目录收敛批
 * 机械换装后更新）：test 树并存两套临时目录卫生体系——本文件 mkdtempTracked（登记 +
 * afterEach 兜底）为测试面默认；裸 mkdtempSync（手工 rmSync 配对）残留 ~167 处/138 文件，
 * 全部系「不得登记」的形态：beforeAll/module 顶层共享目录（登记会被 afterEach 在首用例
 * 后提前删共享目录）、e2e（Playwright 无 vitest 钩子）、跨用例寿命混合的助手函数。
 * 新增测试默认走 mkdtempTracked；beforeAll 共享目录保持手工 beforeAll/afterAll 对。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { rmDirRetry } from './rm-dir-retry.js'

const pending = new Set<string>()

/** 登记临时目录（当前测试结束后无论成败都移除）。返回原路径便于内联包装。 */
export function trackTempDir(dir: string): string {
  pending.add(dir)
  return dir
}

/** mkdtempSync 追踪版：参数与返回值同 node:fs.mkdtempSync 的 string 形态。 */
export function mkdtempTracked(prefix: string): string {
  return trackTempDir(mkdtempSync(prefix))
}

/**
 * tmpdir 下 tracked 临时目录（单源）：等价于 `mkdtempTracked(join(tmpdir(), prefix))`。
 *
 * 此前 36 档各自持有同体包装（tmpRoot / tempBook / tempUserData / tempBookRoot / mk…，
 * 差异只有前缀字面量），前缀是各档的失败现场标签故保留在调用方，构造与 tmpdir 基准
 * 收在此处。语义与逐档包装完全一致：登记 + afterEach 兜底移除，调用时机不限制由本
 * 函数改变（调用方自有 dirs/afterAll 显式级联仍照旧并存、互为幂等）。
 */
export function tempDirTracked(prefix: string): string {
  return mkdtempTracked(join(tmpdir(), prefix))
}

afterEach(() => {
  if (pending.size === 0) return
  for (const dir of pending) {
    // 兜底清理跑在失败路径上：瞬时 errno 有界重试，仍失败则留痕一行、不反抛
    //（用例自身的成败不被清理故障改写）。
    rmDirRetry(dir, { onExhausted: 'warn' })
  }
  pending.clear()
})
