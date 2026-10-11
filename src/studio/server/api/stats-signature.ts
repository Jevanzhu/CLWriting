/**
 * stats 端点结果缓存探针——数据源指纹单源（trace-stats / cost-stats 共用）。
 *
 * 为什么需要：两聚合都是全事件库全量扫（llm/call 逐条流式），端点侧挂 5s TTL 结果
 * 缓存防轮询反复读库。纯 TTL 无探针时，AI 任务收尾追加事件后、TTL 窗内的下一次
 * 读取会命中旧壳（真实表现：新任务跑完，工作台用量卡短暂仍显示「暂无 AI 调用记录」
 * 或旧次数）——「写侧是运行期追加、无挂点可挂」不成立，库文件本身就是挂点。
 *
 * 签名口径（实测标定）：服务进程形态下库保持打开，**读操作不扰动文件指纹、每次
 * appendEvents 改 `-wal` 侧车指纹**（关库 checkpoint 把变更折进主库）——故取
 * 「主库 + `-wal` 侧车」双 stat：写后即失效，读到库被 checkpoint 也不产生假命中。
 * 追加必增 WAL 字节（同尺寸写在 WAL 追加语义下不成立），低精度 mtime 卷
 * 亦无陈旧窗。另含本书 rule-hits 统计文件（trace-stats 载荷含其读出；命中记账
 * 写盘后同样即时失效）——userDataPath 缺失时事件库段恒 `-`（观测面未配置，
 * 该段无从变化）。
 *
 * 假失配只多扫不脏读：库/文件缺失计 `-`，首取建库后与旧签名自然失配、重算一次
 * （宁多扫不脏读，与同域探针口径一致）。
 *
 * 置位：api 层非路由模块（同 provider-save-guard.ts 先例）——两消费端点同在 api 层，
 * 直连 ai 面（rule-hits 路径单源）随本文件登记在治理门的 API_LAYER_REGISTERED。
 */
import { statSync } from 'node:fs'
import { sessionDbPath } from '../../../events/store.js'
import { ruleHitsPath } from '../../../ai/rule-hits.js'

function fileSig(fp: string | null): string {
  if (!fp) return '-'
  try {
    const st = statSync(fp)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '-'
  }
}

/** 数据源指纹（三文件各 `mtimeMs:size`，缺失计 `-`）。 */
export function statsSourceSignature(userDataPath: string | null | undefined, bookRoot: string): string {
  const db = userDataPath ? sessionDbPath(userDataPath, bookRoot) : null
  return [fileSig(db), fileSig(db ? db + '-wal' : null), fileSig(ruleHitsPath(bookRoot))].join('|')
}
