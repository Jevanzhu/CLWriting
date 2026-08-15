/**
 * ⚠️ 自动生成文件——不要手改（npm run generate:catalog 产出）。
 *
 * 源头：src/ai/provider/model-quirks.ts（参数表唯一真相源）。
 * 双向校验：test/ai/provider/catalog-sync.test.ts 离线确定性重算——
 * 改 model-quirks.ts 后未重新生成、或手改本文件，比对失配即红。
 * contentVersion = 目录体内容哈希（SHA-256 前 16 位，不透明 token）：
 * 同内容 ⇒ 同版本，A7 表驱动入库的 seeder 以此做跳过依据。
 */
import type { ModelCatalog } from './catalog.js'

export const MODEL_CATALOG_VERSION = "98ff355e48dafbd9"

export const MODEL_CATALOG = {
  "rows": [
    {
      "model": "claude-sonnet-5",
      "note": "Anthropic 原生",
      "family": "claude",
      "quirks": {
        "toolUse": true,
        "toolChoiceMode": "named",
        "maxOutputTokens": 16384,
        "maxTokensKey": "max_tokens",
        "thinkingWithEffort": false,
        "emitStreamOptions": true,
        "structuredMode": "json_schema",
        "anthropicEffortWire": "output_config",
        "parallelControl": true,
        "echoReasoning": false,
        "reasoningEffortByLevel": {
          "low": null,
          "medium": null,
          "high": null,
          "xhigh": null,
          "max": null
        },
        "trimStopSample": {
          "input": [
            "一",
            "二",
            "三"
          ],
          "output": [
            "一",
            "二",
            "三"
          ]
        }
      }
    },
    {
      "model": "gpt-5.1",
      "note": "OpenAI gpt/o 系",
      "family": "gpt",
      "quirks": {
        "toolUse": true,
        "toolChoiceMode": "named",
        "maxTokensKey": "max_completion_tokens",
        "thinkingWithEffort": false,
        "emitStreamOptions": true,
        "structuredMode": "json_schema",
        "anthropicEffortWire": null,
        "parallelControl": true,
        "echoReasoning": false,
        "reasoningEffortByLevel": {
          "low": "low",
          "medium": "medium",
          "high": "high",
          "xhigh": "xhigh",
          "max": "max"
        },
        "trimStopSample": {
          "input": [
            "一",
            "二",
            "三"
          ],
          "output": [
            "一",
            "二",
            "三"
          ]
        }
      }
    },
    {
      "model": "grok-4",
      "note": "xAI",
      "family": "grok",
      "quirks": {
        "toolUse": true,
        "toolChoiceMode": "named",
        "maxOutputTokens": 128000,
        "maxTokensKey": "max_completion_tokens",
        "thinkingWithEffort": false,
        "emitStreamOptions": true,
        "structuredMode": "json_schema",
        "anthropicEffortWire": null,
        "parallelControl": true,
        "echoReasoning": false,
        "reasoningEffortByLevel": {
          "low": "low",
          "medium": "medium",
          "high": "high",
          "xhigh": "xhigh",
          "max": "max"
        },
        "trimStopSample": {
          "input": [
            "一",
            "二",
            "三"
          ],
          "output": null
        }
      }
    },
    {
      "model": "deepseek-v4",
      "note": "DeepSeek v4",
      "family": "deepseek",
      "quirks": {
        "toolUse": true,
        "toolChoiceMode": "required",
        "effortMap": {
          "medium": "high",
          "xhigh": "max"
        },
        "maxOutputTokens": 384000,
        "maxTokensKey": "max_tokens",
        "thinkingWithEffort": true,
        "emitStreamOptions": true,
        "structuredMode": "json_object",
        "anthropicEffortWire": "output_config",
        "parallelControl": false,
        "echoReasoning": true,
        "reasoningEffortByLevel": {
          "low": "low",
          "medium": "high",
          "high": "high",
          "xhigh": "max",
          "max": "max"
        },
        "trimStopSample": {
          "input": [
            "一",
            "二",
            "三"
          ],
          "output": [
            "一",
            "二",
            "三"
          ]
        }
      }
    },
    {
      "model": "glm-5.2",
      "note": "GLM 5.2+（effort 支持）",
      "family": "glm",
      "quirks": {
        "toolUse": true,
        "toolChoiceMode": "auto",
        "maxTokensKey": "max_tokens",
        "thinkingWithEffort": false,
        "emitStreamOptions": false,
        "structuredMode": "json_object",
        "anthropicEffortWire": null,
        "parallelControl": false,
        "echoReasoning": true,
        "reasoningEffortByLevel": {
          "low": "low",
          "medium": "medium",
          "high": "high",
          "xhigh": "xhigh",
          "max": "max"
        },
        "trimStopSample": {
          "input": [
            "一",
            "二",
            "三"
          ],
          "output": [
            "一"
          ]
        }
      }
    },
    {
      "model": "glm-4.6",
      "note": "GLM 4.x（effort 不支持，发则 400）",
      "family": "glm",
      "quirks": {
        "toolUse": true,
        "toolChoiceMode": "auto",
        "maxTokensKey": "max_tokens",
        "thinkingWithEffort": false,
        "emitStreamOptions": false,
        "structuredMode": "json_object",
        "anthropicEffortWire": null,
        "parallelControl": false,
        "echoReasoning": true,
        "reasoningEffortByLevel": {
          "low": null,
          "medium": null,
          "high": null,
          "xhigh": null,
          "max": null
        },
        "trimStopSample": {
          "input": [
            "一",
            "二",
            "三"
          ],
          "output": [
            "一"
          ]
        }
      }
    },
    {
      "model": "kimi-k3",
      "note": "Kimi k3（effort 支持）",
      "family": "kimi",
      "quirks": {
        "toolUse": true,
        "toolChoiceMode": "required",
        "maxTokensKey": "max_completion_tokens",
        "thinkingWithEffort": false,
        "emitStreamOptions": true,
        "structuredMode": "json_schema",
        "anthropicEffortWire": null,
        "parallelControl": true,
        "echoReasoning": true,
        "reasoningEffortByLevel": {
          "low": "low",
          "medium": "medium",
          "high": "high",
          "xhigh": "xhigh",
          "max": "max"
        },
        "trimStopSample": {
          "input": [
            "一",
            "二",
            "三"
          ],
          "output": [
            "一",
            "二",
            "三"
          ]
        }
      }
    },
    {
      "model": "kimi-k2",
      "note": "Kimi k2.x（采样参数固定）",
      "family": "kimi",
      "quirks": {
        "toolUse": true,
        "toolChoiceMode": "auto",
        "maxTokensKey": "max_completion_tokens",
        "thinkingWithEffort": false,
        "emitStreamOptions": true,
        "structuredMode": "json_schema",
        "anthropicEffortWire": null,
        "parallelControl": true,
        "echoReasoning": true,
        "reasoningEffortByLevel": {
          "low": null,
          "medium": null,
          "high": null,
          "xhigh": null,
          "max": null
        },
        "trimStopSample": {
          "input": [
            "一",
            "二",
            "三"
          ],
          "output": [
            "一",
            "二",
            "三"
          ]
        }
      }
    },
    {
      "model": "custom-model",
      "note": "unknown 保守档",
      "family": "unknown",
      "quirks": {
        "toolUse": true,
        "toolChoiceMode": "auto",
        "maxTokensKey": "max_tokens",
        "thinkingWithEffort": false,
        "emitStreamOptions": true,
        "structuredMode": "none",
        "anthropicEffortWire": null,
        "parallelControl": false,
        "echoReasoning": false,
        "reasoningEffortByLevel": {
          "low": null,
          "medium": null,
          "high": null,
          "xhigh": null,
          "max": null
        },
        "trimStopSample": {
          "input": [
            "一",
            "二",
            "三"
          ],
          "output": [
            "一",
            "二",
            "三"
          ]
        }
      }
    }
  ]
} satisfies ModelCatalog
