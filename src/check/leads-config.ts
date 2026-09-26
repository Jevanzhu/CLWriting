/**
 * 账本类配置派生（纯粹函数据此单点：基础两类 + book.yaml leads.enabled）。
 *
 * （全项目源码质量与优雅度评审）：本函数原在 check/runner.ts
 * （机检总 runner 聚合机检），树红点聚合族（run-tree-issues.ts）只是要一个「配置派生
 * 类表」却因此把整个聚合机检模块拉进依赖——树聚合需读的 readCheckConfig / openCheckDb /
 * checkWithDb 在单章机检链（run-single-doc.ts），反向经 run.ts 兼容桥又回到聚合族，
 * 两文件成环（评审的 check/run ↔ check/run-tree-issues）。派生表与「跑哪些检查」
 * 无关，落中立件后各消费方直取，环边消失。
 *
 * 不变量：本模块只依赖 format/install 层数据，**不得**引 check 下任何模块——它是被
 * runner（总聚合）、run-tree-issues（树聚合）、rebuild（缓存重建）三方共用的叶。
 */
import type { BookConfig } from '../format/types.js'
// -（全量代码）：基础两类单源自 install/data.ts，防手抄漂移
import { BASE_LEAD_TYPES } from '../install/data.js'

/** 已启用账本类 = 基础两类 + book.yaml leads.enabled（基础两类单源自 install/data.ts
 * BASE_LEAD_TYPES，rebuild.ts 同源引用——此前
 *  三处各持手抄副本易漂移，现已收敛为单点；树红点聚合的全书性红项计算共用）。
 * 去重——book.yaml 重复登记类此前产生重复 IN 参数（无害但脏）。 */
export function enabledLeadTypes(config: BookConfig): string[] {
  return [...new Set([...BASE_LEAD_TYPES, ...config.leads.enabled])]
}
