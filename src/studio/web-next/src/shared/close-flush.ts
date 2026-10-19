/**
 * 关窗兜底待办注册表（单源）——关窗链只有一处实现：主进程 close 拦截后经
 * executeJavaScript 调 window.__clwFlushBeforeClose。在册者登记「关窗前必须落定的
 * Promise 工厂」，由钩子体逐一 await。
 *
 * 用途：卸载路径的清除动作（如心跳 DELETE）是 fire-and-forget——组件已销毁后无人
 * 再等它，主进程 destroy 会掐断在途请求（同书标签页名额延迟释放，第 6 窗吃 429 指引）。
 */
type CloseTask = () => Promise<unknown>
const tasks = new Set<CloseTask>()

/** 登记一个关窗待办，返回注销句柄（与注册同生命周期成对调用）。 */
export function registerCloseTask(task: CloseTask): () => void {
  tasks.add(task)
  return () => tasks.delete(task)
}

/** 关窗前逐个 await 在册待办（快照迭代防遍历期变更；单个失败不阻断其余兜底）。 */
export async function runCloseTasks(): Promise<void> {
  for (const t of [...tasks]) {
    try {
      await t()
    } catch {
      /* 待办失败不阻断关窗兜底链 */
    }
  }
}
