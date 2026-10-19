/**
 * P1-01 端到端：保存失败时离书 / 再进书的可见面与兜底链（真实导航时序）。
 *
 * 审计 P1-01 原判：从 `/book/A` 离书到脏路由（`/shelf`）时 `flushDirty()` 失败只
 * `console.warn`，随后 `doc.setBook('')` 清崩溃镜像 → 未落盘编辑永久丢失且零提示。
 *
 * 本档钉的是**修复后真实可达的行为链**（不是设计意图）：
 * ① 离书到 `/shelf`：Book 组件卸载，切书守卫的 `watch(bookName)` 随实例销毁——
 *    「脏路由」分支在 `/book → /shelf` 这条真实导航上不会执行（Book 与 Shelf 是不同
 *    路由组件）。可见面为零，但 **崩溃镜像保留**（未执行 `setBook('')`，故不清镜像）。
 * ② 再进任一本书：守卫以「重挂进书」路径运行——`prevBook` 取 doc store 的权威书
 *    （应用级单例，离书时未被清）→ 检出保存失败 → 弹「有 N 个文档保存失败」决断。
 * ③ 选「留在本书」→ 回退原书路由，编辑内容仍在（镜像 + 内存双兜底）。
 *
 * 造错手法：`page.route` 拦截保存端点返回 500——生产代码零改动缝，测的是真实网络
 * 失败分支（不用内部测试钩子，避免「只在测试形态成立」的假证据）。
 *
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

/** 命令面板「返回书架」——客户端路由切换（非整页刷新）。 */
async function backToShelfViaPalette(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+p')
  await page.locator('.palette-input').fill('书架')
  await page.locator('.palette-item', { hasText: '返回书架' }).click()
}

/** 当前存的崩溃镜像键（离书后是否保留 = 编辑是否还有本地兜底）。 */
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

test('保存失败时离书到书架：镜像保留（编辑不丢）；再进书才弹决断，选「留在本书」编辑仍在', async ({ page }) => {
  attachPageErrorBaseline(page, 'unsaved-leave-guard')
  const content = page.locator('.cm-content')
  const dialog = page.locator('.cp-modal')
  const typed = '未落盘的离书守卫验证'

  // ① 开书 → 进章节编辑器（fixture 双轨书：长篇 4 章，首章「初入宗门」）
  await page.goto(`${srv.base}/`)
  await page.locator('.book-title', { hasText: '长篇测试书' }).click()
  await page.getByText('初入宗门').first().click()
  await expect(content).toBeVisible({ timeout: 20_000 })

  // ② 先让保存恒失败，再键入——之后的任何落盘（含离书冲刷）都拿不到 2xx
  await failSave(page)
  await content.click()
  await page.keyboard.type(typed)
  // 镜像写侧是 2s 节流（dirty-mirror 的 MIRROR_THROTTLE_MS）——等它落一次，
  // 否则离书时镜像尚未写入，「离书不丢」这条断言测的就不是兜底本身
  await expect
    .poll(async () => (await mirrorKeys(page)).some((k) => k.includes('长篇测试书')), { timeout: 10_000 })
    .toBe(true)

  // ③ 离书到书架：真实时序下 Book 卸载，切书守卫的 watch 无人接管该分支
  //    → 此处零决断窗（守卫的「脏路由」分支在 /book → /shelf 上不可达）
  await backToShelfViaPalette(page)
  await expect(page).toHaveURL(/\/shelf/)
  await expect(dialog).toBeHidden()
  // 兜底不丢：崩溃镜像仍在（旧形态 setBook('') 会把它清掉——这条即「永久丢失」的反向钉）
  expect(saveIntercepted).toBeGreaterThan(0) // 造错手法自证：本次离书确实打到保存端点
  const keysOnShelf = await mirrorKeys(page)
  expect(keysOnShelf.some((k) => k.includes('长篇测试书'))).toBe(true)

  // ④ 再进另一本书：守卫按「重挂进书」路径运行，prevBook 取 doc store 权威书（未被清）
  //    → 检出保存失败并弹决断
  await page.locator('.book-title', { hasText: '短篇测试集' }).click()
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(dialog.locator('.cp-title')).toContainText('保存失败')
  await expect(dialog.locator('.cp-body')).toContainText('永久丢弃')

  // ⑤ 选「留在本书」→ 回退原书路由，未落盘编辑仍可继续处理
  await dialog.locator('.btn', { hasText: '留在本书' }).click()
  await expect(page).toHaveURL(/book\/%E9%95%BF%E7%AF%87/, { timeout: 20_000 })
  await expect(dialog).toBeHidden()
  await page.getByText('初入宗门').first().click()
  await expect(content).toBeVisible({ timeout: 20_000 })
  await expect(content).toContainText(typed)
})
