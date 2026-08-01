/**
 * 分析契约——tool_use schema（方案 §四④）。
 *
 * 各 kind 的结构化产出通过 tool_use 强制 JSON，不再靠自由文本 + extractJson。
 */
import type { ToolDef } from '../provider/types.js'

export type AnalysisKind = 'score' | 'emotion' | 'hooks' | 'style' | 'tags'

/** 按 kind 生成分析工具定义 */
export function submitAnalysis(kind: AnalysisKind): ToolDef {
  switch (kind) {
    case 'score':
      return {
        name: 'submit_score',
        description: '提交体验分分析结果',
        input_schema: {
          type: 'object',
          properties: {
            score: { type: 'integer', minimum: 1, maximum: 10, description: '总体体验分' },
            verdict: { type: 'string', description: '一句总评' },
            dims: {
              type: 'object',
              properties: {
                爽点: { type: 'integer', minimum: 1, maximum: 10 },
                节奏感: { type: 'integer', minimum: 1, maximum: 10 },
                拖沓: { type: 'integer', minimum: 1, maximum: 10, description: '拖沓分越高越拖沓' },
              },
              required: ['爽点', '节奏感', '拖沓'],
            },
          },
          required: ['score', 'verdict', 'dims'],
        },
      }
    case 'emotion':
      return {
        name: 'submit_emotion',
        description: '提交情绪曲线分析结果',
        input_schema: {
          type: 'object',
          properties: {
            segments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  seg: { type: 'string', description: '段落标识' },
                  emotion: { type: 'integer', minimum: -2, maximum: 2, description: '-2谷底/0平/+2高潮' },
                  label: { type: 'string', description: '情绪标签' },
                },
                required: ['seg', 'emotion', 'label'],
              },
            },
          },
          required: ['segments'],
        },
      }
    case 'hooks':
      return {
        name: 'submit_hooks',
        description: '提交钩子密度分析结果',
        input_schema: {
          type: 'object',
          properties: {
            hooks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  pos: { type: 'string', description: '位置' },
                  type: { type: 'string', enum: ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩'] },
                  strength: { type: 'integer', minimum: 1, maximum: 5 },
                  note: { type: 'string', description: '一句话说明' },
                },
                required: ['pos', 'type', 'strength'],
              },
            },
            density: { type: 'string', enum: ['疏', '中', '密'] },
          },
          required: ['hooks', 'density'],
        },
      }
    case 'style':
      return {
        name: 'submit_style',
        description: '提交文风总结分析结果',
        input_schema: {
          type: 'object',
          properties: {
            drift: { type: 'string', description: '与基线偏离方向' },
            口癖: { type: 'array', items: { type: 'string' }, description: '高频词/句式' },
            重复度评价: { type: 'string', description: '一句话评价' },
            建议: { type: 'array', items: { type: 'string' }, description: '改进建议' },
          },
          required: ['drift', '口癖', '重复度评价', '建议'],
        },
      }
    case 'tags':
      return {
        name: 'submit_tags',
        description: '提交章节标签识别结果',
        input_schema: {
          type: 'object',
          properties: {
            钩子类型: { type: 'string', enum: ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩'] },
            钩子强弱: { type: 'string', enum: ['强', '中', '弱'] },
            情绪定位: { type: 'string', enum: ['压抑', '铺垫', '小爽', '大爽', '转折'] },
            场景: { type: 'string', enum: ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮'] },
          },
          required: ['钩子类型', '钩子强弱', '情绪定位', '场景'],
        },
      }
  }
}

export function analysisToolName(kind: AnalysisKind): string {
  return `submit_${kind}`
}
