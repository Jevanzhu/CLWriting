/**
 * R0915-4b（2026-09-15 中件组批，台账行 250「e2e 长尾 4 旅程」处置余量）：启动通告横幅
 * 旅程——「升级向导」的现役产品形态 = 启动自检通告横幅（启动链迁移/书库自愈事件此前
 * 只有 console 失明出口，A4 批 0 落 StartupNoticeBanner；迁移通告随横幅对作者可见）。
 * 行 250 四旅程盘点：导出成品 UI 已由 export-ai-settings.spec.ts 覆盖（P2-TST-7）；
 * 导入旧书 / 备份恢复无产品面（无端点/IPC/组件，0911 时点愿景项——台账行 250 记正）；
 * 本 spec 补横幅实驱：幽灵登记 → boot repairBooks 自愈通告（repair-books，只报告不清除）
 * → 横幅可见 → 「知道了」dismiss 一次性语义（localStorage 指纹 kind@ts，刷新不再弹）。
 *
 * 独立 server（usage-card R76-10 同款）：需自有 workDir 播种幽灵登记，共享面不可污染。
 * 端口偏移 5（e2e-ports.ts 偏移表随批登记）。
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { makeDualTrackWorkdir } from '../studio/fixtures.js'
import { e2ePort } from './e2e-ports.js'
import { attachPageErrorBaseline } from './page-error-baseline.js'
// R0910-W：临时目录清理走重试封装（Windows 句柄异步收尾的 ENOTEMPTY/EPERM/EBUSY）
import { rmTempDirRetry } from './tmp-cleanup.js'

const PORT = e2ePort(5)
const BASE = `http://127.0.0.1:${PORT}`
let server: http.Server
let workDir = ''

test.beforeAll(async () => {
  workDir = makeDualTrackWorkdir()
  // 幽灵登记：指向不存在目录的条目 → boot repairBooks changed=true + 缺失通告
  // （R35-28：自愈只报告不清除，通告带回可操作提示——横幅消费的正是这条）
  appendFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: '幽灵旧书', path: '旧书库/幽灵旧书', kind: 'long' }) + '\n',
  )
  server = startServer({ port: PORT, workDir, staticDir: join(process.cwd(), 'dist', 'web') })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    // R51-J-6：EADDRINUSE 人话提示（usage-card R64-40 口径同款）
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[e2e startup-notices] 端口 ${PORT} 已被占用——通常是上一次 e2e 未退干净或本地 dev 服务抢占。\n` +
            `排查：lsof -i :${PORT} 查占用进程并 kill 后重跑。`,
        )
      }
      // R9-P2-4：listen 失败不留残——先清本次自建目录再上抛
      if (workDir) rmTempDirRetry(workDir)
      reject(err)
    })
  })
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (workDir) rmTempDirRetry(workDir)
})

test('启动通告横幅：幽灵登记 → boot 自愈通告 → 横幅可见（repair-books）', async ({ page }) => {
  attachPageErrorBaseline(page, 'startup-notices')
  await page.goto(`${BASE}/`)
  const banner = page.locator('.sn-banner')
  await expect(banner).toBeVisible()
  // 通告条数与来源 kind（机器可判别面）；自愈文案含缺失计数（幽灵条目未被清除）
  await expect(banner).toContainText('启动自检发现 1 条通告')
  await expect(banner.locator('.sn-kind')).toHaveText('repair-books')
  await expect(banner.locator('.sn-msg')).toContainText('缺失 1 条')
})

test('横幅一次性：「知道了」→ 刷新后同批通告不再提示（localStorage 指纹）', async ({ page }) => {
  attachPageErrorBaseline(page, 'startup-notices')
  await page.goto(`${BASE}/`)
  const banner = page.locator('.sn-banner')
  await expect(banner).toBeVisible()
  await banner.locator('.sn-close').click()
  await expect(banner).toBeHidden()
  // 一次性语义：指纹（kind@ts）落 localStorage，刷新（新通告未增）横幅不再出现
  await page.reload()
  await expect(page.locator('.sn-banner')).toHaveCount(0)
})
