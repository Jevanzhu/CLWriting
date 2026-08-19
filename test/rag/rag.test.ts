/**
 * RAG config + store 测试 —— M7 #37。
 *
 * 重点验证红线：
 * - H1：api_key 绝不进 git（readBookConfig 读不到 key；grep book.yaml 无 key）
 * - M1：RAG 库 per-book（.cache/rag.db；旧书根裸 .rag.db 自动迁移，hh §八-11）
 * - 向量 BLOB 往返、余弦相似度
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { readRagConfig, readApiKey, writeApiKey, enableRag } from '../../src/rag/config.js'
import { resolveRag } from '../../src/rag/resolve.js'
import { createRagTables } from '../../src/rag/schema.js'
import { openRagDb, ragDbExists, resolveRagDbPath, storeChunk, readAllChunks, float32ToBuffer, bufferToFloat32, cosineSimilarity, getRagMeta, setRagMeta } from '../../src/rag/store.js'
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
    expect(readFileSync(join(workDir, '.clwriting', '.gitignore'), 'utf-8')).toContain('rag.secret')
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

describe('resolveRag（服务商化：书级引用 + 应用级服务商 + 旧版内联回落）', () => {
  const PROVIDERS = [
    { id: 'rag-a', name: 'A 家嵌入', endpoint: 'https://a.example/v1/embeddings', model: 'embed-a', apiKey: 'key-a' },
    { id: 'rag-b', name: 'B 家嵌入', endpoint: 'https://b.example/v1/embeddings', model: 'embed-b', apiKey: '' },
  ]
  let bookRoot: string
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `rag-res-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    bookRoot = join(workDir, 'mybook')
    mkdirSync(bookRoot, { recursive: true })
    mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
    delete process.env.CLWRITING_RAG_API_KEY
  })

  it('readRagConfig：rag.provider 解析（yaml rag 段新键）', () => {
    writeFileSync(
      join(bookRoot, 'book.yaml'),
      'book:\n  title: 测试\nrag:\n  enabled: true\n  provider: rag-a\n',
      'utf-8',
    )
    const cfg = readRagConfig(bookRoot)
    expect(cfg).toMatchObject({ enabled: true, provider: 'rag-a' })
  })

  it('未启用 → null（不管配了什么）', () => {
    expect(resolveRag({ enabled: false, provider: 'rag-a' }, PROVIDERS, workDir)).toBeNull()
  })

  it('书级 provider 命中 → 服务商的 endpoint/model/key，legacy=false', () => {
    const r = resolveRag({ enabled: true, provider: 'rag-a' }, PROVIDERS, workDir)
    expect(r).toMatchObject({
      endpoint: 'https://a.example/v1/embeddings',
      model: 'embed-a',
      apiKey: 'key-a',
      providerId: 'rag-a',
      providerName: 'A 家嵌入',
    })
    expect(r!.legacy).toBeUndefined()
  })

  it('env CLWRITING_RAG_API_KEY 覆盖一切落盘 key（服务商/旧内联两链同权）', () => {
    process.env.CLWRITING_RAG_API_KEY = 'env-key'
    const byProvider = resolveRag({ enabled: true, provider: 'rag-a' }, PROVIDERS, workDir)
    expect(byProvider!.apiKey).toBe('env-key')
    const byLegacy = resolveRag({ enabled: true, endpoint: 'https://x', model: 'm' }, PROVIDERS, workDir)
    expect(byLegacy!.apiKey).toBe('env-key')
  })

  it('服务商 key 缺失 → apiKey 空串（调用方按场景报错），不误判为未配置', () => {
    const r = resolveRag({ enabled: true, provider: 'rag-b' }, PROVIDERS, workDir)
    expect(r).not.toBeNull()
    expect(r!.apiKey).toBe('')
  })

  it('服务商被删（id 无命中）→ null：不静默回落旧内联（防换端点烧钱）', () => {
    expect(resolveRag({ enabled: true, provider: 'rag-gone' }, PROVIDERS, workDir)).toBeNull()
  })

  it('旧版内联回落：endpoint/model + rag.secret，legacy=true', () => {
    writeFileSync(join(workDir, '.clwriting', 'rag.secret'), 'legacy-key\n', 'utf8')
    const r = resolveRag({ enabled: true, endpoint: 'https://legacy.example/v1/embeddings', model: 'old-model' }, PROVIDERS, workDir)
    expect(r).toMatchObject({
      endpoint: 'https://legacy.example/v1/embeddings',
      model: 'old-model',
      apiKey: 'legacy-key',
      legacy: true,
    })
  })

  it('两条链都不完整 → null', () => {
    expect(resolveRag({ enabled: true }, PROVIDERS, workDir)).toBeNull()
    expect(resolveRag({ enabled: true, endpoint: 'https://only-endpoint' }, PROVIDERS, workDir)).toBeNull()
  })
})

describe('RAG store（per-book .cache/rag.db，向量 BLOB 往返，余弦）', () => {
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
    arr[0] = 9
    const back = bufferToFloat32(buf)
    expect(back.length).toBe(arr.length)
    expect(back[0]).toBeCloseTo(0.1, 5)
    for (let i = 0; i < arr.length; i++) {
      if (i === 0) continue
      expect(back[i]).toBeCloseTo(arr[i]!, 5)
    }
  })

  it('bufferToFloat32 显式拷贝 BLOB，不共享底层内存', () => {
    const buf = float32ToBuffer(new Float32Array([0.1, 0.2, 0.3]))
    const back = bufferToFloat32(buf)

    buf.writeFloatLE(9, 0)

    expect(back[0]).toBeCloseTo(0.1, 5)
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

  it('RAG 库落 .cache/rag.db（M1：per-book，与 index.db 同区）', () => {
    const db = openRagDb(bookRoot)
    db.close()
    expect(existsSync(join(bookRoot, '.cache', 'rag.db'))).toBe(true)
    expect(existsSync(join(bookRoot, '.rag.db'))).toBe(false) // 不再往书根裸放
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
    // 维度不一致不崩、不截断误算
    expect(cosineSimilarity(new Float32Array([1, 0]), a)).toBe(0)
  })
})

// ── hh §八-11：.rag.db → .cache/rag.db 兼容迁移 ──────────────────────

describe('RAG 库迁移（hh §八-11：.rag.db → .cache/rag.db）', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(bookRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  /** 在旧路径（书根裸 .rag.db）造一个有数据的库，模拟升级前版本留下的现场 */
  function seedLegacyDb(): void {
    const db = new DatabaseSync(join(bookRoot, '.rag.db'))
    createRagTables(db)
    storeChunk(db, { 章号: 1, start_offset: 0, end_offset: 42, embedding: new Float32Array([1, 0, 0]), model: 'legacy-model' })
    setRagMeta(db, 'embedding_model', 'legacy-model')
    setRagMeta(db, 'indexed_max_chapter', '1')
    db.close()
  }

  it('旧路径有库 → openRagDb 迁到新路径，旧路径消失，数据完好', () => {
    seedLegacyDb()
    // 迁移前 ragDbExists 就应为 true——status 存在性探测不得误报「未建索引」
    expect(ragDbExists(bookRoot)).toBe(true)

    const db = openRagDb(bookRoot)
    try {
      const chunks = readAllChunks(db)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.model).toBe('legacy-model')
      expect(getRagMeta(db, 'indexed_max_chapter')).toBe('1')
      expect(getRagMeta(db, 'embedding_model')).toBe('legacy-model')
    } finally {
      db.close()
    }
    expect(existsSync(join(bookRoot, '.cache', 'rag.db'))).toBe(true)
    expect(existsSync(join(bookRoot, '.rag.db'))).toBe(false)
  })

  it('WAL 侧车（崩溃残留的 -wal/-shm）随主库一并迁走，不留旧处', () => {
    seedLegacyDb()
    writeFileSync(join(bookRoot, '.rag.db-wal'), 'sidecar')
    writeFileSync(join(bookRoot, '.rag.db-shm'), 'sidecar')

    expect(resolveRagDbPath(bookRoot)).toBe(join(bookRoot, '.cache', 'rag.db'))
    expect(existsSync(join(bookRoot, '.cache', 'rag.db-wal'))).toBe(true)
    expect(existsSync(join(bookRoot, '.cache', 'rag.db-shm'))).toBe(true)
    expect(existsSync(join(bookRoot, '.rag.db-wal'))).toBe(false)
    expect(existsSync(join(bookRoot, '.rag.db-shm'))).toBe(false)
  })

  it('新路径已存在 → 不迁（旧库残留原样保留，走新库）', () => {
    seedLegacyDb()
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    const fresh = new DatabaseSync(join(bookRoot, '.cache', 'rag.db'))
    createRagTables(fresh)
    storeChunk(fresh, { 章号: 9, start_offset: 0, end_offset: 10, embedding: new Float32Array([0, 1, 0]), model: 'new-model' })
    fresh.close()

    const db = openRagDb(bookRoot)
    try {
      const chunks = readAllChunks(db)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]!.model).toBe('new-model') // 读的是新库，不是旧库
    } finally {
      db.close()
    }
    expect(existsSync(join(bookRoot, '.rag.db'))).toBe(true) // 旧残留不动
  })

  it('迁移失败（.cache 建不成，模拟跨卷/权限）→ 降级开旧库，不抛错', () => {
    seedLegacyDb()
    // 把 .cache 占成普通文件 → mkdirSync 必失败，rename 无法进行
    writeFileSync(join(bookRoot, '.cache'), 'not a dir')

    const db = openRagDb(bookRoot)
    try {
      expect(readAllChunks(db)).toHaveLength(1) // 旧库数据照常可读
      expect(getRagMeta(db, 'indexed_max_chapter')).toBe('1')
    } finally {
      db.close()
    }
    expect(existsSync(join(bookRoot, '.rag.db'))).toBe(true) // 旧库原地未动
    expect(ragDbExists(bookRoot)).toBe(true)
  })

  it('从未建过库 → ragDbExists false；openRagDb 建在 .cache/rag.db', () => {
    expect(ragDbExists(bookRoot)).toBe(false)
    const db = openRagDb(bookRoot)
    db.close()
    expect(ragDbExists(bookRoot)).toBe(true)
    expect(existsSync(join(bookRoot, '.cache', 'rag.db'))).toBe(true)
    expect(existsSync(join(bookRoot, '.rag.db'))).toBe(false)
  })
})

