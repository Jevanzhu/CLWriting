/**
 * P2-PROD-2：批量定稿到此章 e2e。
 *
 * 独立 server + 自制长篇 fixture（2 章 revision 态）：
 * 右键第 2 章 → 「批量定稿到此章」→ 弹确认 → 2 章全定稿 → toast + 树节点全绿。
 * 不污染 globalSetup fixture。
 * 端口偏移 15（见 e2e-ports.ts 偏移表），起停样板见 ./independent-server.ts。
 */
import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { attachPageErrorBaseline } from './page-error-baseline.js'
import { startIndependentServer, type IndependentServer } from './independent-server.js'
// R0910-W：临时目录清理走重试封装（Windows 句柄异步收尾的 ENOTEMPTY/EPERM/EBUSY）
import { rmDirRetry } from '../helpers/rm-dir-retry.js'

const BOOK = '批量定稿e2e书'
let srv: IndependentServer
let workDir = ''

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-e2e-batchfin-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 批量定稿e2e书\n  genre: 玄幻\nhost: cc\n',
    'utf8',
  )
  // 2 章正文（manifest 预设旧 finalizedRevision ≠ 当前指纹 → 初始即 revision 态供批量定稿）
  for (const [no, title] of [
    [1, '开篇'],
    [2, '转折'],
  ] as const) {
    writeFileSync(
      join(bookRoot, '写作', '正文', `000${no}-${title}.md`),
      `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文${no}\n`,
      'utf8',
    )
  }
  // manifest 登记 + 旧定稿基线 → revision 态（deriveStatus：finRev 存在且 ≠ 当前指纹）
  const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  for (const [no, title] of [
    [1, '开篇'],
    [2, '转折'],
  ] as const) {
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
  srv = await startIndependentServer({ tag: 'batch-finalize', offset: 15, workDir })
})

test.afterAll(async () => {
  await srv.close()
  rmDirRetry(workDir)
})

test('批量定稿到此章：右键第2章 → 菜单 → 2章全定稿 → toast + 树全绿', async ({ page }) => {
  attachPageErrorBaseline(page, 'batch-finalize')
  await page.goto(`${srv.base}/shelf`)
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
