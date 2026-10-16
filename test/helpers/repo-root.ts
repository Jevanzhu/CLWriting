/**
 * 仓根定位单源——源码/样式断言类用例要读仓内文件，锚点取本档所在位置而非 cwd。
 *
 * 为什么不用相对路径：vitest 的 cwd 取决于调用处（在仓的子目录里 `npx vitest run`
 * 时 cwd ≠ 仓根），`readFileSync('src/…')` 这类仓根相对字面量随之 ENOENT——断言面
 * 从一个目录跑得绿、换一个目录就红。以模块自身 URL 上推定位即与 cwd 脱钩。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓根绝对路径（本档住 test/helpers/，上推两级） */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 读仓内文件（入参 = 仓根相对路径，`/` 分隔；返回文本，UTF-8） */
export function readRepoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}
