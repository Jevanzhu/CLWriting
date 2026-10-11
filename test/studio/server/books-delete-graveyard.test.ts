/**
 * R73-34（二十一轮 D-1）回归：删书先 rename 入墓地再清理。
 *
 * 此前裸 rmSync(recursive, force) 中途抛错（占用/权限/磁盘满）会留下半删目录 + 未清的
 * books.jsonl 登记（启动 repair 只兜底整目录缺失，半删态登记悬空且不可逆）。修复后：
 * 同盘 rename 原子入 .删书墓地（成功即原位不存在半删态），墓地副本清理失败仅留痕不阻断
 * ——登记照常移除，数据在墓地可手工恢复。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio——空书架形态（books.jsonl 由
 * makeRegisteredLongBook（helpers/book.ts）按用例现写，.clwriting 目录经 dirs 预建）；
 * userDataDir 由本文件自建自清；req 走无 origin 变体，保留本地、改绑 studio.baseUrl/studio.token。
 *
 * 增补：删书墓地启动兜底清扫（装配期单次清扫 min 缺口——清理失败的大书目录此前永久
 * 驻留）——见文末「启动兜底清扫」describe（自建 workDir + 先落墓地再起 server）。
 */
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../../helpers/studio-server.js'
import { startServerSafe } from '../../helpers/safe-port.js'
import { makeRegisteredLongBook } from '../../helpers/book.js'
import { sweepGraveyardOnce } from '../../../src/studio/server/api/books-lifecycle.js'
import { log } from '../../../src/log/index.js'
import { ulid } from '../../../src/fs/id.js'

const GRAVEYARD = '.删书墓地'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const permsReliable = process.platform !== 'win32' && !isRoot // win chmod 近似 no-op；root 越权不触发 EACCES
/** 符号链接可建（win 需开发者模式/管理员）；不可建时相关用例跳过而非红。 */
const canSymlink = ((): boolean => {
  const probe = join(tmpdir(), `clw-symlink-probe-${Date.now()}`)
  try {
    mkdirSync(join(probe, 't'), { recursive: true })
    symlinkSync(join(probe, 't'), join(probe, 'l'), 'dir')
    return true
  } catch {
    return false
  } finally {
    try {
      rmSync(probe, { recursive: true, force: true })
    } catch {
      // 探测残留清理失败不影响判定
    }
  }
})()

let studio: StudioHarness
let workDir = ''
let userDataDir = ''