// ── RB-IF-P2-3：createRagTables catch 分错误类型 ──────────────────────

describe('createRagTables 错误分类（RB-IF-P2-3）', () => {
  /** 假 db：记录全部 exec/prepare 语句；唯一索引语句按 failUnique 抛错；COUNT 查询返回 dupCount */
  function fakeDb(
    failUnique: (attempt: number) => Error | null,
    dupCount: number,
  ): { db: DatabaseSync; execs: string[] } {
    const execs: string[] = []
    let uniqueAttempts = 0
    const db = {
      exec(sql: string): void {
        execs.push(sql)
        if (sql.includes('idx_chunks_unique')) {
          uniqueAttempts++
          const err = failUnique(uniqueAttempts)
          if (err) throw err
        }
      },
      prepare(sql: string): { get: () => unknown } {
        execs.push(sql)
        return { get: () => (sql.includes('HAVING COUNT(*) > 1') ? { n: dupCount } : undefined) }
      },
    }
    return { db: db as unknown as DatabaseSync, execs }
  }

  function uniqueErr(): Error {
    return Object.assign(new Error('UNIQUE constraint failed: chunks.章号'), { errcode: 2067 })
  }

  it('非约束错误（磁盘满/IO/库被锁）→ 原样上抛，不执行 DELETE 去重', () => {
    const { db, execs } = fakeDb(() => new Error('disk I/O error'), 1)
    expect(() => createRagTables(db)).toThrow('disk I/O error')
    expect(execs.some((s) => s.includes('DELETE FROM chunks'))).toBe(false)
  })

  it('约束错误但 COUNT 证实无重复行 → 上抛不删（防误删有效向量）', () => {
    const { db, execs } = fakeDb(() => uniqueErr(), 0)
    expect(() => createRagTables(db)).toThrow('UNIQUE constraint')
    expect(execs.some((s) => s.includes('DELETE FROM chunks'))).toBe(false)
  })

  it('约束错误 + 确有重复行 → 先 DELETE 去重再重建唯一索引', () => {
    let thrown = false
    const { db, execs } = fakeDb(() => {
      if (thrown) return null // 第二次建索引成功
      thrown = true
      return uniqueErr()
    }, 3)
    expect(() => createRagTables(db)).not.toThrow()
    expect(execs.filter((s) => s.includes('DELETE FROM chunks'))).toHaveLength(1)
    expect(execs.filter((s) => s.includes('idx_chunks_unique') && !s.includes('HAVING'))).toHaveLength(2)
  })
})

