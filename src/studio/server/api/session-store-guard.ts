/** 事件库开库 + 500 信封 + close 收口单源（session-store 消费端点共用）。
 *
 *  openSessionStoreAsync 是引用计数单例：开库失败（损坏/权限等首开失败是**抛错**而非
 *  返回 null）须显式收编结构化 500（e.message 人话透传，含损坏分类的可行动指引），
 *  拿到 store 后必须 try/finally close（中途抛错不 close 则 refs 永不归零、连接泄漏）。
 *  该「开库 → 信封 → finally close」骨架在 chat-history / chat-branches / audit 曾逐字
 *  多份拷贝，收敛本文件（先例同 provider-save-guard.ts / revision-guard.ts）。
 *
 *  run 内自行 reply（各端点视图构造与成功信封各异）；开库失败与 store 为 null 两态由
 *  本函数统一回 500，调用方不再分支。
 */
import type { ServerResponse } from 'node:http'
import { replyError } from '../http.js'
import { openSessionStoreAsync, type SessionStore } from '../../../events/store.js'
import { errMsg } from '../../../log/index.js'

export async function withSessionStoreOr500(
  res: ServerResponse,
  userDataPath: string,
  bookRoot: string,
  run: (store: SessionStore) => void | Promise<void>,
): Promise<void> {
  let store: SessionStore | null
  try {
    store = await openSessionStoreAsync(userDataPath, bookRoot)
  } catch (e) {
    return replyError(res, 500, 'STORE_UNAVAILABLE', `事件库不可用（无法打开会话存储）：${errMsg(e)}`)
  }
  if (!store) return replyError(res, 500, 'STORE_UNAVAILABLE', '事件库不可用（无法打开会话存储）')
  try {
    await run(store)
  } finally {
    store.close()
  }
}
