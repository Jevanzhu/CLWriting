import { apiJson } from './client'

// AI 可达性（降级）：GET /api/ai-status → { available, driver, reason? }
// 判别联合而非 {available: boolean; reason?: string}：后端 probeAi 四条不可达路径
// 恒带人话 reason（未配供应商/未测连接/未配档位/无数据目录），把它编成「不可达必有原因」
// 后消费侧（ui store 的 aiReason、各置灰提示面）拿到的 reason 不再是可能为空的字符串，
// 展示面无需各写一次「原因未知」兜底。
export type AiStatus =
  { available: true; driver: string; reason?: undefined } | { available: false; driver: string; reason: string }

export async function getAiStatus(): Promise<AiStatus> {
  return apiJson<AiStatus>('/api/ai-status')
}
