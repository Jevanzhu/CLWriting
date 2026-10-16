/**
 * 仓根定位单源（scripts/ 侧，`.mjs` 消费面）——锚点取本档所在位置，不取 cwd。
 *
 * 判据（cwd 为何不行）：cwd 取决于调用处——从子目录直跑时以 cwd 当仓根，会在错误根上
 * 做存在性判定与目录扫描，或直接以裸 ENOENT 崩在 `<cwd>/test` 这类路径上（实测
 * `cd test && node ../scripts/test-related.mjs …` 崩于 scandir `<仓根>/test/test`）——
 * 行为取决于站在哪，而不是显式报错。同族先例：corpus-paths.ts（语料目录缺省以文件位置
 * 锚定）、test/helpers/repo-root.ts（测试侧同范式）。
 *
 * fileURLToPath 解码百分号编码（工作区路径含 ^ 时 pathname 会带 %5E，scandir 直接
 * ENOENT）——不得改用 URL.pathname。
 *
 * 未接消费面（随触碰归并）：`.ts` 四档（check-knowledge / knowledge-commit /
 * knowledge-update / corpus-paths——`.mjs` 单源不能被 TS 直接 import）与
 * electron-smoke.mjs 的 `dirname(dirname(…))` 变体。
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓根绝对路径（本档住 scripts/，上推一级；resolve 归一掉目录尾分隔符）。 */
export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
