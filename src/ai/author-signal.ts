/**
 * B5 作者信号（最小闭环）—— 作者保存手改后，diff AI 版本与终稿，
 * 把「作者删掉的片段」按规则 check() 跑一遍，命中 → 该规则命中数 +1。
 *
 * 信号语义：作者主动删掉含 AI 味/套话的内容 = 规则检对了 AI 味，
 * 该规则的高频统计随作者验证累积（B3 面板 + B4 前置注入更可信）。
 *
 * 不做自由文本教训提取（那需要 AI 归纳，留第三波记忆层）。
 * 失败一律静默返回——信号是旁路证据，绝不阻断落盘主流程。
 */
import { listAiVersions, readAiVersion } from '../git/ai-track.js'
import { collectRuleViolations } from './rules/index.js'
import { recordRuleHits } from './rule-hits.js'
import { openSessionStore, bookHash } from '../events/store.js'
import { authorSignalEvent } from '../events/chain-bridge.js'

/** 作者删除信号只统计套话类规则（碎片文本对风格/设定/情节统计无意义） */
const SIGNAL_RULE_IDS = new Set(['ai-cliche', 'ai-flavor-words'])

/**
 * 记录作者手改信号：对比上一版（AI 产出），删掉的片段命中规则 → 统计 +1。
 *
 * 调用时机：saveDraft 落盘时、recordAiVersion 之前（先对比上一版，再记录当前版）。
 * 无上一版 / 非 git 仓库 / 无删改 → 静默返回。
 */
export async function recordAuthorSignal(
  bookRoot: string,
  docId: string,
  currentContent: string,
  task: string,
  userDataPath?: string,
): Promise<void> {
  const versions = listAiVersions(bookRoot, docId)
  if (!versions.length) return
  const prev = readAiVersion(bookRoot, docId, versions[versions.length - 1]!.sha)
  if (!prev) return

  const deleted = deletedSegments(prev, currentContent)
  if (!deleted.trim()) return

  // 只统计套话类规则（作者删掉的 AI 味片段 = 信号）
  const violations = collectRuleViolations(deleted, task, bookRoot)
    .filter((v) => SIGNAL_RULE_IDS.has(v.ruleId))
  // R32-13（三十二轮）：随 recordRuleHits 异步化（锁等待不再冻结服务事件循环）
  await recordRuleHits(bookRoot, violations, userDataPath)
  // P3 事件化（author/signal）：作者删除信号入事件流（观测层静默）
  if (userDataPath && violations.length > 0) {
    let store: ReturnType<typeof openSessionStore> | null = null
    try {
      store = openSessionStore(userDataPath, bookRoot)
      if (store) {
        const sessionId = store.workspaceSession(bookHash(bookRoot))
        store.appendEvents(
          sessionId,
          violations.map((v) => authorSignalEvent({ ruleId: v.ruleId, message: v.message, task })),
        )
      }
    } catch {
      // 观测层失败静默
    } finally {
      // dd-P2：close 挪进 finally——appendEvents 抛错时此前被跳过，openSessionStore
      // 引用计数泄漏、SQLite 句柄在长驻服务里永不释放
      store?.close()
    }
  }
}

/**
 * 行级删除检测：prev 中在 current 中不足的行 = 被删掉的行。
 * 按行计数匹配（同一行多次出现时按出现次数对齐），避免误判编辑后重排。
 */
function deletedSegments(prev: string, current: string): string {
  const prevLines = prev.split('\n')
  const currentCount = new Map<string, number>()
  for (const l of current.split('\n')) {
    currentCount.set(l, (currentCount.get(l) ?? 0) + 1)
  }
  const used = new Map<string, number>()
  const deleted: string[] = []
  for (const l of prevLines) {
    const usedCount = used.get(l) ?? 0
    if (usedCount >= (currentCount.get(l) ?? 0)) {
      deleted.push(l)
    } else {
      used.set(l, usedCount + 1)
    }
  }
  return deleted.join('\n')
}