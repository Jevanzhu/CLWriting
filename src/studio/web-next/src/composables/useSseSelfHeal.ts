import { watch, onUnmounted } from 'vue'
import { useHeartbeat, heartbeatFailStreak } from './useHeartbeat'
import { useSse } from './useSse'
import { useWorkbenchStore } from '../stores/workbench'
import { useUiStore } from '../stores/ui'

/**
 * 书页 SSE 自愈接线：进书心跳与 SSE 连接收拢为单一挂载点（同 bookName 源），并托管
 * 两条连接级自愈通道——
 *
 * 1. 半开连接盲窗看门狗——服务端「接受连接、回 200 头、此后不发数据也不关」时
 *    EventSource 无 onerror，useSse 的 connected 冻结在 true 直至服务端
 *    requestTimeout（~300s），期间 AI 进度事件全丢而 UI 无感。心跳（20s 一拍的独立
 *    在线探测）连续 2 拍失败且 SSE 仍处 connected → resync 断开重连、重取连接级
 *    sync 快照自愈。去抖：触发即复位连败计数（下一拍重新起算，成功拍/useSse 侧 stop
 *    也复位）。SSE 非 connected 时不插手：断连重连已由 useSse 自身的 fail-closed
 *    退避链接管。
 * 2. 主进程「服务已自动重启/自愈成功」广播（desktop:server-restarted）——崩溃自动
 *    重启/session-end 自愈钉住端口拉回后，旧 SSE 连接已随 child 进程换代而死，
 *    EventSource 只能等自身退避重连；订阅广播主动 resync 立即断旧连新 + 重取连接级
 *    sync 快照，服务恢复对作者即时可感。浏览器版无此通道（window.clwritingDesktop
 *    判空降级，desktop.d.ts 同步登记）。
 *
 * 心跳与 SSE 必须同源挂载：心跳 20s 拍的 401→apiFetch→re-boot 只能间接救 SSE，挂载点
 * 分离后该自愈通道静默消失——故收拢为本 composable，调用方无法只挂其一（行为面由
 * sse-selfheal / heartbeat-watchdog-resync / server-restarted-resync 三件测试钉住）。
 */
export function useSseSelfHeal(bookName: () => string): { resync: () => void } {
  useHeartbeat(bookName)
  const sse = useSse(bookName)
  const workbench = useWorkbenchStore()
  const ui = useUiStore()

  watch(heartbeatFailStreak, (n) => {
    if (n >= 2 && workbench.connected) {
      heartbeatFailStreak.value = 0
      sse.resync()
    }
  })

  const offServerRestarted = window.clwritingDesktop?.onServerRestarted?.(() => {
    sse.resync()
    ui.toast('写作服务已自动恢复，正在重连', 'info')
  })
  onUnmounted(() => offServerRestarted?.())

  return { resync: () => sse.resync() }
}
