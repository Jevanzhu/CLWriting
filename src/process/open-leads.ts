/**
 * 进行中账本读取（W-P1-3：outline 左端 + 账本推进右端共用）。
 *
 * 下沉到 process 层：outline 端点（server）与 self-heal 写稿后生成账本推进（ai/orchestrate）
 * 都依赖此，避免 server → process 依赖方向错误。
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readLeadDir } from '../format/leads.js'
import { readBookConfig } from '../format/yaml.js'

/**
 * 读当前「进行中」账本（已启用类）→ [{编号, 标题, 状态}]。
 * 已启用类 = 基础两类（悬念/感情线）+ book.yaml leads.enabled（与 cache/rebuild.ts 同口径）。
 * 仅列「进行中」（未开/已收尾的不在本章推进候选，避免 AI 臆造推进）。
 */
export function readOpenLeads(bookRoot: string): { 编号: string; 标题: string; 状态: string }[] {
  const cfgResult = readBookConfig(join(bookRoot, 'book.yaml'))
  const enabled = new Set<string>(['悬念', '感情线'])
  if (cfgResult.ok) for (const t of cfgResult.config.leads.enabled) enabled.add(t)
  const out: { 编号: string; 标题: string; 状态: string }[] = []
  for (const typeName of enabled) {
    const typeDir = join(bookRoot, '布线', typeName)
    if (!existsSync(typeDir)) continue
    const { leads } = readLeadDir(typeDir)
    for (const lead of leads) {
      if (lead.状态 !== '进行中') continue
      out.push({ 编号: lead.编号, 标题: lead.标题, 状态: lead.状态 })
    }
  }
  // 编号顺序稳定（悬念→感情线→扩展类，类内按扫描顺序）——prompt 输出可复现
  return out
}
