/**
 * P1-10 回归：server 启动链书库自愈（repairBooks 接线）。
 *
 * 修复前：repairBooks（books.jsonl 损坏/移书后扫描重建登记）零生产调用方——
 * 登记损坏后作者无路触发自愈（CLI 入口已删），书架静默丢书。修复后 startServer
 * 启动期幂等执行一次：登记完好 no-op 不写盘；缺失/损坏时扫描重建。
 * 本测试验证「磁盘有书、books.jsonl 缺失」→ 启动后书架可见该书 + 登记已落盘。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio 空书架形态（无登记 = 不写 books.jsonl，
 * 与被测「books.jsonl 缺失」前置等价）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

let studio: StudioHarness
let workDir = ''

beforeAll(async () => {
  studio = await bootStudio({
    prefix: 'clwriting-srvrepair-',
    // 磁盘有完整书仓库（book.yaml + 一章正文），但 books.jsonl 缺失——模拟登记损坏/被删
    dirs: ['长篇/失联书/写作/正文'],
    files: [
      { rel: '长篇/失联书/book.yaml', content: 'spec_version: 1\nkind: long\nbook:\n  title: 失联书\n  genre: 玄幻\nhost: cc\n' },
      { rel: '长篇/失联书/写作/正文/0001-开篇.md', content: '# 开篇\n\n正文。\n' },
    ],
  })
  workDir = studio.workDir
})

afterAll(() => studio.close())

describe('P1-10 server 启动书库自愈', () => {
  it('books.jsonl 缺失 → 启动 repair 重建登记，书架可见该书 + 登记落盘', async () => {
    const r = await fetch(`${studio.baseUrl}/api/books`)
    expect(r.status).toBe(200)
    const json = (await r.json()) as { books: { name: string; title: string }[] }
    expect(json.books.some((b) => b.title === '失联书')).toBe(true)
    // 自愈产物落盘：books.jsonl 已被重建
    expect(existsSync(join(workDir, '.clwriting', 'books.jsonl'))).toBe(true)
  })
})
