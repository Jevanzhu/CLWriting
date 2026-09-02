/**
 * A4（批 0）启动通告端点集成测：启动链迁移失败注入 → GET /api/startup-notices
 * 返回横幅数据；干净书库返回空列表。
 *
 * 注入方式（自然故障，非 mock）：v1 结构书（清单/ 目录存在）+ 大纲/章纲 被同名
 * 普通文件占位 → migrateLayoutV2 renameSync ENOTDIR → errors → 启动通告。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { flushLogsForTest } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

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
  const workDir = mkdtempTracked(join(tmpdir(), 'clw-notices-'))
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
    const userData = mkdtempTracked(join(tmpdir(), 'clw-notices-ud-'))
    dirs.push(userData)
    const baseUrl = await bootReady(workDir, userData)
    const r = await getNotices(baseUrl)
    expect(r.status).toBe(200)
    expect(r.notices).toEqual([])
  })

  it('v2 迁移失败注入：通告可见（kind + 人话 message）', async () => {
    const workDir = makeWorkdir(true)
    const userData = mkdtempTracked(join(tmpdir(), 'clw-notices-ud-'))
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
    const userData = mkdtempTracked(join(tmpdir(), 'clw-notices-ud-'))
    dirs.push(userData)
    await bootReady(workDir, userData)
    // startServer 内 log.error 排队异步落盘。R63-16/O1 起两代以轮询窗口等待（5s→10s
    // →20s），全量并行争用下 fs 线程池饥饿仍可越窗假红（单跑恒绿）——窗口加宽是对症
    // 不对根。残留清偿批定稿：改确定性排空钩子 flushLogsForTest（await 串行泵 tail，
    // 含在途 appendFile 完成后 tail 才决议），断言不再依赖时间窗。
    // IR-9（独立重评 2026-09-02）：flush 钩子后仍偶红的真根因在 log 泵自身——前测
    // 泵在途 + 本测 initLogging 换目录，在途泵排空跨目录时新目录未建（init mkdir 链
    // 排在泵完成之后）→ appendFile ENOENT fail-open 丢行 + 空目录假象。已在泵内
    // 逐行盯目录幂等 mkdir 收口（src/log/index.ts），回归锁 test/log/log-dir-switch。
    // IR-10（独立重评 2026-09-02）：mkdir 收口后全量仍偶红——泵排空与 init(null)/
    // reset 的交错另有两路 fail-open 丢行（dayFile(null) 的 ERR_INVALID_ARG_TYPE、
    // mkdir 父目录竞态 ENOENT，均已在泵内收口/留痕 errno）；本测断言改 flush 后
    // 短轮询重排空，吸收 fs 争用下的排空滞后残余窗口（见下方循环）。
    // IR-10（独立重评 2026-09-02）：flush 后短轮询重排空（5 轮 × 100ms）——全量 fs
    // 线程池争用下，泵排空可滞后于 tail 链解析（实测同毫秒批量 fail-open 丢行，
    // flush 单等一轮仍有残余窗口）。多轮 flush 吸收在途 appendFile；真丢行时泵的
    // fail-open 会在 console 留 [log] 落盘失败（errno） 可归因。
    const { readdirSync, readFileSync: rf } = await import('node:fs')
    let found = false
    let diagnose = ''
    for (let round = 0; round < 5 && !found; round++) {
      // 首轮不等：行在 flush 前已入队（同步链），排空即可读；等待只属于重试轮
      if (round > 0) await new Promise((r) => setTimeout(r, 100))
      await flushLogsForTest()
      diagnose = ''
      try {
        for (const f of readdirSync(join(userData, 'logs')).filter((f) => f.endsWith('.jsonl'))) {
          const c = rf(join(userData, 'logs', f), 'utf8')
          diagnose += `\n--- ${f}: ${JSON.stringify(c.slice(0, 300))}`
          if (c.includes('migrate-layout-v2')) found = true
        }
      } catch {
        diagnose = ` logs 目录未建（round ${round}）`
      }
    }
    if (!found) {
      const { debugLogQueueForTest } = await import('../../src/log/index.js')
      console.log(`[diagnose] found=false queue=${JSON.stringify(debugLogQueueForTest())}${diagnose}`)
    }
    expect(found).toBe(true)
  })
})
