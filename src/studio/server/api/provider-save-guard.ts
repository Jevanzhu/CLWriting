/** providers.json 保存失败的信封映射单源（providers / rag-providers 两族端点共用）。
 *
 *  保存点统一 try/await：saveProviders 的排队段写失败会向上传播（磁盘满 / 权限 / 锁超时），
 *  此前仅 log.warn 吞掉会让端点回 200 假成功——作者以为已保存。
 *  写前基线复验冲突（ProviderRevisionConflictError）单列映射既有 409 REVISION_CONFLICT
 *  信封，与前置 revisionError 闸同形态同文案：排队写窗口内基线漂移时前端拿到的是「刷新
 *  重读」语义而非「写入失败请重试」（重试只会再撞复验闸）。
 *
 *  返回 false = 已回错误响应，调用方直接 return，不再 reply 200。
 *  两族端点原本各持一份本地副本（避免路由模块互相 import），同属「写 providers.json」这
 *  一语义，故与 host-change-guard.ts 同款收敛——路由模块引同目录 guard 模块不是环边。 */
import type { ServerResponse } from 'node:http'
import { replyError } from '../http.js'
import { saveProviders, ProviderRevisionConflictError, type ProviderStore } from '../../../ai/provider/index.js'

export async function saveProvidersOr500(
  res: ServerResponse,
  userDataPath: string,
  s: ProviderStore,
): Promise<boolean> {
  try {
    await saveProviders(userDataPath, s)
    return true
  } catch (e) {
    if (e instanceof ProviderRevisionConflictError) {
      replyError(res, 409, 'REVISION_CONFLICT', e.message)
      return false
    }
    replyError(res, 500, 'WRITE_ERROR', '配置写入失败，请重试')
    return false
  }
}
