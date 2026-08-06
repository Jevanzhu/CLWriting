/**
 * 关系图梳理契约——tool_use schema。
 *
 * AI 通读名册/角色卡/正文,提炼结构化角色关系。
 * 结构化产出由 tool_use 强制 JSON,不靠自由文本 + extractJson。
 */
import type { ToolDef } from '../provider/types.js'

export const RELATIONS_TOOL_NAME = 'submit_relations'

/** 关系图梳理工具定义 */
export function submitRelations(): ToolDef {
  return {
    name: RELATIONS_TOOL_NAME,
    description: '提交角色关系图数据(每条 from→to 一条边)',
    input_schema: {
      type: 'object',
      properties: {
        relations: {
          type: 'array',
          description: '角色关系边',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: '角色 A 姓名(须与材料中的姓名一致)' },
              to: { type: 'string', description: '角色 B 姓名(须与材料中的姓名一致)' },
              type: { type: 'string', description: '关系类型,完整有区分度的短语(师徒/仇敌/旧时婚约/挚友/道侣/血契…),不用单字' },
              note: { type: 'string', description: '一句话关系说明/依据(可选)' },
            },
            required: ['from', 'to', 'type'],
          },
        },
      },
      required: ['relations'],
    },
  }
}