/**
 * 通用命令执行器：统一处置一次性 CLI 命令（触发 → 收 stdout → 显示）。
 * 字段按 commandKey 索引、单槽覆盖，不随命令数膨胀。
 * 复用：Config 的 export/import/rag/learn/knowledge-check、Editor 的 revert、
 * Workbench 的 CLI 步等「触发 CLI」操作都能走这里——全站命令层，非某页专属。
 */
import { defineStore } from 'pinia'

interface CliRun {
  running: boolean
  stdout: string
  error: string
  /** 最后执行时间戳 */
  at: number
}

function emptyRun(): CliRun {
  return { running: false, stdout: '', error: '', at: 0 }
}

export const useCliStore = defineStore('cli', {
  state: () => ({
    /** 按 commandKey 索引；同 key 重跑覆盖上次 */
    runs: {} as Record<string, CliRun>,
  }),
  actions: {
    /**
     * 通用执行：自动管 running/error/stdout。
     * - CliTextResult 形态（含 stdout）→ 自动填 runs[key].stdout
     * - 结构化产出（如 learn 候选）→ 返回原值供调用方取用，反馈用 setMsg 手动填
     * - 失败：填 runs[key].error，返回 undefined（不 throw，避免外层未捕获）
     */
    async run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
      const cur = (this.runs[key] ??= emptyRun())
      cur.running = true
      cur.error = ''
      cur.stdout = ''
      cur.at = Date.now()
      try {
        const r = await fn()
        if (r && typeof r === 'object' && 'stdout' in r) {
          cur.stdout = String((r as { stdout?: unknown }).stdout ?? '').trim()
        }
        return r
      } catch (e) {
        cur.error = e instanceof Error ? e.message : String(e)
        return undefined
      } finally {
        cur.running = false
      }
    },
    /** 手动设置成功反馈（非 stdout 产出，如 learn 入库数量） */
    setMsg(key: string, msg: string) {
      (this.runs[key] ??= emptyRun()).stdout = msg
    },
    /** 清指定 key 或全部 */
    clear(key?: string) {
      if (key) delete this.runs[key]
      else this.runs = {}
    },
  },
})
