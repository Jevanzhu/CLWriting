/**
 * 确认记录 + 哈希 + 备料闸 —— 依据 ⑪ 确认记录 spec。
 *
 * 落地母本第 4.3 节防伪三招：
 * 1. 标记出内容文件 → `.confirm.json`（机器域，不写进 AI 可编辑的细纲.md）
 * 2. 绑内容哈希 → SHA-256 原始字节（node:crypto 内置，零依赖）
 * 3. 自动确认开关只作者设 → book.yaml 的 auto.confirm_outline
 *
 * 备料闸三态（⑪ 第 5 节）：无记录拒、哈希不一致拒、一致放行。
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { BookConfig } from '../format/types.js'

/** 确认记录（⑪ 第 2 节） */
export interface ConfirmRecord {
  chapter: number
  outline_hash: string // sha256: 前缀
  confirmed_at: string // ISO 8601
  mode: 'manual' | 'auto'
}

/** 确认记录文件名（工作区、机器域、. 前缀） */
const CONFIRM_FILE = '.confirm.json'

// ── 哈希（⑪ 第 4 节）────────────────────────────

/** 算文件原始字节的 SHA-256 哈希（⑪ 第 4 节：所见即所签） */
export function hashFile(filePath: string): string {
  const buf = readFileSync(filePath)
  return 'sha256:' + createHash('sha256').update(buf).digest('hex')
}

/** 算字符串内容的 SHA-256 哈希 */
export function hashContent(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf-8').digest('hex')
}

// ── 确认记录读写 ────────────────────────────────

/** 确认记录路径（工作区/.confirm.json） */
export function confirmPath(workDir: string): string {
  return join(workDir, CONFIRM_FILE)
}

/** 读确认记录（不存在返回 null） */
export function readConfirm(workDir: string): ConfirmRecord | null {
  const fp = confirmPath(workDir)
  if (!existsSync(fp)) return null
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as ConfirmRecord
  } catch {
    return null
  }
}

/** 写确认记录 */
function writeConfirm(workDir: string, rec: ConfirmRecord): void {
  writeFileSync(confirmPath(workDir), JSON.stringify(rec, null, 2), 'utf-8')
}

/** 删除确认记录（定稿清空工作区时调用） */
export function clearConfirm(workDir: string): void {
  const fp = confirmPath(workDir)
  if (existsSync(fp)) unlinkSync(fp)
}

// ── confirm 命令行为（⑪ 第 3 节，阶段 2）─────────

/** confirm 结果 */
export type ConfirmResult =
  | { ok: true; record: ConfirmRecord }
  | { ok: false; reason: string } // 人话

/**
 * 执行确认（阶段 2）。
 * - mode=manual：作者手动确认
 * - mode=auto：连写自动确认，前置校验 book.yaml 的 auto.confirm_outline（⑪ 第 6 节）
 */
export function doConfirm(
  workDir: string,
  chapter: number,
  outlinePath: string,
  mode: 'manual' | 'auto',
  config: BookConfig,
): ConfirmResult {
  // ⑪ 第 6 节：auto 模式需 book.yaml 开了 auto.confirm_outline
  if (mode === 'auto' && !config.auto.confirm_outline) {
    return { ok: false, reason: '未开自动确认，连写不能自动盖章（在 book.yaml 开 auto.confirm_outline）' }
  }

  if (!existsSync(outlinePath)) {
    return { ok: false, reason: '细纲文件不存在' }
  }

  const record: ConfirmRecord = {
    chapter,
    outline_hash: hashFile(outlinePath),
    confirmed_at: new Date().toISOString(),
    mode,
  }
  writeConfirm(workDir, record)
  return { ok: true, record }
}

// ── 备料闸校验（⑪ 第 5 节，阶段 3）──────────────

/** 备料闸校验结果 */
export type GateResult =
  | { ok: true }
  | { ok: false; reason: string } // 人话

/**
 * 备料前三态判定（⑪ 第 5 节）：
 * - 无记录 → 拒绝（"细纲还没拍板"）
 * - 哈希不一致 → 拒绝（"细纲确认后又改过了"）
 * - 一致 → 放行
 */
export function checkConfirmGate(
  workDir: string,
  outlinePath: string,
): GateResult {
  const record = readConfirm(workDir)
  if (record === null) {
    return { ok: false, reason: '细纲还没拍板' }
  }

  if (!existsSync(outlinePath)) {
    return { ok: false, reason: '细纲文件不存在' }
  }

  const currentHash = hashFile(outlinePath)
  if (record.outline_hash !== currentHash) {
    // ⑪ 第 5 节第 2 种：先骗确认再偷改，哈希对不上
    return { ok: false, reason: '细纲确认后又改过了，需重新确认' }
  }

  return { ok: true }
}
