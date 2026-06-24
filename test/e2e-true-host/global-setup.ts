import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'

let server: http.Server | undefined

export default async function globalSetup(): Promise<() => Promise<void>> {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  if (version.status !== 0) {
    throw new Error(`真宿主 smoke 需要可执行的 claude CLI:${version.stderr || version.error?.message || 'not found'}`)
  }

  // 显式退出默认 mock e2e 的环境开关，确保 getDriver() 选择 ccDriver。
  delete process.env['CLWRITING_DRIVER']

  const workDir = makeDualTrackWorkdir()
  server = startServer({
    port: 19001,
    workDir,
    staticDir: join(process.cwd(), 'dist', 'web'),
  })
  await new Promise<void>((resolve) => {
    server!.once('listening', () => resolve())
  })
  return async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
}
