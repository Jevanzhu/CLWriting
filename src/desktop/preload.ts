/**
 * Electron 预加载脚本（桌面化工作目录管理，批2）。
 *
 * contextBridge 安全暴露「书库管理」API 给渲染进程（书架页按钮 / 最近列表调用）。
 * 渲染进程不直连 Node/ipcRenderer，只经 window.clwritingDesktop。
 *
 * 浏览器版无此脚本 → window.clwritingDesktop 不存在 → 前端据此隐藏桌面入口。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('clwritingDesktop', {
  /** 弹原生目录选择器选书库 → 选定则切换（relaunch）。取消返回 { ok:false, canceled:true }。 */
  openLibrary: (): Promise<{ ok: true } | { ok: false; canceled: true }> =>
    ipcRenderer.invoke('desktop:open-library'),
  /** 切换到指定书库路径（来自最近列表）→ relaunch。 */
  switchLibrary: (
    path: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('desktop:switch-library', path),
  /** 读最近书库列表。 */
  getRecentLibraries: (): Promise<{ path: string; label: string }[]> =>
    ipcRenderer.invoke('desktop:get-recent'),
  /** 读当前书库目录（null = 未选）。 */
  getCurrentLibrary: (): Promise<string | null> => ipcRenderer.invoke('desktop:get-current'),
})
