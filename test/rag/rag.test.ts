/**
 * RAG config + store 测试 —— M7 #37。
 *
 * 重点验证红线：
 * - H1：api_key 绝不进 git（readBookConfig 读不到 key；grep book.yaml 无 key）
 * - M1：.rag.db per-book、独立 .cache
 * - 向量 BLOB 往返、余弦相似度
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { readRagConfig, readApiKey, writeApiKey, enableRag } from '../../src/rag/config.js'
import { openRagDb, storeChunk, readAllChunks, float32ToBuffer, bufferToFloat32, cosineSimilarity, getRagMeta, setRagMeta } from '../../src/rag/store.js'
import { readBookConfig } from '../../src/format/yaml.js'

describe('RAG config（红线 H1：key 不进 git）', () => {
  let bookRoot: string
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `rag-work-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    bookRoot = join(workDir, 'mybook')
    mkdirSync(join(bookRoot), { recursive: true })
    mkdirSync(join(workDir, '.clwriting'), { recursive: true })
    writeFileSync(
      join(bookRoot, 'book.yaml'),
      'spec_version: 1\n\nbook:\n  title: 测试\n  genre: 玄幻\n\nleads:\n  enabled: [主线]\n',
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('未启用：无 rag 段 → enabled false', () => {
    const cfg = readRagConfig(bookRoot)
    expect(cfg.enabled).toBe(false)
  })

  it('enableRag：非密入 book.yaml，key 落 .clwriting/rag.secret（H1）', () => {
    const result = enableRag(bookRoot, workDir, {
      endpoint: 'https://api.example.com/v1/embeddings',
      model: 'text-embedding-3-small',
      apiKey: 'sk-secret-key-12345',
    })
    expect(result.ok).toBe(true)

    // book.yaml 有 rag 非密段
    const cfg = readBookConfig(join(bookRoot, 'book.yaml')).config
    expect(cfg.rag?.enabled).toBe(true)
    expect(cfg.rag?.endpoint).toBe('https://api.example.com/v1/embeddings')
    expect(cfg.rag?.model).toBe('text-embedding-3-small')

    // H1 红线：book.yaml 文本里 grep 不到 key
    const yamlText = readFileSync(join(bookRoot, 'book.yaml'), 'utf-8')
    expect(yamlText).not.toContain('sk-secret-key-12345')

    // key 落 .clwriting/rag.secret（gitignore 区）
    expect(existsSync(join(workDir, '.clwriting', 'rag.secret'))).toBe(true)
    const secret = readFileSync(join(workDir, '.clwriting', 'rag.secret'), 'utf-8')
    expect(secret).toContain('sk-secret-key-12345')
  })

  it('readApiKey 优先级：环境变量 > .clwriting/rag.secret', () => {
    // 先写 secret
    writeApiKey(workDir, 'file-key')
    expect(readApiKey(workDir)).toBe('file-key')

    // 设环境变量优先
    const oldEnv = process.env.CLWRITING_RAG_API_KEY
    process.env.CLWRITING_RAG_API_KEY = 'env-key'
    try {
      expect(readApiKey(workDir)).toBe('env-key')
    } finally {
      if (oldEnv === undefined) delete process.env.CLWRITING_RAG_API_KEY
      else process.env.CLWRITING_RAG_API_KEY = oldEnv
    }

    // 清环境变量回落到 file
    delete process.env.CLWRITING_RAG_API_KEY
    expect(readApiKey(workDir)).toBe('file-key')
  })

  it('无 key 时 readApiKey 返回 null', () => {
    const oldEnv = process.env.CLWRITING_RAG_API_KEY
    delete process.env.CLWRITING_RAG_API_KEY
    try {
      // workDir 的 .clwriting 没有 rag.secret（beforeEach 只建了目录）
      const freshWork = join(tmpdir(), `rag-nok-${Date.now()}`)
      mkdirSync(join(freshWork, '.clwriting'), { recursive: true })
      expect(readApiKey(freshWork)).toBe(null)
      rmSync(freshWork, { recursive: true, force: true })
    } finally {
      if (oldEnv !== undefined) process.env.CLWRITING_RAG_API_KEY = oldEnv
    }
  })
})

describe('RAG store（per-book .rag.db，向量 BLOB 往返，余弦）', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-store-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(bookRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('float32 ↔ Buffer 往返无损', () => {
    const arr = new Float32Array([0.1, 0.2, 0.3, -0.4, 0.5])
    const buf = float32ToBuffer(arr)
    const back = bufferToFloat32(buf)
    expect(back.length).toBe(arr.length)
    for (let i = 0; i < arr.length; i++) {
      expect(back[i]).toBeCloseTo(arr[i]!, 5)
    }
  })

  it('存取 chunk：BLOB 往返 + 字段完整', () => {
    const db = openRagDb(bookRoot)
    try {
      const emb = new Float32Array([1, 0, 0])
      storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 100, embedding: emb, model: 'test-model' })

      const chunks = readAllChunks(db)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.章号).toBe(1)
      expect(chunks[0]!.start_offset).toBe(0)
      expect(chunks[0]!.end_offset).toBe(100)
      expect(chunks[0]!.model).toBe('test-model')
      expect(chunks[0]!.embedding.length).toBe(3)
      expect(chunks[0]!.embedding[0]).toBeCloseTo(1, 5)
    } finally {
      db.close()
    }
  })

  it('.rag.db 落书仓库内（M1：per-book，独立 .cache）', () => {
    const db = openRagDb(bookRoot)
    db.close()
    expect(existsSync(join(bookRoot, '.rag.db'))).toBe(true)
    // .rag.db 和 .cache/index.db 是两个独立文件
    expect(join(bookRoot, '.rag.db')).not.toBe(join(bookRoot, '.cache', 'index.db'))
  })

  it('rag_meta 读写', () => {
    const db = openRagDb(bookRoot)
    try {
      expect(getRagMeta(db, 'foo')).toBe(null)
      setRagMeta(db, 'foo', 'bar')
      expect(getRagMeta(db, 'foo')).toBe('bar')
    } finally {
      db.close()
    }
  })

  it('余弦相似度：相同向量=1，正交=0', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([1, 0, 0])
    const c = new Float32Array([0, 1, 0])
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5)
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 5)
    // 零向量不崩
    expect(cosineSimilarity(new Float32Array([0, 0, 0]), a)).toBe(0)
  })
})
