/**
 * 对话面知识层选篇策略(书级 > 随包 扫描驱动)。
 *
 * 取篇口径 = 目录名即分类:书级 知识层/方法论/*.md ∪ 随包 knowledge/方法论/*.md,
 * 书级同 rel 覆盖随包(同名去重)。读取单源 resolveCorpusFile(书级缺失回落随包),
 * 装配单源 src/knowledge/inject.ts(解析/截断/计量/拼段/登记/超帽处置)。
 *
 * 本模块只留**策略**:取哪些类目、帽值多少、为何入选。对话面不受书级
 * auto.knowledge_injection 管辖(knowledgeInjectionEnabled 的 chat 面恒真:作者主动
 * 问答时语料是其依据来源),故不接开关参数。
 *
 * 容错:读取或组装失败一律空段(可选增强,不阻断对话);无任何方法论篇 → 空段。
 */
import { listBookKnowledgeEntries, listBundledKnowledgeEntries } from './corpus.js'
import { assembleKnowledge } from './inject.js'

/** 篇数帽 / 单篇码点帽 / 合计码点帽 */
const KNOWLEDGE_MAX_FILES = 4
const KNOWLEDGE_FILE_CAP = 2000
const KNOWLEDGE_TOTAL_CAP = 6000

/** chat 面取篇的类目 = 目录名(目录即分类,统一批后不再依赖 manifest) */
const KNOWLEDGE_METHOD_DIR = '方法论'

/** 段头(整块前缀,含与首篇间的空行——段文本是测试锚定面) */
const KNOWLEDGE_HEADING = '## 本书知识层方法论(写作纪律参考,与本书设定冲突时以设定为准)\n\n'

/** 对话面知识层注入:段文本(空串 = 无篇,不注入) + 注入源登记名(注入序) */
export interface ChatKnowledgeInjection {
  text: string
  sources: string[]
}

/** 组装对话面知识层注入段。 */
export function buildChatKnowledgeInjection(bookRoot: string): ChatKnowledgeInjection {
  // 两级 rel 并集:书级先入、随包后入,Map 同 rel 覆盖 = 书级优先
  const byRel = new Map<string, true>()
  for (const e of listBookKnowledgeEntries(bookRoot)) {
    if (e.category === KNOWLEDGE_METHOD_DIR) byRel.set(e.rel, true)
  }
  for (const e of listBundledKnowledgeEntries()) {
    if (e.category === KNOWLEDGE_METHOD_DIR && !byRel.has(e.rel)) byRel.set(e.rel, true)
  }
  const rels = [...byRel.keys()].sort().slice(0, KNOWLEDGE_MAX_FILES)
  if (rels.length === 0) return { text: '', sources: [] }

  const assembled = assembleKnowledge({
    bookRoot,
    rels,
    heading: KNOWLEDGE_HEADING,
    fileCap: KNOWLEDGE_FILE_CAP,
    totalCap: KNOWLEDGE_TOTAL_CAP,
    reasonOf: () => '对话面方法论',
  })
  return { text: assembled.text, sources: assembled.sources }
}
