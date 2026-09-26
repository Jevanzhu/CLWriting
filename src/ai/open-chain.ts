/**
 * 链路事件录制器开启（runner.mkChain / self-heal.mkChain 共享底层段）。
 *
 * 「openSessionStoreAsync → workspaceSession(bookHash)
 * → ChainRecorder，建链半途抛错先关库再降级」段的双实现单源——runner 侧带结构化
 * warn 留痕（建链失败整段调用零事件落库是审计黑洞，logger.warn 结构化留痕
 * 可回溯），self-heal 侧观测层失败静默（口径保留）——语义差异经 onWarn 钩子参数化。
 */
import { openSessionStoreAsync, bookHash } from '../events/store.js'
import { ChainRecorder } from '../events/chain-bridge.js'

/** 建链失败原因（与 runner 原结构化 warn 的 reason 字段逐字一致，日志对账不漂移）：
 *  - 'open-session-store-null'：开库返回 null（引用计数库未建/不可建）
 *  - 'chain-build-error'：workspaceSession / ChainRecorder 构造抛错
 *  - 'open-error'：openSessionStoreAsync 本身抛错 */
type OpenChainFailReason = 'open-session-store-null' | 'chain-build-error' | 'open-error'

/**
 * 开链路录制器：成功返回 ChainRecorder；开库 null / 开库抛错 / 建链抛错统一降级 null。
 * 开库走异步孪生（首开锁等待不阻塞服务事件循环）；建链半途抛错
 * 先关库再降级（引用计数单例不留滞留引用，二轮低级项口径）。
 * onWarn 缺省 = 全静默（self-heal 观测层口径）；runner 侧传结构化 warn 留痕。
 */
export async function openChainRecorder(
  userDataPath: string,
  bookRoot: string,
  onWarn?: (reason: OpenChainFailReason, error?: unknown) => void,
): Promise<ChainRecorder | null> {
  let store: Awaited<ReturnType<typeof openSessionStoreAsync>> = null
  try {
    store = await openSessionStoreAsync(userDataPath, bookRoot)
  } catch (e) {
    onWarn?.('open-error', e)
    return null
  }
  if (!store) {
    onWarn?.('open-session-store-null')
    return null
  }
  try {
    return new ChainRecorder(store, store.workspaceSession(bookHash(bookRoot)))
  } catch (e) {
    onWarn?.('chain-build-error', e)
    store.close()
    return null
  }
}
