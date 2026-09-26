/**
 * R30-24（三十轮）回归：openShelfWindow / openLibraryWindow 调用点不得再有
 * 裸浮 async 调用。
 *
 * 缺陷形态：`desktop:open-shelf` / `desktop:open-library-window` 两个 ipcMain.handle
 * 与原生菜单 click 对 async 窗工厂 fire-and-forget 裸调——窗工厂早期抛错成主进程
 * unhandledRejection 丢诊断。修复口径对齐 R74-16（loadURL promise 接日志）。
 *
 * 复审-0914-优化修复批（F1 拆分适配）：窗工厂正本迁 windows.ts，调用面分散在
 * ipc.ts（IPC handler）与 main.ts（原生菜单 click）——扫描面随批扩为两文件。
 *
 * 本测试为静态守卫（greybox 源面断言）：main.ts 无 electron 可注入的窗工厂故障点
 * （BrowserWindow 假件构造不抛错），故按任务口径以「调用点全部带 .catch 兜底」的
 * 源码契约固化，防回退；行为面由既有 desktop 测试全绿兜底（含 open-shelf IPC
 * 注册面断言）。声明行（async function ...）与注释行不计入调用面。
 */
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const callerFiles = ['src/desktop/ipc.ts', 'src/desktop/main.ts'].map((f) => readFileSync(join(root, f), 'utf-8'))

for (const fn of ['openShelfWindow', 'openLibraryWindow'] as const) {
  test(`R30-24: ${fn} 全部调用点带 .catch 兜底（无裸浮 async 调用）`, () => {
    const callLines = callerFiles
      .flatMap((src) => src.split('\n'))
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.includes(`${fn}()`) && // 调用形态（定义行为 `async function ${fn}():`，被下方排除）
          !line.startsWith('async function') && // 函数声明行非调用
          !line.startsWith('export async function') && // windows.ts 正本声明行非调用
          !line.startsWith('//'), // 注释行非调用
      )
    // 两处调用面：ipcMain.handle 回调（ipc.ts）+ 原生菜单 click（main.ts）
    expect(callLines.length).toBe(2)
    for (const line of callLines) {
      expect(line).toContain('.catch(')
    }
  })
}
