/**
 * P1-01 端到端：保存失败时离书必须走可见决断，不得静默丢弃或静默离书。
 *
 * 修复前形态：`/book/A → /shelf` 是路由记录切换，Book 卸载后切书守卫的 watch 随之停止，
 * 「脏路由」分支（要求 Book 仍挂载且 bookName 变 ''）在该路径不可达——于是离书时既无弹窗
 * 也无回滚，只有 `[Book] 卸载时 N 个文档保存失败` 的 console.warn。
 *
 * 修复后：`useBookSwitchGuard` 增加提交前的 `onBeforeRouteLeave`，离书前先冲刷与决断——
 * 作者取消 → 导航中止、路由与各 store 原封；确认丢弃 → 落离书状态转移再放行（崩溃镜像随之
 * 清除，与切书同口径）。
 *
 * 造错手法：`page.route` 拦截保存端点返回 500——生产代码零改动缝，测真实网络失败分支。
 * 独立 server（偏移 12，起停样板见 ./independent-server.ts）：本 spec 制造失败态，
 * 迁独立 workDir 避免污染共享 server 的顺序契约。
 */
import { test, expect, type Page } from '@playwright/test'
import { attachPageErrorBaseline } from './page-error-baseline.js'
import { startIndependentServer, type IndependentServer } from './independent-server.js'

let srv: IndependentServer

/** 保存端点（`PUT /api/books/:name/documents/:docId/content`）——见 src/studio/web-next/src/api/documents.ts 的 saveContent。 */
const SAVE_ENDPOINT = '**/api/books/*/documents/*/content'
/** 崩溃镜像键前缀（src/studio/web-next/src/shared/dirty-mirror.ts）。 */
const MIRROR_PREFIX = 'clw:dirty-mirror:'

let saveIntercepted = 0

/** 让保存端点恒失败（造「保存失败仍 dirty」形态）。 */
async function failSave(page: Page): Promise<void> {
  saveIntercepted = 0
  await page.route(SAVE_ENDPOINT, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    saveIntercepted++
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"INTERNAL"}' })
  })
}

/** 命令面板「返回书架」——客户端路由切换（非整页刷新），即离书导航。 */
async function backToShelfViaPalette(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+p')
  await page.locator('.palette-input').fill('书架')
  await page.locator('.palette-item', { hasText: '返回书架' }).click()
}

/** 当前存的崩溃镜像键（离书写前是否还有本地兜底）。 */
function mirrorKeys(page: Page): Promise<string[]> {
  return page.evaluate((prefix) => {
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) out.push(k)
    }
    return out
  }, MIRROR_PREFIX)
}

test.beforeAll(async () => {
  srv = await startIndependentServer({ tag: 'unsaved-leave-guard', offset: 12, userDataPath: false })
})

test.afterAll(async () => {
  await srv.close()
})

test('保存失败时离书：先弹决断；留在本书则编辑与镜像原封，确认丢弃才离书并清镜像', async ({ page }) => {
  attachPageErrorBaseline(page, 'unsaved-leave-guard')
  const content = page.locator('.cm-content')
  const dialog = page.locator('.cp-modal')
  const typed = '未落盘的离书守卫验证'
  const bookA = /book\/%E9%95%BF%E7%AF%87/ // 「长篇测试书」的 URL 编码前缀

  // ① 开书 → 进章节编辑器（fixture 双轨书：长篇 4 章，首章「初入宗门」）
  await page.goto(`${srv.base}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  await expect(content).toBeVisible({ timeout: 20_000 })

  // ② 先让保存恒失败，再键入——之后的任何落盘（含离书冲刷）都拿不到 2xx
  await failSave(page)
  await content.click()
  await page.keyboard.type(typed)
  // 镜像写侧是 2s 节流（dirty-mirror 的 MIRROR_THROTTLE_MS）——等它落一次再离书，
  // 否则「取消后镜像原封」测的只是「还没写」，不是兜底本身
  await expect
    .poll(async () => (await mirrorKeys(page)).some((k) => k.includes('长篇测试书')), { timeout: 10_000 })
    .toBe(true)

  // ③ 离书 → 必须在导航提交前弹决断（修复前此处零提示、直接离开）
  await backToShelfViaPalette(page)
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(dialog.locator('.cp-title')).toContainText('保存失败')
  await expect(dialog.locator('.cp-body')).toContainText('永久丢弃')
  expect(saveIntercepted).toBeGreaterThan(0) // 造错手法自证：离书确实打到了保存端点

  // ④ 留在本书 → 路由未提交、编辑器仍在、键入与镜像都在（零状态变更）
  await dialog.locator('.btn', { hasText: '留在本书' }).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(bookA)
  await expect(content).toBeVisible({ timeout: 20_000 })
  await expect(content).toContainText(typed)
  expect((await mirrorKeys(page)).some((k) => k.includes('长篇测试书'))).toBe(true)

  // ⑤ 再离书并确认丢弃 → 离书生效：路由到书架，崩溃镜像随离书清理（不再陈旧复活）
  await backToShelfViaPalette(page)
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await dialog.locator('.btn', { hasText: '丢弃并切换' }).click()
  await expect(page).toHaveURL(/\/shelf/)
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await mirrorKeys(page)).length, { timeout: 10_000 }).toBe(0)

  // ⑥ 再进书不再二次追问（已决断过的编辑不应重复弹窗）
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await expect(page.getByText('初入宗门').first()).toBeVisible({ timeout: 20_000 })
  await expect(dialog).toBeHidden()
})
