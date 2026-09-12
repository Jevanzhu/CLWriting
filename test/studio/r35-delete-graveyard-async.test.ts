/**
 * R35-6（三十五轮）回归：删书墓地清理移出请求路径。
 *
 * 此前原子改名入墓地后紧接同步 rmSync(recursive)——大书含 .git 的递归删除可达秒级，
 * 冻结承载全部书（SSE/心跳/保存）的单一服务进程。修复后热路径只保留原子改名，rm 后台
 * 执行：本文件注入受控清理证明「端点响应不被 rm 阻塞」（墓地副本最终被清由
 * books-delete-graveyard.test.ts 轮询/收口断言覆盖）。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（空书架形态；本地 req 排空响应体仅回 status，保留本地仅改绑定）。
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { __setGraveyardCleanupForTest, __waitForGraveyardCleanupForTest } from '../../src/studio/server/api/books.js'

const GRAVEYARD = '.删书墓地'

let studio: StudioHarness
let workDir = ''
let baseUrl = ''
let token = ''

function makeBook(name: string): string {
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name, path: `长篇/${name}`, kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
    'utf-8',
  )
  const bookAbs = join(workDir, '长篇', name)
  mkdirSync(join(bookAbs, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookAbs, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${name}\n  genre: 玄幻\nhost: cc\n`, 'utf-8')
  return bookAbs
}

async function req(method: string, path: string): Promise<{ status: number }> {
  const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'x-studio-token': token } })
  await r.arrayBuffer() // 排空响应体
  return { status: r.status }
}

beforeAll(async () => {
  studio = await bootStudio({ prefix: 'clwriting-r35-grave-async-', dirs: ['.clwriting'] })
  workDir = studio.workDir
  baseUrl = studio.baseUrl
  token = studio.token
})

afterAll(async () => {
  __setGraveyardCleanupForTest(null)
  await studio.close()
})

describe('R35-6 删书墓地后台清理', () => {
  it('端点响应不被墓地 rm 阻塞：200 返回时受控清理仍在途，墓地副本未清', async () => {
    const name = '异步清理书'
    makeBook(name)
    let release!: () => void
    let calls = 0
    let gravePath = ''
    const gated = new Promise<void>((r) => {
      release = r
    })
    __setGraveyardCleanupForTest((p) => {
      calls += 1
      gravePath = p
      return gated
    })
    try {
      const del = await req('DELETE', `/api/books/${encodeURIComponent(name)}`)
      // 端点已收口而受控清理仍挂在 deferred 上——证明响应不等递归 rm
      expect(del.status).toBe(200)
      expect(calls).toBe(1)
      expect(gravePath).toContain(GRAVEYARD)
      expect(existsSync(gravePath)).toBe(true) // 墓地副本此刻仍在（清理在途）
    } finally {
      release()
      __setGraveyardCleanupForTest(null)
    }
    // 清理收尾可等待（在途句柄先于响应注册，无漏等）
    await __waitForGraveyardCleanupForTest()
  })
})
