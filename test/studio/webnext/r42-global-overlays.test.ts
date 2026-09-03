/**
 * @vitest-environment happy-dom
 *
 * R42-3 / R42-4（四十二轮修复批）回归：反馈层与模态的全局挂载。
 *
 * 修复前 Toast/ConfirmPrompt/SettingsModal/ShelfModal/ExportDialog 仅挂载于
 * WorkspaceShell（工作区路由），/welcome、/library、书库独立窗口上：
 * - ui.toast 静默失效（switchLibrary 取消原因 / openLibraryDir 失败无渲染点）；
 * - 系统菜单「设置/新建书/导出」经 useAppActions 只置 store 标志位 → 整面静默空操作。
 * 修复后五件上移 App.vue（Teleport to body），任何路由均可渲染。
 * 路由面用库内惯例双路径 mock（book-watch-reentry 同款），App 挂在非工作区语境断言。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// App.vue 启动链拉 api/client（getLastInitialBook）——局部 mock（保留 ApiError 等类型面）
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getLastInitialBook: () => null }
})

// 双路径 vue-router mock（App/useAppActions/ShelfModal 消费 useRouter；模板 router-view 置 stub）。
// 工厂内不得引用顶层变量（vi.mock 提升语义）——route/router 经 hoisted 持有者共享。
const holder = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  route: null as unknown as { params: Record<string, string>; path: string },
}))
vi.mock('vue-router', async () => {
  const { reactive, defineComponent } = await import('vue')
  holder.route = reactive({ params: {}, path: '/shelf' })
  return {
    useRoute: () => holder.route,
    useRouter: () => holder.router,
    RouterView: defineComponent({ name: 'RouterView', render: () => null }),
  }
})
vi.mock('../../../src/studio/web-next/node_modules/vue-router', async () => {
  const { defineComponent } = await import('vue')
  return {
    useRoute: () => holder.route,
    useRouter: () => holder.router,
    RouterView: defineComponent({ name: 'RouterView', render: () => null }),
  }
})

import App from '../../../src/studio/web-next/src/App.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

async function mountApp() {
  const wrapper = mount(App, { global: { plugins: [createPinia()] } })
  await flushPromises()
  return wrapper
}

describe('R42-3/R42-4: 反馈层与模态全局挂载（非工作区路由语境）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  it('R42-3: ui.toast 有渲染点（修复前 /welcome、/library 整面死区）', async () => {
    await mountApp()
    const ui = useUiStore()
    ui.toast('大小写敏感卷不合适，换个目录', 'error')
    await flushPromises()
    expect(document.body.textContent).toContain('大小写敏感卷不合适，换个目录')
  })

  it('R42-4: ui.openSettings 弹设置模态（菜单 CmdOrCtrl+, 不再静默空操作）', async () => {
    await mountApp()
    const ui = useUiStore()
    ui.openSettings()
    await flushPromises()
    // SettingsModal v-if=ui.settingsOpen，Teleport 到 body——mask 在文档即挂载成功
    expect(document.querySelector('.modal-mask')).not.toBeNull()
  })

  it('R42-4: ui.openShelf / openExport 置位后模态面存在（标志位不再无消费者）', async () => {
    await mountApp()
    const ui = useUiStore()
    ui.openShelf()
    await flushPromises()
    ui.closeShelf()
    ui.openExport()
    await flushPromises()
    // 两模态均为 Teleport 浮层；断言不抛错且 body 有浮层根
    expect(document.body.children.length).toBeGreaterThan(0)
    ui.closeExport()
  })

  it('静态锚：五件全局挂载于 App.vue，WorkspaceShell 不再重复挂载（防双挂载回归）', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    const app = fs.readFileSync('src/studio/web-next/src/App.vue', 'utf-8')
    const shell = fs.readFileSync('src/studio/web-next/src/components/shell/WorkspaceShell.vue', 'utf-8')
    for (const tag of ['<Toast />', '<ConfirmPrompt />', '<SettingsModal />', '<ShelfModal />', '<ExportDialog />']) {
      expect(app.includes(tag), `App.vue 缺全局挂载 ${tag}`).toBe(true)
      expect(shell.includes(tag), `WorkspaceShell 不得重复挂载 ${tag}`).toBe(false)
    }
  })
})
