/**
 * 对话面知识层选篇策略——按 catalog 声明取篇。
 *
 * 取篇判据 = `BUNDLED_CATALOG` 中 `faces` 含 `chat` 者，**按声明序**取前 N 篇（帽内）。
 * 此前按「目录名 = 方法论」扫描 + 字典序切片：作者往书级类目加料后，第 5 篇起按文件名
 * 顺序无声丢弃；改 catalog 序后，取哪些篇、什么优先级由注册表一处声明，扩展篇目只需
 * 加条目（不再依赖文件名排序的偶然结果）。
 *
 * 书级覆盖随包：同 rel 书级件优先（`resolveCorpusFile` 单源），故作者在书根
 * `知识层/<rel>` 放同名篇即可覆盖该篇——与写稿/三审两面同构。
 *
 * 装配（解析/截断/计量/拼段/登记/超帽处置）单源 = src/knowledge/inject.ts。
 * 对话面不受书级 `auto.knowledge_injection` 管辖（`knowledgeInjectionEnabled` 的
 * chat 面恒真：作者主动问答时语料是其依据来源），故不接开关参数。
 *
 * 容错：读取或组装失败一律空段（可选增强，不阻断对话）；无篇入选 → 空段。
 */
import { BUNDLED_CATALOG } from './catalog.js'
import { assembleKnowledge } from './inject.js'

/**
 * 篇数帽 / 单篇码点帽 / 合计码点帽。
 *
 * 单篇帽 3000 = 通用档篇目写作规范的上限（单篇 ≤3000 码点）——低于此值会把每篇
 * 尾部（自检清单）整段截掉，帽值须 ≥ 篇目规范上限才不产生系统性截断。
 * 合计帽维持 6000：新篇体量（约 2.2–2.9K）下实际入段 2 篇，与本面「补判断类参考、
 * 不堆体量」的定位一致。
 */
const KNOWLEDGE_MAX_FILES = 4
const KNOWLEDGE_FILE_CAP = 3000
const KNOWLEDGE_TOTAL_CAP = 6000

/** 段头（整块前缀，含与首篇间的空行——段文本是测试锚定面） */
const KNOWLEDGE_HEADING = '## 本书知识层方法论(写作纪律参考,与本书设定冲突时以设定为准)\n\n'

/** 对话面知识层注入：段文本（空串 = 无篇，不注入） + 注入源登记名（注入序） */
export interface ChatKnowledgeInjection {
  text: string
  sources: string[]
}

/** 对话面候选篇（catalog 声明序；`faces` 含 chat 者） */
export function chatCandidateRels(): string[] {
  return BUNDLED_CATALOG.filter((e) => e.faces.includes('chat')).map((e) => e.rel)
}

/** 组装对话面知识层注入段。 */
export function buildChatKnowledgeInjection(bookRoot: string): ChatKnowledgeInjection {
  const rels = chatCandidateRels().slice(0, KNOWLEDGE_MAX_FILES)
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
