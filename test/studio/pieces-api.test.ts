/**
 * 篇详情端点集成测（#6.5）：启动 studio server + 临时短篇书 fixture，
 * 端到端验证 GET /pieces + GET /piece/:no（元数据/正文/清单三段）+ 防穿越 + 长篇拒绝。
 *
 * 复用 api-integration.test.ts 的 fixture 模式；短篇书（kind: short）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '短篇测试集'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-pieces-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'short' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: short\nbook:\n  title: 短篇测试集\n  genre: 悬疑\nhost: cc\n',
  )
  // 第 1 篇：正文 + 清单
  const pieceDir = join(bookRoot, '篇', '001-雨夜门铃')
  mkdirSync(pieceDir, { recursive: true })
  writeFileSync(
    join(pieceDir, '正文.md'),
    [
      '---',
      '篇号: 1',
      '标题: 雨夜门铃',
      '目标情绪: 惊悚',
      '核心反转: 来客就是三年前的死者',
      '---',
      '',
      '## 开头钩子',
      '',
      '七号公寓停电的晚上，门铃响了三次。门外没有脚印。',
      '',
      '## 反转',
      '',
      '来客笑了，报纸照片里的死者正是他。',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(pieceDir, '清单.md'),
    [
      '## 反转线索表',
      '- 核心反转：来客就是三年前的死者',
      '- 铺垫点（≥3，反转可回溯）：',
      '  - [开头钩子] 门外没有脚印',
      '  - [铺垫] 旧收音机夹着报纸',
      '  - [升级] 703 门牌被封条盖住',
      '',
      '## 情绪曲线',
      '- [开头钩子] 惊悚 4/10',
      '- [铺垫] 不安 6/10',
      '- [反转] 后怕 9/10',
      '',
      '## 伏笔回收',
      '- 门外没有脚印 → 回收于 反转',
      '- 旧收音机（未回收）',
      '',
    ].join('\n'),
  )

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('篇详情端点（#6.5）', () => {
  it('GET /pieces 返篇列表（篇号/标题/目标情绪/字数）', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/pieces`)
    expect(r.ok).toBe(true)
    const d = (await r.json()) as {
      pieces: { 篇号: number; 标题: string; 目标情绪?: string; 字数: number; 核心反转?: string }[]
    }
    expect(d.pieces).toHaveLength(1)
    expect(d.pieces[0]!.篇号).toBe(1)
    expect(d.pieces[0]!.标题).toBe('雨夜门铃')
    expect(d.pieces[0]!.目标情绪).toBe('惊悚')
    expect(d.pieces[0]!.字数).toBeGreaterThan(0)
    expect(d.pieces[0]!.核心反转).toBe('来客就是三年前的死者')
  })

  it('GET /piece/1 返元数据 + 正文 body + 清单三段', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/piece/1`)
    expect(r.ok).toBe(true)
    const d = (await r.json()) as {
      meta: { 篇号: number; 核心反转: string }
      body: string
      list: {
        反转线索表: { 核心反转: string; 铺垫点: { 位置: string; 内容: string }[] }
        情绪曲线?: { 段落: string; 情绪: string; 强度: number }[]
        伏笔回收: { 伏笔: string; 回收位置: string; 未回收?: boolean }[]
      }
    }
    // 元数据
    expect(d.meta.篇号).toBe(1)
    expect(d.meta.核心反转).toBe('来客就是三年前的死者')
    // 正文 body（front matter 之后）
    expect(d.body).toContain('门外没有脚印')
    expect(d.body).not.toContain('篇号: 1')
    // 清单：反转线索表
    expect(d.list.反转线索表.核心反转).toBe('来客就是三年前的死者')
    expect(d.list.反转线索表.铺垫点).toHaveLength(3)
    expect(d.list.反转线索表.铺垫点[0]!.位置).toBe('开头钩子')
    // 清单：情绪曲线（峰值 9 高亮数据齐）
    expect(d.list.情绪曲线).toHaveLength(3)
    expect(d.list.情绪曲线![2]!.强度).toBe(9)
    // 清单：伏笔回收（未回收标记）
    expect(d.list.伏笔回收).toHaveLength(2)
    const unresolved = d.list.伏笔回收.find((e) => e.未回收)
    expect(unresolved?.伏笔).toBe('旧收音机')
  })

  it('GET /piece/2 不存在 → 404', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/piece/2`)
    expect(r.status).toBe(404)
  })

  it('GET /piece/abc 篇号非法 → 400', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/piece/abc`)
    expect(r.status).toBe(400)
  })

  it('GET /piece/0 篇号非正整数 → 400', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/piece/0`)
    expect(r.status).toBe(400)
  })

  it('长篇书 GET /pieces → 400（篇详情短篇专属）', async () => {
    // 临时登记一本长篇书
    const longRoot = join(workDir, '长篇书')
    mkdirSync(longRoot, { recursive: true })
    writeFileSync(join(longRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 长\n  genre: 玄幻\n')
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: BOOK, path: BOOK, kind: 'short' }) +
        '\n' +
        JSON.stringify({ name: '长篇书', path: '长篇书', kind: 'long' }) +
        '\n',
    )
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent('长篇书')}/pieces`)
    expect(r.status).toBe(400)
  })
})