// ── V-P2-4：enableRag 读改写不丢注释/未知段（文本级补丁）──────────────

describe('enableRag 保真（V-P2-4）', () => {
  let bookRoot: string
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `rag-keep-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    bookRoot = join(workDir, 'mybook')
    mkdirSync(bookRoot, { recursive: true })
  })
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('注释、未知段、未知子键逐字保留；rag 段原位替换', () => {
    const raw = [
      'spec_version: 1',
      '# 作者备注：这本书的预算别动',
      '',
      'book:',
      '  title: 测试',
      '  genre: 玄幻',
      '  custom_field: 42',
      '',
      'rag:',
      '  enabled: false',
      '  endpoint: http://old',
      '',
      'plugin_unknown:',
      '  key: value',
    ].join('\n') + '\n'
    writeFileSync(join(bookRoot, 'book.yaml'), raw, 'utf-8')

    const r = enableRag(bookRoot, workDir, { endpoint: 'https://api.example.com/v1/embeddings', model: 'm1' })
    expect(r.ok).toBe(true)

    const after = readFileSync(join(bookRoot, 'book.yaml'), 'utf-8')
    expect(after).toContain('# 作者备注：这本书的预算别动') // 注释保留
    expect(after).toContain('custom_field: 42') // 已知段未知子键保留
    expect(after).toContain('plugin_unknown:') // 未知段保留
    expect(after).toContain('  key: value')
    expect(after).not.toContain('enabled: false') // rag 段被替换
    expect(after).toContain('enabled: true')
    expect(after.indexOf('plugin_unknown:')).toBeGreaterThan(after.indexOf('rag:')) // 段序不变

    // 解析口径：rag 生效
    const cfg = readBookConfig(join(bookRoot, 'book.yaml')).config
    expect(cfg.rag?.enabled).toBe(true)
    expect(cfg.rag?.endpoint).toBe('https://api.example.com/v1/embeddings')
  })

  it('无 rag 段 → 追加到文件尾，其余原样', () => {
    const raw = 'spec_version: 1\n\nbook:\n  title: 测试\n  genre: 玄幻\n# 尾注释\n'
    writeFileSync(join(bookRoot, 'book.yaml'), raw, 'utf-8')
    const r = enableRag(bookRoot, workDir, { model: 'm2' })
    expect(r.ok).toBe(true)
    const after = readFileSync(join(bookRoot, 'book.yaml'), 'utf-8')
    expect(after).toContain('# 尾注释')
    expect(after).toContain('rag:')
    expect(after).toContain('model: m2')
    expect(readRagConfig(bookRoot)).toMatchObject({ enabled: true, model: 'm2' })
  })

  it('合并语义：不带新值调用 → 保留旧 endpoint/model', () => {
    const raw = 'spec_version: 1\n\nrag:\n  enabled: false\n  endpoint: http://keep-me\n  model: keep-model\n'
    writeFileSync(join(bookRoot, 'book.yaml'), raw, 'utf-8')
    const r = enableRag(bookRoot, workDir, {})
    expect(r.ok).toBe(true)
    expect(readRagConfig(bookRoot)).toMatchObject({ enabled: true, endpoint: 'http://keep-me', model: 'keep-model' })
  })
})
