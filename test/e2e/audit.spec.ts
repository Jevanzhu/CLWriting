/**
 * 审计视图 e2e（hh 评审 §八-10）：进书 → ribbon 开「事件审计」→ 遮蔽差异 模型/人工
 * 模式切换 → 对话/工作流两 tab 的「加载更多」续页。
 *
 * 数据来源约束：e2e globalSetup 起 server 时不传 userDataPath（事件库落址在
 * <userData>/clwriting/session/，无路径即无库）→ audit 端点天然返回空数据，遮蔽
 * 差异与 >500 条分页续页无法靠真实事件触发。故本 spec 用 page.route 截获 audit GET、
 * 按服务端 pageSlice 同语义（offset/limit 切片 + eventsTotal 全量总数）回合成分页
 * 数据；进书/导航/交互仍走真实 UI（同 check.spec / version-restore.spec 模式）。
 */
import { test, expect, type Page, type Route } from '@playwright/test'

const BOOK = '长篇测试书'
/** 总量取 520：首页 500（= 服务端 DEFAULT_PAGE_LIMIT 截断线）+ 次页 20，跨页续页路径必达 */
const TOTAL = 520
const PAGE1 = 500

/** seq → 是否遮蔽（取整50倍数：520 条中 10 条遮蔽，差异两模式行数可预期） */
const isShadowed = (seq: number): boolean => seq % 50 === 0

/** 合成一页事件（与服务端 AuditEvent 同构；type 带 / 顺带覆盖 typeLabel 去前缀展示） */
function synthEvents(fromSeq: number, toSeq: number): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (let seq = fromSeq; seq <= toSeq; seq++) {
    events.push({
      seq,
      sessionId: 'e2e-audit',
      type: 'assistant/message',
      shadowed: isShadowed(seq),
      data: { message: `合成事件 #${seq}` },
    })
  }
  return events
}

/** 全量投影节点（modelVisible = 未遮蔽；humanVisible = 全量含遮蔽，buildAuditView 同构） */
function synthNodes(total: number, onlyVisible: boolean): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = []
  for (let seq = 1; seq <= total; seq++) {
    if (onlyVisible && isShadowed(seq)) continue
    nodes.push({
      seq,
      kind: 'assistant',
      role: 'assistant',
      shadowed: isShadowed(seq),
      preview: `合成节点 #${seq}`,
    })
  }
  return nodes
}

/** 截获 audit GET：按 offset/limit 分页返回合成数据（进书后、开审计视图前装好） */
function stubAudit(page: Page): void {
  void page.route(/\/api\/books\/[^/]+\/audit/, (route: Route) => {
    const u = new URL(route.request().url())
    const offset = Number(u.searchParams.get('offset') ?? '0') || 0
    const limit = Number(u.searchParams.get('limit') ?? '500') || 500
    const to = Math.min(offset + limit, TOTAL)
    void route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        conversation: {
          events: synthEvents(offset + 1, to),
          eventsTotal: TOTAL,
          modelVisible: synthNodes(TOTAL, true),
          humanVisible: synthNodes(TOTAL, false),
          shadowedCount: Math.floor(TOTAL / 50),
        },
        workflowEvents: synthEvents(offset + 1, to),
        workflowTotal: TOTAL,
        goals: [],
        todos: [],
      }),
    })
  })
}

test('审计：进书 → 审计视图 → 遮蔽差异双模式 → 两 tab 加载更多续页', async ({ page }) => {
  stubAudit(page)
  await page.goto('/')
  await page.locator('.book-title', { hasText: BOOK }).click()
  await expect(page.locator('.ws-shell')).toBeVisible()

  // ribbon 开审计视图（data-tip 稳定，同 version-restore 的 .rbtn[data-tip*=…] 模式）
  await page.locator('.rbtn[data-tip*="事件审计"]').click()
  await expect(page.locator('.audit-title')).toHaveText('事件审计')

  // ── 对话 tab（默认）：遮蔽差异头部 + 事件重放首页 ──
  // 默认 diffMode = model：只渲染未遮蔽节点（520 - 10 遮蔽 = 510 行）
  await expect(page.locator('.shadow-hint')).toContainText(`遮蔽 ${Math.floor(TOTAL / 50)}`)
  await expect(page.locator('.diff-row')).toHaveCount(TOTAL - Math.floor(TOTAL / 50))
  await expect(page.locator('.diff-row.shadowed')).toHaveCount(0)

  // 切「人类可见（含遮蔽）」：全量 520 行，遮蔽行带「被遮蔽」标记
  await page.locator('.audit-seg button', { hasText: '人类可见' }).click()
  await expect(page.locator('.diff-row')).toHaveCount(TOTAL)
  await expect(page.locator('.diff-row.shadowed')).toHaveCount(Math.floor(TOTAL / 50))
  await expect(page.locator('.shadowed-mark').first()).toBeVisible()

  // 切回「模型可见」：遮蔽行随投影消失（差异切换真的换了数据源，非仅样式）
  await page.locator('.audit-seg button', { hasText: '模型可见' }).click()
  await expect(page.locator('.diff-row.shadowed')).toHaveCount(0)

  // ── 事件重放：首页 500 条截断 + 「加载更多」跨页补齐 ──
  const replayTitle = page.locator('.sec-title', { hasText: '事件重放' })
  await expect(replayTitle).toContainText(`${PAGE1} / 共 ${TOTAL}`)
  await expect(page.locator('.pager-hint')).toContainText(`已显示 ${PAGE1} / ${TOTAL} 条`)
  await expect(page.locator('.ev-row')).toHaveCount(PAGE1)

  await page.locator('.load-more').click()
  await expect(page.locator('.ev-row')).toHaveCount(TOTAL)
  await expect(replayTitle).toContainText(`事件重放（${TOTAL}）`)
  // 补齐后 hasMore=false → 续页入口消失
  await expect(page.locator('.pager')).toHaveCount(0)

  // ── 工作流 tab：对称的分页续页路径（另一处「加载更多」handler）──
  await page.locator('.tabbar button', { hasText: '工作流链路' }).click()
  const wfSec = page.locator('.sec', { hasText: '工作流事件' })
  await expect(wfSec.locator('.sec-title')).toContainText(`${PAGE1} / 共 ${TOTAL}`)
  await expect(wfSec.locator('.ev-row')).toHaveCount(PAGE1)

  await page.locator('.load-more').click()
  await expect(wfSec.locator('.ev-row')).toHaveCount(TOTAL)
  await expect(wfSec.locator('.sec-title')).toContainText(`工作流事件（${TOTAL}）`)
  await expect(page.locator('.pager')).toHaveCount(0)
})
