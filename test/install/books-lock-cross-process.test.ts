/**
 * books.jsonl 跨进程互斥真锁回归（R63-2，十一轮修复批）——真双进程行为级验证。
 *
 * 场景：两个真实子进程（node --import tsx）对同一 workDir 并发 appendBook 各 40 次
 * （登记名前缀互不重叠）。锁生效 → 终态 books.jsonl 恒 80 条（load→push→write 整段
 * 互斥，无交错覆盖丢登记）；锁失效时（读改写窗口交错）整文件覆盖会概率性丢对方刚
 * 写入的登记行——M-8 非标准深度书无扫盘自愈，丢即永久。顺带验证锁文件用后清理
 * （终态无 .clwriting/books.lock 残留）。
 *
 * 配套锁超时降级口径（DA-3 同族，注入 0ms 超时 + 本进程持锁直接验证）：append 拒改写
 * ok:false、remove 跳过留痕（登记留盘自愈兜底）、repair 跳过本轮 skipped:'lock-timeout'；
 * 锁释放 + 超时恢复后写点正常。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'
import {
  readBooks,
  appendBook,
  removeBookEntry,
  repairBooks,
  tryBooksLock,
  __setBooksLockTimeoutForTest,
} from '../../src/install/books.js'

const root = mkdtempSync(join(tmpdir(), 'clwriting-books-xproc-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const booksPath = fileURLToPath(new URL('../../src/install/books.ts', import.meta.url))

/** 起一个子进程并发建书 N 次（登记名 前缀+序号），任一 append 失败即非零退出 */
function spawnWorker(workDir: string, tag: string, n: number): Promise<number> {
  const script = `
import { appendBook } from ${JSON.stringify(booksPath)}
for (let i = 0; i < ${n}; i++) {
  const name = ${JSON.stringify(tag)} + i
  const r = appendBook(${JSON.stringify(workDir)}, { name, path: name, kind: 'long' })
  if (!r.ok) {
    console.error('append 失败（' + name + '）：' + r.reason)
    process.exit(1)
  }
}
`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], { stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`worker 退出码 ${code}：${stderr.slice(0, 500)}`))
      else resolve(code ?? 0)
    })
  })
}

describe('books.jsonl 跨进程互斥（R63-2 真锁）', () => {
  it('双进程并发各建书 40 → 终态 80 条登记零丢失，锁文件无残留', async () => {
    const workDir = join(root, 'lib-race')
    const codes = await Promise.all([spawnWorker(workDir, '甲', 40), spawnWorker(workDir, '乙', 40)])
    expect(codes).toEqual([0, 0])
    const books = readBooks(workDir)
    expect(books).toHaveLength(80)
    const names = new Set(books.map((b) => b.name))
    for (let i = 0; i < 40; i++) {
      expect(names.has(`甲${i}`)).toBe(true)
      expect(names.has(`乙${i}`)).toBe(true)
    }
    expect(existsSync(join(workDir, '.clwriting', 'books.lock'))).toBe(false)
  }, 120_000)

  it('锁超时降级：append 拒改写 ok:false、remove/repair 跳过留痕不整写；锁释放后写点恢复', () => {
    const wd = mkdtempSync(join(tmpdir(), 'clwriting-books-degrade-'))
    const fp = join(wd, '.clwriting', 'books.jsonl')
    try {
      mkdirSync(join(wd, '.clwriting'), { recursive: true })
      writeFileSync(fp, JSON.stringify({ name: '旧书', path: '旧书', kind: 'long' }) + '\n')
      // 本进程持锁（pid 活 → 判 held）+ 注入 0ms 超时 → 调用方恒拿不到锁
      const release = tryBooksLock(wd)
      if (!release) throw new Error('前置：无争用下占锁失败')
      __setBooksLockTimeoutForTest(0)
      try {
        // append：拒改写（ok:false + 超时理由），不裸抛
        const r = appendBook(wd, { name: '新书', path: '新书', kind: 'long' })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toContain('超时')
        // remove：跳过留痕——登记原样留盘（repairBooks 扫盘自愈兜底口径）
        removeBookEntry(wd, '旧书')
        expect(readFileSync(fp, 'utf-8')).toContain('旧书')
        // repair：跳过本轮（与 read-failed 同族，幂等下次重试）
        expect(repairBooks(wd).skipped).toBe('lock-timeout')
      } finally {
        __setBooksLockTimeoutForTest(5_000)
        release()
      }
      // 释放 + 超时恢复 → 写点正常
      expect(appendBook(wd, { name: '新书', path: '新书', kind: 'long' }).ok).toBe(true)
      removeBookEntry(wd, '旧书')
      expect(readBooks(wd).map((b) => b.name)).toEqual(['新书'])
      expect(existsSync(join(wd, '.clwriting', 'books.lock'))).toBe(false)
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })
})
