// @vitest-environment happy-dom
/**
 * R44-20（四十四轮）回归：标题提交在途排队续提——保存进行中（updateChapterMetaDoc +
 * 大书 tree.load 可达秒级）的二次修改此前被 `if (titleSaving) return` 静默丢弃
 *（收尾 titleEditing=false 后父层 watch 把 titleModel 回写为已落盘旧标题）。
 * 修复：在途 blur/Enter 记 pending，当前保存收尾（finally）自动续提同一保存链。
 *
 * 手法沿用 f2-title-editing-guard.test.ts：挂 EditorView（含顶栏 EditorDocHead），
 * updateChapterMetaDoc 用可控 deferred 挂起第一次提交，模拟在途窗口。
 *
 * R45-1（四十五轮）：固定轮数时序泵在全量并发高负载下偶发「少调/once 串位」红——
 * 改 vi.waitFor 确定性 settle 等待（getContent 总调用数 + refresh 落盘值），
 * beforeEach 升级为清 once 队列的 mockReset；三用例断言语义与意图不变。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: mocks.updateChapterMetaDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: vi.fn(async () => ({ kind: 'long' })),
  getTree: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => null),
}))
// CM6 与标题链路无关，stub 掉保持测试轻量
vi.mock('../../../src/studio/web-next/src/editor/CmHost.vue', () => ({
  default: { name: 'CmHost', template: '<div class="cm-host-stub" />' },
}))

import EditorView from '../../../src/studio/web-next/src/views/EditorView.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'
const NODE: TreeNode = {
  path: '写作/正文/0001-x.md',
  name: '0001-x.md',
  isDirectory: false,
  role: 'chapter',
  docId: 'd1',
  status: 'draft',
  children: [],
} as TreeNode

const FM_OLD = '---\n标题: 旧标题\n---\n\n正文'
// R45-1（四十五轮）：once 队列值与 settle 落盘比对两处同串，提为常量防漂移
const FM_FIRST = '---\n标题: 第一次标题\n---\n\n正文'
const FM_SECOND = '---\n标题: 第二次标题\n---\n\n正文'
const FM_NEW = '---\n标题: 新标题\n---\n\n正文'

beforeEach(() => {
  setActivePinia(createPinia())
  // R45-1（四十五轮）：clearAllMocks 只清调用记录、不清 mockResolvedValueOnce 队列，
  // 上一用例未消费完的 once 值会串到本用例被消费（偶发红根因②）。升级为逐个
  // mockReset（清调用记录 + once 队列 + 实现）；不 vi.resetAllMocks 全局复位，避免
  // 波及 vi.mock 工厂里 books/client 带实现的 mock。复位先于默认实现设置，顺序不可倒。
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.getContent.mockResolvedValue(FM_OLD)
  mocks.updateChapterMetaDoc.mockResolvedValue({ ok: true })
})

/** 泵宏任务 + 微任务：refresh 内 sha256Revision 跨宏任务（WebCrypto），提交链收尾
 *  落定需多拍；一次续提链叠一层，默认给足两链余量。
 *  R45-1（四十五轮）：废止上式固定轮数泵（setTimeout(0)+flushPromises×6）——全量
 *  并发高负载下偶发「少调」（链未在固定轮数内收尾，调用次数断言早跑）。改为确定性
 *  settle 等待。getContent 每链实数（doc.ts）：doc.open 消费 1 次（doOpen L138）；
 *  每条提交链 onTitleCommit 收尾 doc.refresh 恰消费 1 次（refresh L315；tree.load 已
 *  spy 不发请求）——settle 信号取「getContent 总调用数到预期 + refresh 落盘值已写入
 *  store」（调用发起≠链收尾，写入在其后若干微任务）。waitFor 等到 settle 天然消费完
 *  本用例排入的全部 once 值，与 beforeEach 的 mockReset 双保险杜绝串场。 */
async function waitChainSettled(
  doc: ReturnType<typeof useDocStore>,
  totalGetContent: number,
  settledFm: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(mocks.getContent).toHaveBeenCalledTimes(totalGetContent)
      expect(doc.get('d1')?.content).toBe(settledFm)
    },
    // R45-1：超时给足 5s——全量并发下 150ms 标题防抖 + WebCrypto + 负载漂移留余量
    { timeout: 5000, interval: 25 },
  )
}

