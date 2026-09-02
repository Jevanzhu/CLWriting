/**
 * R73-34（二十一轮 D-1）回归：删书先 rename 入墓地再清理。
 *
 * 此前裸 rmSync(recursive, force) 中途抛错（占用/权限/磁盘满）会留下半删目录 + 未清的
 * books.jsonl 登记（启动 repair 只兜底整目录缺失，半删态登记悬空且不可逆）。修复后：
 * 同盘 rename 原子入 .删书墓地（成功即原位不存在半删态），墓地副本清理失败仅留痕不阻断
 * ——登记照常移除，数据在墓地可手工恢复。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { __waitForGraveyardCleanupForTest } from '../../src/studio/server/api/books.js'

const GRAVEYARD = '.删书墓地'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const permsReliable = process.platform !== 'win32' && !isRoot // win chmod 近似 no-op；root 越权不触发 EACCES

let workDir = ''
let userDataDir = ''
let server: http.Server | undefined
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

async function req(method: string, path: string): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'x-studio-token': token } })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 响应留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-del-grave-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'clwriting-del-grave-user-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  server = await startServerSafe({ port: 0, workDir, userDataPath: userDataDir })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

describe('R73-34 删书墓地', () => {
  it('正常删书：原位目录消失、登记移除、墓地副本最终清干净', async () => {
    const bookAbs = makeBook('墓地正常删')
    const del = await req('DELETE', `/api/books/${encodeURIComponent('墓地正常删')}`)
    expect(del.status).toBe(200)
    expect(existsSync(bookAbs)).toBe(false)
    const registry = JSON.parse('[' + readBooksJsonl().trim().split('\n').join(',') + ']') as Array<{ name?: string }>
    expect(registry.some((e) => e.name === '墓地正常删')).toBe(false)
    // R35-6：墓地清理已后台化——端点返回不等 rm，等待在途清理收尾后断言最终清空
    await __waitForGraveyardCleanupForTest()
    const graveDir = join(workDir, GRAVEYARD)
    expect(existsSync(graveDir) ? readdirSync(graveDir) : []).toEqual([])
  })

  it.skipIf(!permsReliable)('墓地清理失败（权限）：删书仍成功收口、登记移除、副本留档墓地', async () => {
    const name = '墓地清不动'
    const bookAbs = makeBook(name)
    // 只把书内子目录退为 r-x：rename（Darwin 对被改名目录本身要写权，故不能退 bookAbs）
    // 照常成功，随后 rmSync 墓地副本在 r-x 子目录内 unlink EACCES——正是 D-1 要兜的
    // 「清理中断」形态
    chmodSync(join(bookAbs, '写作'), 0o500)
    try {
      const del = await req('DELETE', `/api/books/${encodeURIComponent(name)}`)
      expect(del.status).toBe(200)
      expect(existsSync(bookAbs)).toBe(false) // 原位无半删态
      const registry = JSON.parse('[' + readBooksJsonl().trim().split('\n').join(',') + ']') as Array<{ name?: string }>
      expect(registry.some((e) => e.name === name)).toBe(false)
      // R35-6：后台 rm 对 r-x 子目录 unlink EACCES 收尾后断言终态
      await __waitForGraveyardCleanupForTest()
      const graveDir = join(workDir, GRAVEYARD)
      const left = readdirSync(graveDir)
      expect(left).toHaveLength(1) // 副本留档待手工恢复
      // rmSync 中断点：顶层 book.yaml 已删，r-x 的 写作/ 子目录连带内容留档
      expect(existsSync(join(graveDir, left[0]!, '写作'))).toBe(true)
      expect(readdirSync(join(graveDir, left[0]!, '写作'))).toContain('正文')
    } finally {
      // 还原权限保 afterAll 清理可达（r-x 在墓地副本的嵌套子目录上，需递归还原）
      chmodDirTree(join(workDir, GRAVEYARD))
    }
  })

  it('R39-16（三十九轮）：登记在册但目录已失（并发删书第二请求形态）→ 404 NOT_FOUND 而非 500', async () => {
    // 只写登记不建目录 = 模拟「第一请求已把书 rename 入墓地、第二请求过完全部闸才摸到
    // ENOENT」的并发窗（登记移除前）——原口径回 500「书未受影响，可重试」与事实（书
    // 已删成功）矛盾，用户照文案重试得 404 语义打架。resolveBook 命中登记、
    // resolveWithinRoot 对缺失目标按 Y-5 祖先锚定放行 → renameWithRetry ENOENT → 新
    // ENOENT 分支回 404 NOT_FOUND（与登记缺失形态同一用户语义）
    writeFileSync(
      join(workDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: '幽灵登记书', path: '长篇/幽灵登记书', kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }) + '\n',
      'utf-8',
    )
    const del = await req('DELETE', `/api/books/${encodeURIComponent('幽灵登记书')}`)
    expect(del.status).toBe(404)
    expect((del.json as { code?: string }).code).toBe('NOT_FOUND')
  })
})

/** 递归还原目录权限（测试清理用：r-x 副本会卡住 afterAll 的 rmSync） */
function chmodDirTree(dir: string): void {
  if (!existsSync(dir)) return
  chmodSync(dir, 0o700)
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    let isDir = false
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      continue
    }
    if (isDir) chmodDirTree(p)
  }
}

function readBooksJsonl(): string {
  // books.jsonl 读侧容错：此刻无并发写者，直接同步读
  return readFileSync(join(workDir, '.clwriting', 'books.jsonl'), 'utf-8')
}
