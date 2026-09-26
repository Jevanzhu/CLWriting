/**
 * per-key 串行 Promise 链通用件。
 *
 * 四胞胎同构实现收编单源（各处 R 编号沿革见各消费方文件头注，此处记共性形态）：
 * - documents.ts runInForeshadowSaveChain（2--① 伏笔保存串行链）
 * - documents.ts enqueueStructureOp（阶段 24 章节结构操作串行链）
 * - files.ts enqueueFilePut（同文件 PUT 串行链）
 * - draft.ts enqueueDraftSave（draft-save 串行链）
 *
 * 链语义（逐位对齐四份原实现）：
 * - `prev.then(unit, unit)`——前驱成败都接续（串行不因单元失败断链）；
 * - 链尾 settled 吞错副本防 unhandled rejection（真实结果/异常经返回的 task 传递，
 *   由单元 await 侧经 dispatch 兜底或原样上抛）；
 * - 链尾自清理——settle 后身份校验 delete（settle 窗口内同 key
 *   新单元已 set 的新链尾不得误删）。
 *
 * drain 双口径（复刻三份 drainXxxUnder 的键匹配差异，逐位不变）：
 * - 'prefix'：键恒以 root+sep 开头才命中（files.ts 链键 =「书根/文件」复合键，
 *   恰等书根的键不存在，原实现只做 startsWith(root+sep)）；
 * - 'exact-or-prefix'：键恰等书根或以 root+sep 开头（draft/structure 链键恰为书根
 *   本体，无尾分隔符，漏恰等分支则 drain 恒 no-op）。
 * 两口径均挂 realpath 兜底前缀（workDir 含 symlink 组件（macOS
 * /var→/private/var）时词法前缀永不匹配 realpath 键 → drain no-op；失败回退词法）。
 * 快照式：只等快照时点命中的在途链，drain 窗口内新进单元不等（各消费方由单元体内
 * bookMovedFailure 书注册重验兜底拒绝）。
 */
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

/** drainUnder 的键匹配口径（见文件头注「drain 双口径」）。 */
export type SerialChainDrainMatch = 'prefix' | 'exact-or-prefix'

export interface SerialChainMap {
  /** 入链：前驱成败都接续；返回值携带真实结果/异常（链尾吞错副本不外泄）。 */
  enqueue<T>(key: string, unit: () => Promise<T>): Promise<T>
  /** 恰等键排空（documents.ts 伏笔链口径：只等该书键当前链尾，无则立即 resolve）。 */
  drainExact(key: string): Promise<void>
  /** realpath 双口径前缀排空（快照式；口径由 createSerialChainMap 的 drainMatch 钉住）。 */
  drainUnder(bookRoot: string): Promise<void>
  /** 按键清除（删书/改名 forget 挂点；Map.delete 幂等）。 */
  forget(key: string): void
  /** 测试观测钩子：当前在途链键的只读快照（settle 后自清理）。 */
  keysForTest(): readonly string[]
}

export function createSerialChainMap(opts?: { drainMatch?: SerialChainDrainMatch }): SerialChainMap {
  const chains = new Map<string, Promise<unknown>>()
  const matchMode: SerialChainDrainMatch = opts?.drainMatch ?? 'exact-or-prefix'
  return {
    enqueue<T>(key: string, unit: () => Promise<T>): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve()
      const task = prev.then(unit, unit) // 前驱成败都接续
      // 链尾吞错防 unhandled rejection（单元错误由本单元 await 侧处理/上抛）
      const settled = task.catch(() => {})
      chains.set(key, settled)
      // 链尾自清理：settle 后身份校验 delete（同 key 新链尾不误删，见文件头注）
      void settled.then(() => {
        if (chains.get(key) === settled) chains.delete(key)
      })
      return task
    },
    async drainExact(key: string): Promise<void> {
      const tail = chains.get(key)
      if (!tail) return
      await tail
    },
    async drainUnder(bookRoot: string): Promise<void> {
      const roots = [bookRoot]
      try {
        const real = realpathSync(bookRoot)
        if (real !== bookRoot) roots.push(real)
      } catch {
        /* 书根不存在（已删）等 → 只用词法口径 */
      }
      // 'prefix' 口径不收恰等键（files.ts 原式 prefixes.some(p => k.startsWith(p))，
      // p 恒带尾 sep）；'exact-or-prefix' 兼收恰等（draft/structure 原式 k === r || …）
      const matches =
        matchMode === 'prefix'
          ? (k: string): boolean => roots.some((r) => k.startsWith(r + sep))
          : (k: string): boolean => roots.some((r) => k === r || k.startsWith(r + sep))
      const pending = [...chains.keys()].filter(matches)
      if (pending.length === 0) return
      await Promise.allSettled(pending.map((k) => chains.get(k)))
    },
    forget(key: string): void {
      chains.delete(key)
    },
    keysForTest(): readonly string[] {
      return [...chains.keys()]
    },
  }
}
