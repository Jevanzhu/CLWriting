#!/usr/bin/env node
/**
 * 独立启动 studio API server（port 7878，无静态托管），供 Vite dev 代理。
 *
 * 用法：
 *   npx tsx scripts/dev-api.ts              # 自动找 workDir（cwd 向上）
 *   npx tsx scripts/dev-api.ts --dir /path   # 指定工作目录
 *
 * 配合：
 *   npm run dev:web   # Vite HMR → http://localhost:5173（/api 代理到此 server）
 *
 * 退出：Ctrl+C 停 server。
 */
import { startServer } from '../src/studio/server/index.js'
import { findWorkDir } from '../src/install/books.js'
import { defaultUserDataPath } from '../src/fs/user-data-path.js'
import process from 'node:process'

const PORT = 7878

// --dir 参数
const dirIdx = process.argv.indexOf('--dir')
const explicitDir = dirIdx !== -1 && dirIdx + 1 < process.argv.length ? process.argv[dirIdx + 1] : null

const workDir = explicitDir ?? findWorkDir(process.cwd()) ?? undefined

const userDataPath = defaultUserDataPath()

// RB-SV-P1-1：dev Origin 白名单开关——server 生产态不再固定放行 5173，
// 仅本 dev server 显式开启（Vite 5173 页面经代理调 /api 时带该 Origin）
process.env['CLW_DEV_CORS'] = '1'

const server = startServer({ port: PORT, workDir, userDataPath })

server.on('listening', () => {
  console.log()
  console.log(`  🚀  API server ready  →  http://127.0.0.1:${PORT}`)
  console.log(`  📁  workDir: ${workDir || '未定位（书架为空）'}`)
  console.log(`  🎨  Vite dev:  npm run dev:web  →  http://localhost:5173`)
  console.log()
})

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n  ⏹  Stopping API server…')
  server.close(() => process.exit(0))
})