describe('R44-20（四十四轮）：标题提交在途二次修改排队续提', () => {
  it('①在途时二次修改 → 完成后自动续提，最终标题为二次值（数据不丢）', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    doc.setBook(BOOK)
    await doc.open(NODE) // 此处消费默认 getContent（旧标题）
    useWorkspaceStore().activeDocId = 'd1' // 标题提交入口的前置条件（dd-P2 守卫读它）

    // 两条续链各自的 refresh 对齐值按到达序排入队列
    mocks.getContent.mockResolvedValueOnce(FM_FIRST)
    mocks.getContent.mockResolvedValueOnce(FM_SECOND)
    // 第一次提交挂起（updateChapterMetaDoc 在途），模拟大书 tree.load 秒级窗口
    let resolveMeta1!: (r: unknown) => void
    mocks.updateChapterMetaDoc.mockImplementationOnce(
      () => new Promise((r) => { resolveMeta1 = r }),
    )
    mocks.updateChapterMetaDoc.mockResolvedValueOnce({ ok: true }) // 续提链即刻成功

    const w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()
    expect(w.find('.page-title').text()).toBe('旧标题')

    // 第一次修改 → blur 提交（在途挂起）
    const input = w.find('input.bar-title')
    await input.trigger('focus')
    await input.setValue('第一次标题')
    await input.trigger('blur')
    await flushPromises()
    expect(mocks.updateChapterMetaDoc).toHaveBeenCalledTimes(1)

    // 在途窗口内二次修改 → blur：修复前此处被静默丢弃
    await input.trigger('focus')
    await input.setValue('第二次标题')
    await input.trigger('blur')
    await flushPromises()
    expect(mocks.updateChapterMetaDoc).toHaveBeenCalledTimes(1) // 仍在途，续提未发起
    // 编辑守卫仍生效：在途收尾前输入值不被回写覆盖（不闪回已落盘旧标题）
    expect(w.find('.page-title').text()).toBe('第二次标题')

    // 第一次保存完成（meta + tree.load + refresh 链收尾）→ 自动续提二次值
    resolveMeta1({ ok: true })
    // R45-1（四十五轮）：先等「自动续提」契约本身——首链收尾自动发起第二次提交
    await vi.waitFor(() => expect(mocks.updateChapterMetaDoc).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    })
    // R45-1（四十五轮）：续提链收尾 settle（getContent 总数 3 = open 1 + 首链 refresh 1
    // + 续提 refresh 1，且第二次标题已落 store）后方可 patch——竞态：patch 若落在续提
    // refresh 写入前，在途 refresh 会用第二次标题覆盖 patch 写入的第三次标题，下方 waitFor 永假
    await waitChainSettled(doc, 3, FM_SECOND)

    expect(mocks.updateChapterMetaDoc).toHaveBeenCalledTimes(2)
    expect(mocks.updateChapterMetaDoc).toHaveBeenLastCalledWith(
      BOOK, 'd1', expect.objectContaining({ 标题: '第二次标题' }),
    )
    expect(w.find('.page-title').text()).toBe('第二次标题')

    // 续提链收尾后编辑态解除，父层回写守卫恢复正常
    doc.patch('d1', '---\n标题: 第三次标题\n---\n\n正文')
    await flushPromises()
    await vi.waitFor(() => expect(w.find('.page-title').text()).toBe('第三次标题')) // R46-5（四十六轮）契约演进：标题 fm 解析 150ms 防抖，回写断言改 waitFor
    w.unmount()
  })

  it('②在途时未再修改 → 完成后无多余续提请求', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    doc.setBook(BOOK)
    await doc.open(NODE)
    useWorkspaceStore().activeDocId = 'd1'
    mocks.getContent.mockResolvedValueOnce(FM_NEW)

    let resolveMeta1!: (r: unknown) => void
    mocks.updateChapterMetaDoc.mockImplementationOnce(
      () => new Promise((r) => { resolveMeta1 = r }),
    )

    const w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()

    const input = w.find('input.bar-title')
    await input.trigger('focus')
    await input.setValue('新标题')
    await input.trigger('blur') // 唯一一次提交；此后不再碰输入框
    await flushPromises()

    resolveMeta1({ ok: true })
    // R45-1（四十五轮）：链收尾 settle（getContent 总数 2 = open 1 + 本链 refresh 1，
    // 新标题已落 store）——收尾确定性到齐后再断言「无续提」，替代固定轮数泵
    await waitChainSettled(doc, 2, FM_NEW)

    // 无 pending → 不续提（updateChapterMetaDoc 仅首次那一次）
    expect(mocks.updateChapterMetaDoc).toHaveBeenCalledTimes(1)
    expect(w.find('.page-title').text()).toBe('新标题')
    w.unmount()
  })

  it('③在途时 blur 但 pending 与已落盘同值 → 续提链内「未变化」早退，不发请求', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    vi.spyOn(tree, 'load').mockResolvedValue(undefined)
    doc.setBook(BOOK)
    await doc.open(NODE)
    useWorkspaceStore().activeDocId = 'd1'
    mocks.getContent.mockResolvedValueOnce(FM_NEW)

    let resolveMeta1!: (r: unknown) => void
    mocks.updateChapterMetaDoc.mockImplementationOnce(
      () => new Promise((r) => { resolveMeta1 = r }),
    )

    const w = mount(EditorView, { props: { docId: 'd1' } })
    await flushPromises()

    const input = w.find('input.bar-title')
    await input.trigger('focus')
    await input.setValue('新标题')
    await input.trigger('blur')
    await flushPromises()

    // 在途窗口内再 focus→未改值→blur：pending=新标题，与即将落盘的值相同
    await input.trigger('focus')
    await input.setValue('新标题')
    await input.trigger('blur')
    await flushPromises()

    resolveMeta1({ ok: true })
    // R45-1（四十五轮）：链收尾 settle（getContent 总数 2 = open 1 + 本链 refresh 1；
    // 续提早退不补调用）——收尾确定性到齐后再断言次数与标题，替代固定轮数泵
    await waitChainSettled(doc, 2, FM_NEW)

    // 续提链发起但命中 newTitle === current 早退 → 无第二次 updateChapterMetaDoc
    expect(mocks.updateChapterMetaDoc).toHaveBeenCalledTimes(1)
    expect(w.find('.page-title').text()).toBe('新标题')

    // 早退路径也脱离编辑态（守卫恢复）
    doc.patch('d1', '---\n标题: 外部改的标题\n---\n\n正文')
    await flushPromises()
    await vi.waitFor(() => expect(w.find('.page-title').text()).toBe('外部改的标题')) // R46-5（四十六轮）契约演进：标题 fm 解析 150ms 防抖，回写断言改 waitFor
    w.unmount()
  })
})
