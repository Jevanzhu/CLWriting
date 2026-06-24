/**
 * e2e globalSetup（#13.1）：起 studio server（mock driver + 双轨 fixture + dist/web）。
 *
 * - 设 CLWRITING_DRIVER=mock（driver/index.ts getDriver 读 env → mockDriver，不调大模型）
 * - 用 fixtures.ts 造双轨工作目录（长/短篇书仓库）
 * - startServer 固定端口 18999 + 静态托管 dist/web（前端 SPA）
 * - 返回 teardown 关 server
 *
 * 前置：dist/web 已 build（npm run test:e2e 先 build:web）。
 */
import http from 'node:http'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'

let server: http.Server | undefined

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env['CLWRITING_DRIVER'] = 'mock'
  const workDir = makeDualTrackWorkdir()
  server = startServer({
    port: 18999,
    workDir,
    staticDir: join(process.cwd(), 'dist', 'web'),
  })
  await new Promise<void>((resolve) => {
    server!.once('listening', () => resolve())
  })
  return async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
  }
}
