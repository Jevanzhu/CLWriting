/**
 * R46-2（四十六轮）：analyze-style 全书文风扫描的 worker 线程入口——把「逐章整读 +
 * 全书 join + computeFullStats 正则统计」从服务进程事件循环下沉（export-worker B-24
 * 同款先例）。此前 MISS 路径的 computeFullStats 对 200 万字大串（join 本身又是一次
 * 同步大分配）做无让出的单段同步 CPU（0.1-1s），期间同进程全部书的 SSE 心跳/保存/
 * 其它请求停摆——正撞「200 万字不卡」承诺；读循环的逐块让出（R39-15）只覆盖了读段。
 *
 * 入口形态与 export-worker 相同：tsup 独立 entry（dist/desktop/analysis-worker.js），
 * src 形态（tsx dev / vitest）以 .ts 同伴运行。
 */
import { parentPort } from 'node:worker_threads'
import { readDraft } from '../../../format/draft.js'
import { computeFullStats } from '../../../metrics/style.js'

/** 扫描作业（父进程组好传入；chapters 已过滤 _path、标记 recent）。 */
export interface StyleScanJob {
  chapters: { path: string; 章号: number; 标题: string; recent: boolean }[]
  rules: Parameters<typeof computeFullStats>[1]
}

/** 扫描结果（plain object，postMessage 结构化克隆安全）。 */
export interface StyleScanResult {
  fullStats: ReturnType<typeof computeFullStats>
  sampleText: string
}

if (parentPort) {
  const port = parentPort
  port.once('message', (job: StyleScanJob) => {
    // 与原进程内实现逐位同源：坏章跳过、recent 带 `### 第N章 标题` 头、join 分隔符不变
    const allBodies: string[] = []
    const recentBodies: string[] = []
    for (const ch of job.chapters) {
      const draft = readDraft(ch.path)
      if (!draft.ok) continue
      allBodies.push(draft.body)
      if (ch.recent) recentBodies.push(`### 第${ch.章号}章 ${ch.标题}\n\n${draft.body}`)
    }
    const result: StyleScanResult = {
      fullStats: computeFullStats(allBodies.join('\n\n'), job.rules),
      sampleText: recentBodies.join('\n\n---\n\n'),
    }
    port.postMessage(result)
  })
}
