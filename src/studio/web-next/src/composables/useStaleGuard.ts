/**
 * 请求代守卫单源——`let xGen = 0 / const gen = ++xGen /
 * await 后 if (gen !== xGen) return` 样板的收敛件（/
 * 等沿革各自手搓的同构计数器，此后换装本工具）。
 *
 * 与裸计数逐位等价的五个原语：
 * - begin      = `const gen = ++xGen`（推进并取本代 token；请求开工时调）
 * - stale(t)     = `t !== xGen`（await 后复检：被后发请求/clear 作废即真）
 * - fresh(t)     = `t === xGen`（finally 条款：仅现行代做 loading 复位等收尾）
 * - invalidate = `xGen++`（clear/切书/重入：不取 token 直接作废全部在途）
 * - current    = `xGen`（只快照不推进——style.add / check.flagFalsePositive /
 *   audit loadMore / learn.commit(harvestGen) / chat.regenerate 的观测代）
 *
 * 无 Vue 生命周期 / inject 依赖：Pinia store setup、组合式函数、视图 <script setup>
 * 均可调用（非组件上下文安全）。各处守卫判定时机（await 后先查代再落态）由调用方
 * 保持，本工具只收敛计数器样板；「同文件多代并行」时各建一个实例（learn reqGen +
 * commitGen、provider refreshGen + refreshRagGen 先例——共用一个计数会互相作废）。
 */
export interface StaleGuard {
  /** 开新代：推进计数并返回本代 token（原 `const gen = ++xGen`）。 */
  begin(): number
  /** token 已过期（原 `gen !== xGen`）——await 窗口后被作废即真。 */
  stale(token: number): boolean
  /** token 仍现行（原 `gen === xGen`）——finally 条款用。 */
  fresh(token: number): boolean
  /** 不取 token 直接作废现行代（原 `xGen++`，clear/切书/重入）。 */
  invalidate(): void
  /** 观测现行代值（原 `const gen = xGen`，只快照不推进）。 */
  current(): number
}

export function useStaleGuard(): StaleGuard {
  let gen = 0
  return {
    begin: () => ++gen,
    stale: (token) => token !== gen,
    fresh: (token) => token === gen,
    invalidate: () => {
      gen++
    },
    current: () => gen,
  }
}
