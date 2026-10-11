import { usePrefsStore } from '../stores/prefs'
import { useShelfStore } from '../stores/shelf'
import { useTreeStore } from '../stores/tree'
import { useWorkspaceStore } from '../stores/workspace'
import {
  createCrossWindowBridge,
  installCrossWindowBridge,
  type CrossWindowPort,
  type CrossWindowTopic,
} from '../shared/cross-window'

/**
 * 跨窗失效通知装配（三窗同源：主窗 / 书库窗 / 书架窗）。
 *
 * 本文件只做两件事：把四条失效线接到各自**既有的刷新链**上，并把桥装进
 * shared/cross-window 的模块级单例（store 侧广播点经 notifyCrossWindow 发出）。
 *
 * 为什么收到通知只走既有刷新链、不直接写 store：
 * - prefs：值型偏好的真相在服务端 + revision 乐观并发。直接写 ref 会绕过 409 闸与
 *   「本窗脏键优先」保护——本窗未保存的编辑被别窗广播静默覆盖。故走 store 新增的
 *   refreshOnRemoteChange（= 既有 GET + applyPrefs 逐键守卫 + 脏键合并链，不落盘）。
 * - 书架：显示态来自 GET /api/books（含工作区缺失提示与快照缓存），故走 store.load。
 * - 树红点/判态：聚合来自 GET /tree-issues，故走 tree.loadIssues（全量替换 issues）。
 * - 书级配置：本窗持的是「读一次就长期复用」的缓存（workspace.loadBookConfig），
 *   他窗改写 book.yaml 后本窗无从感知——故丢缓存（invalidateBookConfig），值仍由
 *   消费方下次读取向服务端取（与另三条同守「广播不带值」红线）。
 *
 * 不回环：本函数派发的四条刷新链自身都不广播（广播点只在本地写成功处，见各 store 与
 * 配置写入点的 notifyCrossWindow 调用），且入站消息带来源窗 id，自己的消息被丢弃，双保险。
 *
 * 降级：通道不可用（node 测试环境/jsdom/老 Electron）时装配不抛、notify 全 no-op，
 * 各窗功能照旧——本通道是「一致性增强」，不得成为启动依赖。
 */
export interface CrossWindowInvalidationOptions {
  /** 本窗 id（缺省随机）——测试注入固定 id 以模拟「他窗」消息 */
  windowId?: string
  /** 通道工厂（测试注入假通道）；缺省全局 BroadcastChannel 特性探测 */
  createPort?: (name: string) => CrossWindowPort | null
  /** 入站合并窗（缺省 0 = 同一 tick 内合并） */
  coalesceMs?: number
}

export interface CrossWindowInvalidationHandle {
  /** 通道可用（false = 降级 no-op；供装配方/测试断言特性探测结果） */
  readonly enabled: boolean
  /** 本窗 id（广播载荷里的来源标记） */
  readonly windowId: string
  /** 卸载：退订 + 关通道 + 还原单例（用例隔离/热重载重装） */
  dispose(): void
}

/** 装配跨窗失效通知（main.ts 在 mount 前调一次）。返回卸载句柄。 */
export function installCrossWindowInvalidation(
  opts: CrossWindowInvalidationOptions = {},
): CrossWindowInvalidationHandle {
  const prefs = usePrefsStore()
  const shelf = useShelfStore()
  const tree = useTreeStore()
  const ws = useWorkspaceStore()

  /** 收到他窗失效 → 逐主题走既有刷新链重取。
   *  刻意不做的事情：不接收载荷里的任何值（载荷本就没有值）、不落盘、不再广播。 */
  function onInvalidate(topics: readonly CrossWindowTopic[]): void {
    for (const topic of topics) {
      if (topic === 'prefs') {
        void prefs.refreshOnRemoteChange()
      } else if (topic === 'shelf') {
        void shelf.load()
      } else if (topic === 'book-config') {
        ws.invalidateBookConfig()
      } else {
        // 树红点/判态：raw 属主书名非空才有树可对齐（未开书跳过）
        const name = tree.ownerBook
        if (name) void tree.loadIssues(name)
      }
    }
  }

  const bridge = createCrossWindowBridge({
    windowId: opts.windowId,
    createPort: opts.createPort,
    coalesceMs: opts.coalesceMs,
    onInvalidate,
  })
  const uninstall = installCrossWindowBridge(bridge)

  return {
    enabled: bridge.enabled,
    windowId: bridge.windowId,
    dispose: () => {
      uninstall()
      bridge.dispose()
    },
  }
}
