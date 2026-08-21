#!/usr/bin/env node
/**
 * C4（批 3）token 系数实测校准脚本（P8-①）。
 *
 * 用法：
 *   npx tsx scripts/calibrate-tokens.ts [--user-data <path>]
 *
 * 读 userData/clwriting/session/*.db 事件库里全部 llm/call 事件的
 * promptMeta.chars × usage.input 成对样本，按模型过原点最小二乘拟合 chars→tokens
 * 系数，输出 markdown 报告（样本量 / 拟合度 / 建议值）。产出后人工把建议值写进
 * src/process/prepare.ts 的 TOKEN_COEFFICIENTS 并注明测定日期——校准是低频动作，
 * 不做运行时配置。
 *
 * 零 AI 调用、确定性、只读事件库。
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { defaultUserDataPath } from '../src/fs/user-data-path.js'
import { fitCoefficients, renderCalibrationReport, type CalibrationSample } from '../src/ai/token-calibration.js'

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] ?? null : null
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
      const rows = db
        .prepare("SELECT data FROM events WHERE type = 'llm/call'")
        .all() as Array<{ data: string }>
      for (const row of rows) {
        try {
          const ev = JSON.parse(row.data) as {
            model?: string
            usage?: { input?: number; cacheRead?: number; cacheWrite?: number }
            promptMeta?: { chars?: number }
          }
          if (!ev.model || !ev.usage?.input || !ev.promptMeta?.chars) continue
          // M-1 归一后 usage.input 不含 cache 读/写——chars 是全 prompt 字数，
          // 重建全量输入对齐规模（2026-08-21 前的 OpenAI 旧事件 input 已含 cache，会偏高，
          // 由报告里 r 值与样本量体现，不做事件库迁移）
          const fullInput = ev.usage.input + (ev.usage.cacheRead ?? 0) + (ev.usage.cacheWrite ?? 0)
          samples.push({ model: ev.model, chars: ev.promptMeta.chars, inputTokens: fullInput })
        } catch {
          /* 单行损坏跳过 */
        }
      }
    } finally {
      db.close()
    }
  }
}

const fits = fitCoefficients(samples)
console.log(renderCalibrationReport(fits, new Date().toISOString().slice(0, 10)))
