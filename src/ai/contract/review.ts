/**
 * 审稿契约——tool_use schema（方案 §四④）。
 *
 * 各视角审稿产 issues 数组通过 tool_use 强制 JSON，不再靠自由文本。
 * issue 格式与 review/contract.ts 的 ReviewIssue 对齐。
 */
import type { ToolDef } from '../provider/types.js'

/** 审稿 issues 提交工具——强制产出 JSON 数组 */
export function submitIssues(): ToolDef {
  return {
    name: 'submit_issues',
    description: '提交审稿意见。无问题回空数组。只报问题，不要正面确认。',
    input_schema: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                enum: [
                  'high_point', 'reader_pull', 'pacing', 'ooc', 'logic', 'consistency',
                  'continuity', 'setting', 'timeline', 'strand', 'ledger', 'safety',
                  'hook', 'emotion_peak', 'reversal', 'payoff',
                ],
                description: '问题分类',
              },
              severity: {
                type: 'string',
                enum: ['S1', 'S2', 'S3', 'S4'],
                description: 'S1致命/S2严重/S3一般/S4建议',
              },
              evidence: {
                type: 'string',
                description: '正文原句（必须引用原文）',
              },
              issue: { type: 'string', description: '问题说明' },
              fix: { type: 'string', description: '改稿建议' },
            },
            required: ['category', 'severity', 'evidence', 'issue', 'fix'],
          },
        },
      },
      required: ['issues'],
    },
  }
}

export const ISSUES_TOOL_NAME = 'submit_issues'
