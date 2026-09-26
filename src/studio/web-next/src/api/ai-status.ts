import { apiJson } from './client'

// AI 可达性（降级）：GET /api/ai-status → { available, driver, reason? }
interface AiStatus {
  available: boolean
  driver: string
  reason?: string
}

export async function getAiStatus(): Promise<AiStatus> {
  return apiJson<AiStatus>('/api/ai-status')
}
