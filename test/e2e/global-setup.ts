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
import { rmSync } from 'node:fs'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'
import { E2E_PORT_BASE } from './e2e-ports.js'

let server: http.Server | undefined

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env['CLWRITING_DRIVER'] = 'mock'
  const workDir = makeDualTrackWorkdir()
  // 暴露给 spec：T1.3 冲突测需外部直接改磁盘文件触发 REVISION_CONFLICT
  process.env['CLWRITING_E2E_WORKDIR'] = workDir
  server = startServer({
    // R73-75（批 F-8）：端口族基址派生（CLW_E2E_PORT_BASE，缺省 18999 = 旧硬编码；
    // 各独立 server spec 同基址偏移，见 test/e2e/e2e-ports.ts 偏移表）
    port: E2E_PORT_BASE,
    workDir,
    staticDir: join(process.cwd(), 'dist', 'web'),
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', () => resolve())
      // X-36③：固定端口被占时给指因的人话提示（裸 EADDRINUSE 只留栈看不出该查谁）。
      // startServer 由调用方管 error（见其头注），这里补监听后 reject 让 globalSetup 明确失败。
      server!.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // MP2-11（专项重评二轮顺修）：排障提示补 win 分支——只给 lsof 在 win 上是死指引
          const probe =
            process.platform === 'win32'
              ? `netstat -ano | findstr :${E2E_PORT_BASE} 查占用 PID 后 taskkill /PID <pid> /F`
              : `lsof -i :${E2E_PORT_BASE} 查占用进程并 kill`
          console.error(
            `[e2e global-setup] 端口 ${E2E_PORT_BASE} 已被占用——通常是上一次 e2e 未退干净，或本地有 dev 服务占了同端口。\n` +
              `排查：${probe}，或停掉本地 dev:api/dev:web 后重跑；` +
              `整族端口被争用时可用 CLW_E2E_PORT_BASE=<基址> 整套平移（R73-75）。`,
          )
        }
        reject(err)
      })
    })
  } catch (err) {
    // R27-124（二十七轮）：启动失败路径此前只 reject 不清理——workDir（fixtures 双轨书仓）
    // 已落盘，而删除只挂在成功路径的 teardown（X-31），EADDRINUSE 等监听失败会把整个
    // workDir 泄漏在系统 tmp；此处对齐成功路径「用完即删」口径，抛错前先收走。
    rmSync(workDir, { recursive: true, force: true })
    throw err
  }
  return async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    // X-31：对齐 release-smoke 的删除口径——临时 workDir 用完即删（此前只 close 不删，
    // 泄漏在系统 tmp 目录）
    rmSync(workDir, { recursive: true, force: true })
  }
}
