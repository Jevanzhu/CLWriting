/**
 * P2-PROD-2：批量定稿到此章 e2e。
 *
 * 独立 server + 自制长篇 fixture（2 章 revision 态）：
 * 右键第 2 章 → 「批量定稿到此章」→ 弹确认 → 2 章全定稿 → toast + 树节点全绿。
 * 不污染 globalSetup fixture。
 */
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../../src/studio/server/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const PORT = 19014
const BASE = `http://127.0.0.1:${PORT}`
const BOOK = '批量定稿e2e书'
let server: http.Server
let workDir = ''
let userDataPath = ''

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-e2e-batchfin-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 批量定稿e2e书\n  genre: 玄幻\nhost: cc\n', 'utf8')
  // 2 章正文（manifest 预设旧 finalizedRevision ≠ 当前指纹 → 初始即 revision 态供批量定稿）
  for (const [no, title] of [[1, '开篇'], [2, '转折']] as const) {
    writeFileSync(join(bookRoot, '写作', '正文', `000${no}-${title}.md`), `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文${no}\n`, 'utf8')
  }
  // manifest 登记 + 旧定稿基线 → revision 态（deriveStatus：finRev 存在且 ≠ 当前指纹）
  const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  for (const [no, title] of [[1, '开篇'], [2, '转折']] as const) {
    upsertEntry(m, {
      id: generateDocId(),
      nodeType: 'document',
      path: `写作/正文/000${no}-${title}.md`,
      parentId: null,
      finalizedRevision: `sha256:stale-baseline-${no}`,
      finalizedAt: '2026-08-01T00:00:00.000Z',
    })
  }
  writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-e2e-batchfin-ud-'))
  server = startServer({ port: PORT, workDir, userDataPath, staticDir: join(process.cwd(), 'dist', 'web') })
  await new Promise<void>((r, reject) => {
    server.once('listening', () => r())
    // R64-40（十二轮）：固定端口被占给指因人话提示（X-36③ global-setup 同款——
    // 环境争用时裸 EADDRINUSE 栈难排查）
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[e2e batch-finalize] 端口 ${PORT} 已被占用——通常是上一次 e2e 未退干净或本地 dev 服务抢占。\n` +
            `排查：lsof -i :${PORT} 查占用进程并 kill 后重跑。`,
        )
      }
      reject(err)
    })
  })
})

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

test('批量定稿到此章：右键第2章 → 菜单 → 2章全定稿 → toast + 树全绿', async ({ page }) => {
  await page.goto(`${BASE}/shelf`)
  await page.locator('.book-title', { hasText: BOOK }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // 树出现 2 章（revision 态，dot-red）
  const row1 = page.locator('.tree-item').filter({ hasText: '开篇' }).first()
  const row2 = page.locator('.tree-item').filter({ hasText: '转折' }).first()
  await expect(row1.locator('.dot.dot-red')).toBeVisible()
  await expect(row2.locator('.dot.dot-red')).toBeVisible()

  // 右键第 2 章 → 菜单出现「批量定稿到此章」（2 个待定稿章 → length>1）
  await row2.click({ button: 'right' })
  const menu = page.locator('.ctx-menu, .native-menu, [role="menu"]').first()
  await expect(menu).toBeVisible()
  await expect(menu.getByText('批量定稿到此章')).toBeVisible()

  // 点批量定稿 → toast「已定稿 2/2 章」
  await menu.getByText('批量定稿到此章').click()
  await expect(page.getByText(/已定稿 2\/2 章/)).toBeVisible({ timeout: 10_000 })

  // 两章节点回 final（dot-green）
  await expect(row1.locator('.dot.dot-green')).toBeVisible({ timeout: 10_000 })
  await expect(row2.locator('.dot.dot-green')).toBeVisible({ timeout: 10_000 })
})
