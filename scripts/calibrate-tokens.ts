#!/usr/bin/env node
/**
 * token 系数实测校准脚本。
 *
 * 用法：
 *   npx tsx scripts/calibrate-tokens.ts [--user-data <path>]
 *
 * 读 userData/clwriting/session/*.db 事件库里全部 llm/call 事件的
 * promptMeta.chars × usage.input 成对样本，按模型过原点最小二乘拟合 chars→tokens
 * 系数，输出 markdown 报告（样本量 / 拟合度 / 建议值）。产出后人工把建议值写进
 * src/shared/tokens.ts 的 TOKEN_COEFFICIENTS 并注明测定日期——校准是低频动作，
 * 不做运行时配置。
 *
 * 零 AI 调用、确定性、只读事件库。
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { defaultUserDataPath } from '../src/fs/user-data-path.js'
import {
  fitCoefficients,
  renderCalibrationReport,
  isCalibratableCallRow,
  type CalibrationSample,
} from '../src/ai/token-calibration.js'

// 参数取值严格口径：值缺失 / 空串 / 下一个 token 是 flag 名（`--` 开头）一律按缺参处理
// ——与 verify-responses-relay.ts 同款，不误吞下一个 flag 作值
function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  const v = i !== -1 ? process.argv[i + 1] : undefined
  return v && !v.startsWith('--') ? v : null
}

const userDataPath = argValue('--user-data') ?? defaultUserDataPath()
const sessionDir = join(userDataPath, 'clwriting', 'session')

const samples: CalibrationSample[] = []
if (existsSync(sessionDir)) {
  for (const f of readdirSync(sessionDir)) {
    if (!f.endsWith('.db')) continue
    const fp = join(sessionDir, f)
    let db: DatabaseSync
    try {
      db = new DatabaseSync(fp, { readOnly: true })
    } catch {
      continue // 库损坏/被锁：跳过该书
    }
    try {
      const rows = db.prepare("SELECT data FROM events WHERE type = 'llm/call'").all() as Array<{ data: string }>
      for (const row of rows) {
        try {
          const ev = JSON.parse(row.data) as {
            task?: string
            model?: string
            usage?: { input?: number; cacheRead?: number; cacheWrite?: number }
            promptMeta?: { chars?: number }
          }
          // 采样过滤单源 isCalibratableCallRow——chat 任务的 promptMeta.chars 只记当轮
          // 末条消息，而多轮 chat 的真实输入含整段历史，chars 低估数个量级 →
          // TOKEN_COEFFICIENTS 拟合虚高，故剔除；记账残缺行一并剔除（口径同 continue）。
          // 不做历史事件迁移：旧事件保持原样，报告用 r 值与样本量体现其影响。
          if (!isCalibratableCallRow(ev)) continue
          // usage.input 归一后不含 cache 读 / 写，而 chars 是全 prompt 字数——故重建全量
          // 输入对齐规模，否则两端口径不一、拟合系数偏低。旧事件里 input 已含 cache 的
          // 形态会偏高，由报告里 r 值与样本量体现，不做事件库迁移。
          const fullInput = ev.usage!.input! + (ev.usage!.cacheRead ?? 0) + (ev.usage!.cacheWrite ?? 0)
          samples.push({ model: ev.model!, chars: ev.promptMeta!.chars!, inputTokens: fullInput })
        } catch {
          /* 单行损坏跳过 */
        }
      }
    } catch (e) {
      // 单个 .db 能 open 但 schema 异异（events 表缺失 / 迁移中）时 prepare 抛错——不接住
      // 会连脚本一起崩、后续 .db 全不再扫。此处按库计数跳过，末尾汇总提示。
      console.warn(
        `[calibrate] 查询失败跳过 ${f}（schema 异异或表缺失）：${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      db.close()
    }
  }
}

const fits = fitCoefficients(samples)
console.log(renderCalibrationReport(fits, new Date().toISOString().slice(0, 10)))
