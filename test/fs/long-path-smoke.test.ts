/**
 * R77-3（二十五轮批 C）：>260 字符深路径冒烟（win 长路径对策的行为面验证）。
 *
 * 背景（win 设计方案批 6）：Windows MAX_PATH=260——Node/libuv 对绝对路径自动加
 * \\?\ 前缀绕开；本仓全部落盘走 atomic.ts（tmp+fsync+rename+目录 fsync），此测试
 * 证明整条链在 >260 字符路径上端到端可用：递归建目录 / atomicWriteFile（含覆盖
 * 既有目标的 rename）/ atomicWriteStream / createFileExclusive（EEXIST 分支）/
 * 跨进程锁 / sweep 崩溃残留清扫。
 *
 * manifest longPathAware 对策已复核不可行（electron-builder 无此字段，app-builder-lib
 * schema 零命中，2026-08-30）——对策收口为 Node \\?\ 转换 + 根 README「书库路径建议
 * <200 字符」披露，见二十五轮报告 §七。跨平台：mac/linux 原生支持长路径（验证链路
 * 行为不随路径长度分叉）；win（CI 单测腿）是真实 MAX_PATH 场景。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteStream, createFileExclusive, sweepAbandonedTmpFiles } from '../../src/fs/atomic.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'
// R28-18（二十八轮）：mkdtempTracked 接管裸 mkdtempSync——断言失败时清理行不可达，
// 临时目录在 $TMPDIR 泄漏（R72-21 助手 afterEach 兜底收走，同 atomic-rename-retry 批惯例）
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 深段构造：10 层 × ~24 字符段 + 最短 base（linux /tmp）+ 文件名 ≥ 260 字符 */
function deepPath(base: string, fileName: string): string {
  const seg = '深目录段-超过两百六十字符路径限制的行为验证'
  return join(base, ...Array.from({ length: 10 }, (_, i) => `${seg}-${i + 1}`), fileName)
}

describe('R77-3 批 C：>260 字符深路径冒烟', () => {
  it('原子写整链（file 覆盖/stream/exclusive）+ 跨进程锁在 >260 字符路径可用', () => {
    const base = mkdtempTracked(join(tmpdir(), 'clw-longpath-'))
    const filePath = deepPath(base, '第章-正文.md')
    expect(filePath.length).toBeGreaterThanOrEqual(260) // 冒烟前提：真超 MAX_PATH（含 NUL 终止符口径）

    atomicWriteFile(filePath, '第一版内容')
    expect(readFileSync(filePath, 'utf-8')).toBe('第一版内容')
    atomicWriteFile(filePath, '覆盖第二版') // rename 覆盖既有目标的同链路
    expect(readFileSync(filePath, 'utf-8')).toBe('覆盖第二版')

    const streamPath = deepPath(base, '全书导出合并稿.md')
    atomicWriteStream(streamPath, (append) => {
      append('第一章\n')
      append('第二章\n')
    })
    expect(readFileSync(streamPath, 'utf-8')).toBe('第一章\n第二章\n')

    const exclusivePath = deepPath(base, '书籍文档清单.jsonl')
    expect(createFileExclusive(exclusivePath, '{}')).toBe('created')
    expect(createFileExclusive(exclusivePath, '{}')).toBe('exists') // EEXIST 分支同深路径

    const release = tryAcquireCrossProcessLock(deepPath(base, '.save.lock'))
    expect(release).not.toBeNull()
    release!()

    rmSync(base, { recursive: true, force: true })
  })

  it('sweep 崩溃残留 tmp 清扫在深路径下照常工作（best-effort 递归不炸）', () => {
    const base = mkdtempTracked(join(tmpdir(), 'clw-longpath-sweep-'))
    const deep = deepPath(base, '正文.md')
    atomicWriteFile(deep, 'x') // 建出深目录链并留一个正常文件
    // 手造崩溃残留 tmp：死 pid + 超 5 分钟龄（sweep 双判据全满足才清）
    const tmpPath = join(
      deep.slice(0, deep.length - '正文.md'.length),
      `.正文.md.999999.deadbeef-0000-4000-8000-000000000000.tmp`,
    )
    writeFileSync(tmpPath, '残留')
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(tmpPath, old, old)

    const removed = sweepAbandonedTmpFiles(base, { minAgeMs: 5 * 60_000 })
    expect(removed).toBe(1)
    expect(existsSync(tmpPath)).toBe(false)
    expect(existsSync(deep)).toBe(true) // 正常文件不动

    rmSync(base, { recursive: true, force: true })
  })
})
