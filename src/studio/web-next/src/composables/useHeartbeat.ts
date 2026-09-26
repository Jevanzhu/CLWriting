import { ref, onUnmounted, watch } from 'vue'
import { apiFetch, getToken } from '../api/client'
import { bookUrl } from '../api/url'

// 协作心跳：进书后每 20s POST /heartbeat 续期；卸载（onUnmounted）DELETE 清除（单写者互斥）。
// 切书不发 DELETE（依赖服务端过期回收）——L-注释校准：原「切书 DELETE」与实现不符。
// 卸载 DELETE 改用落拍捕获的书名——此前重读 getBookName 在卸载
// 时已随路由参数归空，DELETE 实际不可达（与本注释宣称的「卸载清除」不符）。
// serverOnline 为全局信号（状态栏连接徽章 + 右栏 AI 置灰消费）。
const online = ref(true)
export const serverOnline = online

/** 连续失败拍数（模块级，同 serverOnline 惯例）——SSE
 *  半开连接看门狗消费面：服务端「接受连接、回 200 头、此后不发数据也不关」时
 *  EventSource 无 onerror、connected 冻结在 true，靠心跳连败检出后 resync 强制重连
 *  （连续 ≥2 拍失败且 SSE 仍处 connected 态，见 useSseSelfHeal 接线）。成功拍复位；
 *  stop（退书/切书）复位；触发侧（useSseSelfHeal）触发后同样复位去抖。
 *  0918二轮修复批（E104）：连败只由传输层失败（网络异常/超时 abort，fetch 抛错）
 *  累计——业务 4xx/5xx（书已删 404、鉴权 401 等）服务进程仍在线，不计连败。 */
const failStreak = ref(0)
export const heartbeatFailStreak = failStreak

/** 单次 beat 超时档——apiFetch 无内建超时，对端挂死时 promise 永不
 *  settle，在线信号冻结在上一次结果（误显在线）且在途锁不释放（后续 beat 全被跳过）。 */
const BEAT_TIMEOUT_MS = 10_000

export function useHeartbeat(getBookName: () => string | null): void {
  let timer: ReturnType<typeof setInterval> | null = null
  // 在途去重——上一拍未返回（慢网/挂死）时跳过本拍，不叠加并发心跳
  let inFlight = false
  // 最近一次心跳的书名捕获——卸载时路由参数已变（Book.vue 的
  // bookName 是 route.params 派生的 computed，离开 /book/:name 后取值归空），leave
  // 重读 getBookName 拿到空串，DELETE 实际不可达（头注宣称的「卸载清除」从未达成，
  // 只能靠服务端过期回收）。清除动作面向的是「已登记心跳的书」，一律用捕获值；
  // 切书不 DELETE 的既有语义（L-）不变——watch 换书走 start 而非 leave。
  let beating: string | null = null

  async function beat(): Promise<void> {
    if (inFlight) return
    const name = getBookName()
    if (!name) return
    inFlight = true
    beating = name // 落拍即捕获（leave 用）
    // 10s 超时 abort（对齐 client.ts boot 的 AbortController 手法；apiFetch
    // 透传 init.signal）——超时走 catch 置离线，信号不再冻结
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), BEAT_TIMEOUT_MS)
    try {
      // 0918二轮修复批（E104）：收到任何 HTTP 响应（含 404 书已删 / 401 / 5xx）= 服务
      // 进程在线——业务语义留给各自处理链（401 的 re-boot 在 apiFetch 内自愈、404 由
      // 路由/调用方收口），心跳只盯传输层；原实现按 r.ok 计离线连败，业务 4xx 误报
      // 离线徽章并驱动 SSE 看门狗误 resync。响应体无人消费，不读。
      await apiFetch(bookUrl(name, 'heartbeat'), {
        method: 'POST',
        signal: ctrl.signal,
      })
      online.value = true
      // 有响应（传输层通）即复位连败；连败只由 catch 形态（网络异常/超时 abort）累计
      failStreak.value = 0
    } catch {
      online.value = false
      failStreak.value++
    } finally {
      clearTimeout(timeout)
      inFlight = false
    }
  }

  function start(): void {
    stop()
    void beat()
    timer = setInterval(() => void beat(), 20_000)
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    // 停止心跳时把全局在线信号复位回初始「在线/未知」态——
    // 否则退书前最后一次 beat 失败的假阴性会挂到下次进书（StatusBar 误显离线），
    // 且退书后不再探测，无机会自愈。下次进书 start 的首次 beat 会立即校正。
    online.value = true
    failStreak.value = 0 // 连败计数随退书/切书一并复位（不带入下次进书）
  }

  async function leave(): Promise<void> {
    stop()
    // 用捕获的书名（卸载时 getBookName 已读不到原书，重读必得空串跳过）
    const name = beating
    beating = null
    // token null（boot 未成功）时跳过 DELETE——必 401 徒劳且会
    // 误触发 apiFetch 的 re-boot；本地直接放弃清除，让服务端过期回收心跳。
    if (name && getToken()) {
      // （-0914）：DELETE 补超时档（beat 侧 同型）——apiFetch 无内建
      // 超时，对端挂死时本 promise 永不 settle，onUnmounted 的 fire-and-forget 悬挂；
      // 10s abort 后走 catch 静默（清除失败本就不阻断退书，靠服务端过期回收兜底）。
      const ctrl = new AbortController()
      const timeout = setTimeout(() => ctrl.abort(), BEAT_TIMEOUT_MS)
      try {
        await apiFetch(bookUrl(name, 'heartbeat'), { method: 'DELETE', signal: ctrl.signal })
      } catch {
        /* 退书心跳清除失败忽略 */
      } finally {
        clearTimeout(timeout)
      }
    }
  }

  watch(
    () => getBookName(),
    (n) => {
      if (n) start()
      else stop()
    },
    { immediate: true },
  )
  onUnmounted(() => {
    void leave()
  })
}
