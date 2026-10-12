/**
 * corpus-commit 的缺省语料目录解析单源。
 *
 * corpus-commit.ts 顶层即执行（不可被测试安全 import），解析逻辑抽本零副作用模块：
 * 显式传参原样返回；缺省以本文件位置锚定仓库根（`new URL('..', import.meta.url)`，
 * 对齐 check-counts.mjs / check-packaging.mjs / knowledge-update.ts 同目录脚本口径）。
 * 判据（按 cwd 相对解析为何不行）：从子目录直跑 `npx tsx scripts/corpus-commit.ts` 时
 * 旧形态会把语料落进仓外 <cwd>/test/corpus/checks/，脚本看似成功而 CI 回归门（读真仓
 * 目录）零新增、静默失守。
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export function resolveCorpusDir(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  return join(repoRoot, 'test', 'corpus', 'checks')
}
