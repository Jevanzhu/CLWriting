/**
 * M-10（第八轮）回归：启动迁移链逐书 try/catch——单本书目录权限故障不炸整个服务。
 *
 * 修复背景：migrateLayoutV3 的 readdirSync、migrateLayoutV2 的 mkdirSync、
 * migrateLegacyForeshadows 的 atomicWriteFile 等抛出点未收编，server/index.ts 的
 * 逐书迁移循环无 per-book 防护——备份恢复/同步盘场景下一本书 EACCES 即全部书不可用。
 * 本测试锁一件事：注册一本「写作/草稿 存在但不可读」的坏书 + 一本好书 → startServer
 * 正常 listen（坏书降级告警，好书不受影响）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const GOOD = '正常书'
const BAD = '坏书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-migrate-res-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-migrate-res-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    [GOOD, BAD].map((n) => JSON.stringify({ name: n, path: n, kind: 'long' })).join('\n') + '\n',
  )
  for (const n of [GOOD, BAD]) {
    mkdirSync(join(workDir, n), { recursive: true })
    writeFileSync(join(workDir, n, 'book.yaml'), `spec_version: 1\nkind: long\nbook:\n  title: ${n}\n  genre: 玄幻\nhost: cc\n`)
  }
  // 坏书：写作/草稿 存在但不可读——migrateLayoutV3 的 readdirSync 在 existsSync 之后裸抛
  mkdirSync(join(workDir, BAD, '写作', '草稿'), { recursive: true })
  chmodSync(join(workDir, BAD, '写作', '草稿'), 0o000)

  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  chmodSync(join(workDir, BAD, '写作', '草稿'), 0o755)
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('M-10: 启动迁移链逐书容错', () => {
  // Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），EACCES 迁移故障腿由 macOS/Linux CI 覆盖
  it.skipIf(process.platform === 'win32')('一本书迁移抛错（EACCES）→ 服务照常启动，另一本书可用', async () => {
    expect(server?.listening).toBe(true)
    // 好书正常解析（注册表 + 目录完好在册）
    const r = await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/boot`)
    expect(r.status).toBe(200)
  })
})
