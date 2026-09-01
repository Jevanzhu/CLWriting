import { ref, onUnmounted, watch } from 'vue'
import { apiFetch, getToken } from '../api/client'

// 协作心跳：进书后每 20s POST /heartbeat 续期；卸载（onUnmounted）DELETE 清除（单写者互斥）。
// 切书不发 DELETE（依赖服务端过期回收）——L-F5（第八轮）注释校准：原「切书 DELETE」与实现不符。
// R34D-24（三十四轮）：卸载 DELETE 改用落拍捕获的书名——此前重读 getBookName() 在卸载
// 时已随路由参数归空，DELETE 实际不可达（与本注释宣称的「卸载清除」不符）。
// serverOnline 为全局信号（状态栏连接徽章 + 右栏 AI 置灰消费）。
const online = ref(true)
export const serverOnline = online

/** R26-77（二十六轮）：单次 beat 超时档——apiFetch 无内建超时，对端挂死时 promise 永不
 *  settle，在线信号冻结在上一次结果（误显在线）且在途锁不释放（后续 beat 全被跳过）。 */
const BEAT_TIMEOUT_MS = 10_000

export function useHeartbeat(getBookName: () => string | null): void {
  let timer: ReturnType<typeof setInterval> | null = null
  // R26-77：在途去重——上一拍未返回（慢网/挂死）时跳过本拍，不叠加并发心跳
  let inFlight = false
  // R34D-24（三十四轮）：最近一次心跳的书名捕获——卸载时路由参数已变（Book.vue 的
  // bookName 是 route.params 派生的 computed，离开 /book/:name 后取值归空），leave()
  // 重读 getBookName() 拿到空串，DELETE 实际不可达（头注宣称的「卸载清除」从未达成，
  // 只能靠服务端过期回收）。清除动作面向的是「已登记心跳的书」，一律用捕获值；
  // 切书不 DELETE 的既有语义（L-F5）不变——watch 换书走 start 而非 leave。
  let beating: string | null = null

  async function beat(): Promise<void> {
    if (inFlight) return
    const name = getBookName()
    if (!name) return
    inFlight = true
    beating = name // R34D-24：落拍即捕获（leave 用）
    // R26-77：10s 超时 abort（对齐 client.ts boot 的 AbortController 手法；apiFetch
    // 透传 init.signal）——超时走 catch 置离线，信号不再冻结
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), BEAT_TIMEOUT_MS)
    try {
      const r = await apiFetch(`/api/books/${encodeURIComponent(name)}/heartbeat`, {
        method: 'POST',
        signal: ctrl.signal,
      })
      online.value = r.ok
    } catch {
      online.value = false
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
    // E-6a（第五十三轮）：停止心跳时把全局在线信号复位回初始「在线/未知」态——
    // 否则退书前最后一次 beat 失败的假阴性会挂到下次进书（StatusBar 误显离线），
    // 且退书后不再探测，无机会自愈。下次进书 start() 的首次 beat 会立即校正。
    online.value = true
  }

  async function leave(): Promise<void> {
    stop()
    // R34D-24：用捕获的书名（卸载时 getBookName() 已读不到原书，重读必得空串跳过）
    const name = beating
    beating = null
    // E-6b（第五十三轮）：token null（boot 未成功）时跳过 DELETE——必 401 徒劳且会
    // 误触发 apiFetch 的 re-boot（E-2）；本地直接放弃清除，让服务端过期回收心跳。
    if (name && getToken()) {
      try {
        await apiFetch(`/api/books/${encodeURIComponent(name)}/heartbeat`, { method: 'DELETE' })
      } catch {
        /* 退书心跳清除失败忽略 */
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
