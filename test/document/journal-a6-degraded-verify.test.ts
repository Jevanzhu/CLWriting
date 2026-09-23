/**
 * RC 源码重审 A-6（Opus-5.5 轮）刀 2 回归：降级裸写自校验（堵「落进孤儿 inode」）。
 *
 * 缺陷：拿锁两轮失败后的降级裸写不持锁——若此刻 compact 完成 atomicWriteFile
 * （tmp+rename，**换 inode**），本行就落在被换下的旧 inode 上：路径上见不到、磁盘上
 * 是无人引用的孤儿，findUnsettled 永不报（崩溃恢复依据静默丢失）。修复：降级写改
 * 「open('a') → fstat 记写入对象 dev+ino → 写 + fsync → stat(path) 比对」，不一致即
 * 重试整段（上限 3 次，小退避），仍不成 warn 留痕（保留尽力而为兜底语义）。
 *
 * 手法：vi.mock node:fs 劫持降级写的 open('a')/close——open 时登记 fd 与「写前快照」，close
 * 时按 SWAP.swapOn 指定的第几次打开把**路径换成新 inode**（把写前快照落到新文件再 rename
 * 覆盖，与 atomicWriteFile 的换 inode 形态同构）：本笔已写入的 fd 所指 inode 自此成为孤儿，
 * 紧随其后的 stat(path) 必然看到另一个 inode。换 inode 刻意放在 close 之后——win 上目标文件
 * 存在打开句柄时 rename 恒 EPERM（实测），且生产语义里 compact 的替换同样只在对方写完后
 * （或写中途）落地，本模拟取「写完瞬间被替换」这一最不利形态。
 */
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const SWAP = vi.hoisted(() => ({
  journalPath: '',
  swapOn: [] as number[],
  opens: 0,
  targetFd: -1,
  preWrite: '',
  orphanContent: '', // 换 inode 瞬间「将被换下的旧 inode」上的内容（自校验失败的证据留存）
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: ((p: unknown, flags: string | number, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(p, flags, ...rest)
      if (typeof p === 'string' && p === SWAP.journalPath && flags === 'a') {
        SWAP.opens++
        SWAP.targetFd = fd
        SWAP.preWrite = actual.readFileSync(p, 'utf-8') // 本笔写入前的内容 = 换 inode 后新文件的内容
      }
      return fd
    }) as unknown as typeof openSync,
    closeSync: ((fd: number) => {
      const r = (actual.closeSync as (fd: number) => void)(fd)
      if (fd === SWAP.targetFd) {
        SWAP.targetFd = -1
        if (SWAP.swapOn.includes(SWAP.opens)) {
          SWAP.orphanContent = actual.readFileSync(SWAP.journalPath, 'utf-8') // 旧 inode（含本笔）此刻的内容
          // 模拟 compact 的整文件替换：新 inode 接管路径，刚写完的 fd 所指 inode 成孤儿
          const swapPath = `${SWAP.journalPath}.swapped`
          actual.writeFileSync(swapPath, SWAP.preWrite)
          actual.renameSync(swapPath, SWAP.journalPath)
        }
      }
      return r
    }) as unknown as typeof closeSync,
  }
})

import {
  appendPending,
  findUnsettled,
  JOURNAL_LOCK_TIMEOUT_MS,
  __setJournalLockTimeoutForTest,
} from '../../src/document/journal.js'
import { log } from '../../src/log/index.js'

const SEED = JSON.stringify({ opId: 'seed-op', ts: 't', status: 'settled', newRevision: 'sha256:seed' }) + '\n'

