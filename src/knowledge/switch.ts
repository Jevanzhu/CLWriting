/**
 * 知识层注入开关单源——「这一面要不要注入语料」的口径声明与判据处。
 *
 * 此前写稿面与三审面各写一份 `config?.auto?.knowledge_injection !== false`，对话面
 * 「不受开关辖」则是代码里的**缺席**（既无判据也无声明，读不出是有意政策还是遗漏）。
 * 收敛到本模块后三面口径各自显式声明：
 *
 * - `draft` / `review`：遵书级 `auto.knowledge_injection`（缺省开 = 现行行为，
 *   存量书零影响）；`!== false` 而非 `=== true`——配置缺省（直调/测试路径）与键未设
 *   都照旧注入，不因读不到配置而静默降级（global 托底在 applyGlobalDefaults 侧）。
 *   两面装配侧调用本函数取值（draft-pipeline 写稿链 / api/review 三审链）。
 * - `chat`：**恒注入**。作者主动问答时语料是其依据来源，关掉等于让助手失去依据；
 *   本面的注入不受 auto 键管辖（书级/全局设 false 也不影响对话面）。该政策的落地形态
 *   不在调用本函数：对话装配器（knowledge/chat-method.ts）根本不接开关参数，
 *   故本分支无生产调用方，只作政策声明与测试锚——有它，「chat 恒注入」才是读得出的
 *   显式口径而非缺席；将来对话面若真要接开关，改判据只在本函数一处。
 */
import type { BookConfig } from '../format/types.js'
import type { InjectionFace } from './catalog.js'

/** 该注入面是否启用（switch 单源；`chat` 恒 true，其余遵书级 auto 键缺省开） */
export function knowledgeInjectionEnabled(config: BookConfig | undefined, face: InjectionFace): boolean {
  if (face === 'chat') return true
  return config?.auto?.knowledge_injection !== false
}
