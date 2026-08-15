/**
 * 捆绑资源定位（批次 C2/C4 共用：内置 prompt / 写作技巧包）。
 *
 * 资源根 = 仓库 resources/ 目录（源码运行：src/fs/resources.ts → 上两级）。
 * 打包形态若调整（dist 布局），用 CLWRITING_RESOURCES_DIR 显式指根，或在此扩候选路径。
 * 找不到资源根时抛错而非静默回落——捆绑资源缺失属打包 bug，应显式暴露。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/** 捆绑资源根目录（resources/）；env 覆盖 > 模块相对推导 */
export function resourcesRoot(): string {
  if (process.env['CLWRITING_RESOURCES_DIR']) {
    const p = resolve(process.env['CLWRITING_RESOURCES_DIR'])
    if (existsSync(p)) return p
  }
  const here = dirname(fileURLToPath(import.meta.url)) // <root>/src/fs
  const root = resolve(here, '..', '..')
  if (!existsSync(join(root, 'resources'))) {
    throw new Error(`未找到捆绑资源目录 resources/（期望位于 ${root}；打包形态请设 CLWRITING_RESOURCES_DIR）`)
  }
  return join(root, 'resources')
}

/** 捆绑资源内的子目录/文件路径拼接（不检查存在性，读时自管） */
export function bundledResource(...segments: string[]): string {
  return join(resourcesRoot(), ...segments)
}