describe('A-6 刀 2：降级写自校验', () => {
  let dir: string
  let jp: string
  beforeEach(() => {
    dir = mkdtempTracked(join(tmpdir(), 'journal-a6-degraded-'))
    jp = join(dir, 'doc_1.jsonl')
    writeFileSync(jp, SEED, 'utf-8')
    // 手工放置「活进程」锁（本进程 pid → 缺省探测恒存活）→ 两轮拿锁均超时走降级分支
    writeFileSync(`${jp}.lock`, JSON.stringify({ pid: process.pid, bootTime: 0 }), 'utf-8')
    __setJournalLockTimeoutForTest(50)
    SWAP.journalPath = jp
    SWAP.swapOn = []
    SWAP.opens = 0
  })
  afterEach(() => {
    SWAP.journalPath = ''
    SWAP.swapOn = []
    SWAP.opens = 0
    SWAP.targetFd = -1
    SWAP.preWrite = ''
    SWAP.orphanContent = ''
    __setJournalLockTimeoutForTest(JOURNAL_LOCK_TIMEOUT_MS)
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('自校验发现写入对象与路径 inode 不一致（compact 刚换过 inode）→ 重试整段，第二笔落在当前 inode（opId 最终在盘且只一份）', async () => {
    SWAP.swapOn = [1] // 第一次降级打开后路径被换 inode → 首笔写进孤儿
    const warnSpy = vi.spyOn(log, 'warn')

    const opId = await appendPending(jp, 'doc_1', null, '正文内容')

    expect(SWAP.opens).toBe(2) // 自校验不过 → 重试了一次
    // 非空证明：首笔确实写进了被换下的旧 inode（A-6 前这就是确定性丢行的那一笔——它此刻
    // 在无人引用的孤儿 inode 上，路径上见不到）
    expect(SWAP.orphanContent.split('\n').filter((l) => l.includes(opId))).toHaveLength(1)
    const text = readFileSync(jp, 'utf-8')
    expect(text.startsWith(SEED)).toBe(true) // 换 inode 后的现值文件（seed 副本）未被破坏
    expect(text.split('\n').filter((l) => l.includes(opId))).toHaveLength(1) // 只有重试的那一笔可见
    expect(findUnsettled(jp).map((p) => p.opId)).toEqual([opId]) // 崩溃恢复依据在盘
    // 自校验通过 → 不落「自校验失败」留痕（原「降级裸写」warn 语义不变）
    expect(warnSpy.mock.calls.some(([, msg]) => String(msg).includes('降级写入自校验失败'))).toBe(false)
  })

  it('三次自校验全不通过（路径被持续换 inode）→ 只 warn 留痕、不抛（保留尽力而为兜底语义）', async () => {
    SWAP.swapOn = [1, 2, 3] // 每次降级打开后都换 inode → 三笔全落孤儿
    const warnSpy = vi.spyOn(log, 'warn')

    const opId = await appendPending(jp, 'doc_1', null, '正文内容') // 不得抛

    expect(opId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(SWAP.opens).toBe(3) // 上限 3 次（含首次）
    expect(warnSpy.mock.calls.some(([, msg]) => String(msg).includes('降级写入自校验失败'))).toBe(true)
    // 命中上限：本笔确实无处可见（小概率丢行如实暴露为有痕 + 可见文件不被污染）
    expect(readFileSync(jp, 'utf-8')).toBe(SEED)
    expect(findUnsettled(jp)).toHaveLength(0)
  })

  it('自校验通过（路径未被换 inode）→ 正常返回，不产生额外留痕（降级语义与 warn 文案不变）', async () => {
    const warnSpy = vi.spyOn(log, 'warn')
    const opId = await appendPending(jp, 'doc_1', null, '正文内容')

    expect(SWAP.opens).toBe(1) // 一次通过，无重试
    expect(readFileSync(jp, 'utf-8').split('\n').filter((l) => l.includes(opId))).toHaveLength(1)
    expect(findUnsettled(jp).map((p) => p.opId)).toEqual([opId])
    // 「降级裸写」warn 保留（锁超时留痕口径），但无自校验失败留痕
    expect(warnSpy.mock.calls.some(([, msg]) => String(msg).includes('降级裸写'))).toBe(true)
    expect(warnSpy.mock.calls.some(([, msg]) => String(msg).includes('降级写入自校验失败'))).toBe(false)
  })
})
