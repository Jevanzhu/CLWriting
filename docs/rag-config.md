# RAG 配置

story-craft 的 RAG 能力由 `core/rag/*` 提供，默认零三方依赖。未配置
embedding key 时，`vector` 投影会跳过，查询自动降级到 BM25/LIKE，不阻断写作。

常用入口：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> query semantic --text "监控黑屏"
python3 -X utf8 story-craft/scripts/story_craft.py --project-root <项目> health
```

`query semantic` 优先使用 vector/BM25/RAG；如果 `.story/vector.db` 缺失或没有
chunk，会降级到 memory index，并在 `next_steps` 给出重建建议。`health` 的
`rag` 字段会显示 vector chunk 数、embedding/rerank 配置状态和下一步建议，不输出
API key 明文。

## `.env` 加载顺序

配置会从以下位置 best-effort 加载，显式进程环境变量始终优先：

1. 进程环境变量。
2. 故事项目根目录 `.env`。
3. 当前工作目录 `.env`。
4. 用户级全局 `~/.claude/story-craft/.env`。

从非故事项目目录执行 CLI 时，带 `--project-root` 的命令也会读取对应项目根
`.env`。

## 推荐变量

```dotenv
EMBED_BASE_URL=https://api-inference.modelscope.cn/v1
EMBED_MODEL=Qwen/Qwen3-Embedding-8B
EMBED_API_KEY=your-embedding-key

RERANK_BASE_URL=https://api.jina.ai/v1
RERANK_MODEL=jina-reranker-v3
RERANK_API_KEY=your-rerank-key
```

兼容旧变量：

- `STORYCRAFT_API_BASE_URL`
- `STORYCRAFT_API_KEY`
- `STORYCRAFT_EMBEDDING_MODEL`
- `STORYCRAFT_RERANK_BASE_URL`
- `STORYCRAFT_RERANK_API_KEY`
- `STORYCRAFT_RERANKER_MODEL`

embedding 与 rerank 是独立服务。只配置 embedding 时，向量召回可用；未配置
rerank 时，检索保持 vector/BM25 原始排序。

## URL 规则

embedding 和 rerank 都按 OpenAI 兼容接口构造：

- `https://api.example.com` -> `https://api.example.com/v1/embeddings`
- `https://api.example.com/v1` -> `https://api.example.com/v1/embeddings`
- `https://api.example.com/v1/embeddings` -> 原样使用

rerank 同理，endpoint 为 `/v1/rerank`。

## 降级行为

- embedding 未配置或调用失败：`vector` 投影返回 skipped，查询降级到 BM25/LIKE。
- rerank 未配置或调用失败：保留 vector/BM25 候选原始顺序。
- rerank 返回部分结果：已重排结果优先，其余候选按原顺序补齐。

## rerank 是否值得开启（实测参考）

rerank 并非总是有益。当 embedding 本身已足够强时，较弱的 reranker 重排反而可能拉低召回质量。

一次小样本实测（中文悬疑检索，Qwen3-Embedding-8B + jina-reranker-v3）中，embedding 召回 top1 命中率已达 100%，叠加 rerank 后反而降到 33%–80%（负增益）。这说明 embedding 与 reranker 的能力需匹配：embedding 越强，越要求 reranker 同样强才有正收益。

建议：**在自己的语料上实测后再决定**。若 embedding 已足够强、rerank 无正增益，可设 `STORYCRAFT_ENABLE_RERANK=0` 关闭（不影响其余检索）。
