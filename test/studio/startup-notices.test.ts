/**
 * A4（批 0）启动通告端点集成测：启动链迁移失败注入 → GET /api/startup-notices
 * 返回横幅数据；干净书库返回空列表。
 *
 * 注入方式（自然故障，非 mock）：v1 结构书（清单/ 目录存在）+ 大纲/章纲 被同名
 * 普通文件占位 → migrateLayoutV2 renameSync ENOTDIR → errors → 启动通告。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const servers: http.Server[] = []
const dirs: string[] = []

afterAll(() => {
  for (const s of servers) s.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** boot 并等 listening 就绪（listen 异步，address() 在就绪前为 null） */
function bootReady(workDir: string, userDataPath: string): Promise<string> {
  const server = startServer({ port: 0, workDir, userDataPath })
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      const addr = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${addr.port}`)
    })
    server.once('error', reject)
  })
}

async function getNotices(baseUrl: string): Promise<{ status: number; notices: unknown[] }> {
  const res = await fetch(`${baseUrl}/api/startup-notices`)
  const json = (await res.json()) as { notices?: unknown[] }
  return { status: res.status, notices: json.notices ?? [] }
}

/** 最小 v1 结构书（清单/ 待迁 + 大纲/章纲 被文件占位 → v2 迁移必失败） */
function makeBrokenBook(root: string): void {
  mkdirSync(join(root, '清单'), { recursive: true })
  writeFileSync(join(root, '清单', '001-短篇.md'), '---\n章号: 1\n标题: 短篇\n---\n正文。')
  mkdirSync(join(root, '大纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '章纲'), '占位普通文件，阻断目录 rename')
}

function makeWorkdir(withBrokenBook: boolean): string {
  const workDir = mkdtempSync(join(tmpdir(), 'clw-notices-'))
  dirs.push(workDir)
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  const name = withBrokenBook ? '坏书' : '好书'
  const path = withBrokenBook ? `坏/${name}` : `好/${name}`
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name, path, kind: 'short' }) + '\n',
  )
  const bookRoot = join(workDir, path)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: short\nbook:\n  title: 测试书\n')
  if (withBrokenBook) makeBrokenBook(bookRoot)
  return workDir
}

describe('GET /api/startup-notices（A4 批 0）', () => {
  it('干净书库：无通告', async () => {
    const workDir = makeWorkdir(false)
    const userData = mkdtempSync(join(tmpdir(), 'clw-notices-ud-'))
    dirs.push(userData)
    const baseUrl = await bootReady(workDir, userData)
    const r = await getNotices(baseUrl)
    expect(r.status).toBe(200)
    expect(r.notices).toEqual([])
  })

  it('v2 迁移失败注入：通告可见（kind + 人话 message）', async () => {
    const workDir = makeWorkdir(true)
    const userData = mkdtempSync(join(tmpdir(), 'clw-notices-ud-'))
    dirs.push(userData)
    const baseUrl = await bootReady(workDir, userData)
    const r = await getNotices(baseUrl)
    expect(r.status).toBe(200)
    expect(r.notices.length).toBeGreaterThan(0)
    const notice = r.notices[0] as { ts: string; kind: string; message: string }
    expect(notice.kind).toBe('migrate-layout-v2')
    expect(notice.message).toContain('坏书')
    expect(typeof notice.ts).toBe('string')
    // 通告稳定（同实例重复读取一致——横幅轮询不抖动）
    const r2 = await getNotices(baseUrl)
    expect(r2.notices).toEqual(r.notices)
  })

  it('日志同步落痕：失败通告同时写入 userData/logs/ JSONL', async () => {
    const workDir = makeWorkdir(true)
    const userData = mkdtempSync(join(tmpdir(), 'clw-notices-ud-'))
    dirs.push(userData)
    await bootReady(workDir, userData)
    // startServer 内 log.error 排队异步落盘；轮询等文件出现（串行队列保证有序）。
    // R63-16/O1：轮询窗 5s→10s——首轮全量曾在并行 tsc 争用下假红（单跑两连绿，
    // log 泵机制亲验无丢行路径）；下界轮询加宽零代价（命中即退，不付全额）
    const { readdirSync, readFileSync: rf } = await import('node:fs')
    let found = false
    for (let i = 0; i < 100 && !found; i++) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        const files = readdirSync(join(userData, 'logs')).filter((f) => f.endsWith('.jsonl'))
        for (const f of files) {
          if (rf(join(userData, 'logs', f), 'utf8').includes('migrate-layout-v2')) found = true
        }
      } catch {
        /* 尚未写出 */
      }
    }
    expect(found).toBe(true)
  })
})
