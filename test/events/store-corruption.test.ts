/**
 * IR-2（独立重评 2026-09-02）：事件库文件损坏 → 首开抛可行动错误（含库路径与恢复
 * 指引），不再裸抛 SQLite 英文码；原始错误挂 cause 保诊断链。事件是对话史/审计
 * 产品数据——不做静默删库自愈（备份/移除动作留给作者显式执行）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bookHash, openSessionStoreAsync } from '../../src/events/store.js'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('IR-2 事件库损坏 → 可行动错误', () => {
  it('垃圾字节库文件：openSessionStoreAsync 抛含路径与恢复指引的人话错误（cause 保原始 SQLite 错误）', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'clw-ev-corrupt-ud-'))
    const bookRoot = mkdtempSync(join(tmpdir(), 'clw-ev-corrupt-book-'))
    dirs.push(userData, bookRoot)
    const dbPath = join(userData, 'clwriting', 'session', bookHash(bookRoot) + '.db')
    mkdirSync(join(userData, 'clwriting', 'session'), { recursive: true })
    // 非零垃圾字节（全零首页会被 SQLite 视作空库，不触发 NOTADB）
    writeFileSync(dbPath, ' definitely not a sqlite database '.repeat(64))

    let err: unknown
    try {
      await openSessionStoreAsync(userData, bookRoot)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain('事件库文件损坏')
    expect(msg).toContain(dbPath)
    expect(msg).toContain('备份') // 恢复指引：先备份再移走，重建空库的预期明示
    // 诊断链：原始 SQLite 错误保留在 cause（裸码不丢）
    expect((err as Error).cause).toBeInstanceOf(Error)
  })

  it('正常路径不受影响：干净目录首开仍成功建库', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'clw-ev-corrupt-ok-ud-'))
    const bookRoot = mkdtempSync(join(tmpdir(), 'clw-ev-corrupt-ok-book-'))
    dirs.push(userData, bookRoot)
    const store = await openSessionStoreAsync(userData, bookRoot)
    expect(store).not.toBeNull()
    store!.close()
  })
})