async function req(method: string, path: string): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${studio.baseUrl}${path}`, { method, headers: { 'x-studio-token': studio.token } })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 响应留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'clwriting-del-grave-user-'))
  studio = await bootStudio({ prefix: 'clwriting-del-grave-', userDataPath: userDataDir, dirs: ['.clwriting'] })
  workDir = studio.workDir
})

afterAll(async () => {
  await studio.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

describe('R73-34 删书墓地', () => {
  it('正常删书：原位目录消失、登记移除、墓地副本最终清干净', async () => {
    const bookAbs = makeRegisteredLongBook(workDir, '墓地正常删')
    const del = await req('DELETE', `/api/books/${encodeURIComponent('墓地正常删')}`)
    expect(del.status).toBe(200)
    expect(existsSync(bookAbs)).toBe(false)
    const registry = JSON.parse('[' + readBooksJsonl().trim().split('\n').join(',') + ']') as Array<{ name?: string }>
    expect(registry.some((e) => e.name === '墓地正常删')).toBe(false)
    // R35-6：墓地清理已后台化——端点返回不等 rm，轮询墓地终态清空后断言
    //（原 wait 钩子已删；rmSync 在后台任务内同步执行，清空/消失即收尾）
    const graveDir = join(workDir, GRAVEYARD)
    await vi.waitFor(() => {
      expect(existsSync(graveDir) ? readdirSync(graveDir) : []).toEqual([])
    })
  })

  it.skipIf(!permsReliable)('墓地清理失败（权限）：删书仍成功收口、登记移除、副本留档墓地', async () => {
    const name = '墓地清不动'
    const bookAbs = makeRegisteredLongBook(workDir, name)
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
      // R35-6：后台 rm 对 r-x 子目录 unlink EACCES 收尾后断言终态（原 wait 钩子已删，
      // 改 vi.waitFor 轮询；rmSync 同步执行——以「顶层 book.yaml 已越过删除点」为收尾
      // 判据，防 rm 尚未启动时的早退假绿，断言本体零弱化）
      const graveDir = join(workDir, GRAVEYARD)
      let left: string[] = []
      await vi.waitFor(() => {
        left = readdirSync(graveDir)
        expect(left).toHaveLength(1) // 副本留档待手工恢复
        expect(existsSync(join(graveDir, left[0]!, 'book.yaml'))).toBe(false) // rm 已启动
        // rmSync 中断点：顶层 book.yaml 已删，r-x 的 写作/ 子目录连带内容留档
        expect(existsSync(join(graveDir, left[0]!, '写作'))).toBe(true)
        expect(readdirSync(join(graveDir, left[0]!, '写作'))).toContain('正文')
      })
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
      JSON.stringify({
        name: '幽灵登记书',
        path: '长篇/幽灵登记书',
        kind: 'long',
        created_at: '2026-01-01T00:00:00.000Z',
      }) + '\n',
      'utf-8',
    )
    const del = await req('DELETE', `/api/books/${encodeURIComponent('幽灵登记书')}`)
    expect(del.status).toBe(404)
    expect((del.json as { code?: string }).code).toBe('NOT_FOUND')
  })
})

// ── 启动兜底清扫（缺「墓地域无清扫兜底」——清理失败的大书目录（含 .git）永久驻留）──
// 清扫挂点 = 路由装配（server 启动链既有单次调用点），故用一个自建 workDir 先落墓地
// 内容、再起 server，断言装配期清扫的终态；失败臂复用本文件既有的 mac 可复现手法
// （r-x 子目录内 unlink EACCES）。
describe('删书墓地启动兜底清扫', () => {
  // 本 describe 自建 workDir（不复用文件级 studio——清扫挂点在装配期，须先落墓地内容再起 server）
  const sweepTmpDirs: string[] = []
  function mkDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix))
    sweepTmpDirs.push(d)
    return d
  }

  afterAll(() => {
    for (const d of sweepTmpDirs) rmSync(d, { recursive: true, force: true })
  })

  async function bootAt(dir: string): Promise<{ server: Server; baseUrl: string }> {
    const server = await startServerSafe({ port: 0, workDir: dir, mirrorConsoleLog: false })
    return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
  }

  async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  it('装配期扫清墓地：形态匹配的可删目录（含 .git 形态）连根删除；形态不符项不动', async () => {
    const dir = mkDir('clw-grave-sweep-')
    const graveyard = join(dir, GRAVEYARD)
    // 形态匹配：`${Date.now()}-${书目录名}-${ulid}`（含 .git 子树 = 报告所指的大书形态）
    const sweepable = join(graveyard, `${Date.now()}-大书-${ulid()}`)
    mkdirSync(join(sweepable, '.git', 'objects'), { recursive: true })
    writeFileSync(join(sweepable, '.git', 'objects', 'pack'), 'x', 'utf-8')
    // 形态不符（作者手放杂物）：留档
    const handPlaced = join(graveyard, '手工杂物')
    mkdirSync(handPlaced, { recursive: true })

    const { server } = await bootAt(dir)
    try {
      await vi.waitFor(() => expect(existsSync(sweepable)).toBe(false))
      expect(existsSync(handPlaced)).toBe(true) // 形态不符：不碰
    } finally {
      await closeServer(server)
    }
  })

  // 符号链接建不了（win 需开发者模式/管理员，`symlinkSync` 直建 EPERM）时不跑——
  // 该守卫语义由 macOS/Linux CI 腿覆盖；同 test/fs/safe-path-symlink.test.ts 口径。
  it.skipIf(!canSymlink)('装配期清扫不跟随符号链接：链接本体与链接指向的库外真身都不动', async () => {
    const dir = mkDir('clw-grave-sweep-link-')
    const graveyard = join(dir, GRAVEYARD)
    // 形态匹配的符号链接指向书库外真身：不跟随（不删链接、更不删链接指向的目标）
    const outside = join(dir, '库外真身')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.md'), 'keep', 'utf-8')
    const linkPath = join(graveyard, `${Date.now()}-外链书-${ulid()}`)
    symlinkSync(outside, linkPath, 'dir')

    const { server } = await bootAt(dir)
    try {
      expect(existsSync(linkPath)).toBe(true) // 链接本体不动
      expect(readFileSync(join(outside, 'keep.md'), 'utf-8')).toBe('keep') // 未跟随删除
    } finally {
      await closeServer(server)
    }
  })

  it.skipIf(!permsReliable)('清扫失败（只读子树 EACCES）：启动不炸、留痕含路径与原因、副本留档', async () => {
    const dir = mkDir('clw-grave-sweep-fail-')
    const graveyard = join(dir, GRAVEYARD)
    const stuck = join(graveyard, `${Date.now()}-删不掉-${ulid()}`)
    // r-x 子目录内留文件：rm 递归必须先 unlink 它 → EACCES（父目录可写故仅此子项失败）
    mkdirSync(join(stuck, '锁住的子目录'), { recursive: true })
    writeFileSync(join(stuck, '锁住的子目录', '占位.md'), 'x', 'utf-8')
    mkdirSync(join(stuck, '.git'), { recursive: true }) // rm 中断点：顶层已越过、子树留档
    chmodSync(join(stuck, '锁住的子目录'), 0o500)

    const warnSpy = vi.spyOn(log, 'warn')
    let server: Server | null = null
    try {
      const booted = await bootAt(dir) // 清扫失败不阻断启动
      server = booted.server
      const boot = await fetch(`${booted.baseUrl}/api/boot`)
      expect(boot.status).toBe(200) // 服务照常可用
      await vi.waitFor(() => {
        const hit = warnSpy.mock.calls.find((c) => String(c[1]).includes('删书墓地兜底清扫失败'))
        expect(hit).toBeTruthy()
        expect(String(hit![1])).toContain(stuck) // 含路径
        expect(String(hit![1])).toContain('EACCES') // 含原因
      })
      expect(existsSync(stuck)).toBe(true) // 副本留档待手工处理/下次启动重试
    } finally {
      warnSpy.mockRestore()
      if (server) await closeServer(server)
      chmodDirTree(dir) // 还原权限，保临时目录可清
    }
  })

  it('并发清扫同一项幂等（两窗同时启动形态）：rm force 对已消失项 no-op，无异常、零失败计数', async () => {
    const dir = mkDir('clw-grave-sweep-conc-')
    const grave = join(dir, GRAVEYARD, `${Date.now()}-并发-${ulid()}`)
    mkdirSync(join(grave, '写作', '正文'), { recursive: true })
    const [a, b] = await Promise.all([sweepGraveyardOnce(dir), sweepGraveyardOnce(dir)])
    expect(existsSync(grave)).toBe(false)
    expect(a.failed + b.failed).toBe(0)
    expect(a.removed + b.removed).toBeGreaterThanOrEqual(1) // 先到者删净，后到者 no-op
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
