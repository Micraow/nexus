// @vitest-environment jsdom

import initSqlJs from 'sql.js'
import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { SqliteStore } from '@/services/db'

const storageKey = 'nexus:sqlite:v1'

function encode(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)))
  }
  return btoa(binary)
}

const wasmPath = resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm')
const memoryStorage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { memoryStorage.set(key, value) },
    removeItem: (key: string) => { memoryStorage.delete(key) },
    clear: () => memoryStorage.clear(),
  },
})

afterEach(() => memoryStorage.clear())

describe('database schema migration', () => {
  it('moves legacy message concept_ids metadata into the v4 join table', async () => {
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    const legacy = new SQL.Database()
    legacy.run(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '3');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, platform TEXT NOT NULL, model TEXT,
        external_session_id TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
        unit_count INTEGER NOT NULL DEFAULT 0, knowledge_kind TEXT NOT NULL DEFAULT 'unknown',
        knowledge_confidence REAL, knowledge_judgment TEXT,
        knowledge_retain_in_graph INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, local_only INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, unit_id TEXT, role TEXT NOT NULL,
        content TEXT NOT NULL, order_in_session INTEGER NOT NULL, timestamp TEXT, metadata TEXT
      );
      CREATE TABLE concepts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, normalized_name TEXT NOT NULL UNIQUE,
        notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
        merged_into_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE TABLE llm_tasks (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, mode TEXT NOT NULL, provider_id TEXT,
        model TEXT, prompt_version TEXT NOT NULL, input_revision TEXT NOT NULL,
        prompt TEXT NOT NULL, response TEXT, parsed_result TEXT, validation_errors TEXT,
        status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, error_message TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, scope_label TEXT
      );
    `)
    const now = '2026-08-26T00:00:00.000Z'
    legacy.run("INSERT INTO sessions(id, source, platform, title, created_at, updated_at) VALUES ('s1', 'local', 'local', '迁移测试', ?, ?)", [now, now])
    legacy.run("INSERT INTO concepts(id, name, normalized_name, created_at, updated_at) VALUES ('c1', '主题一', '主题一', ?, ?), ('c2', '主题二', '主题二', ?, ?)", [now, now, now, now])
    legacy.run("INSERT INTO messages(id, session_id, role, content, order_in_session, metadata) VALUES ('m1', 's1', 'user', '内容', 0, ?)", [JSON.stringify({ concept_ids: ['c1', 'c2', 'missing'] })])
    legacy.run("INSERT INTO llm_tasks(id, type, mode, prompt_version, input_revision, prompt, status, created_at, updated_at) VALUES ('legacy-segmentation', 'segmentation', 'prompt_paste', 'legacy', 's1:1', 'legacy prompt', 'pending', ?, ?)", [now, now])
    localStorage.setItem(storageKey, encode(legacy.export()))
    legacy.close()

    const store = new SqliteStore()
    await store.init()

    expect(store.getMeta('schema_version')).toBe('8')
    expect(store.query<{ summary: string }>('SELECT summary FROM sessions WHERE id = ?', ['s1'])[0]?.summary).toBe('')
    expect(store.query<{ summary: string }>('SELECT summary FROM concepts WHERE id = ?', ['c1'])[0]?.summary).toBe('')
    expect(store.query<{ message_id: string; concept_id: string }>('SELECT message_id, concept_id FROM message_concepts ORDER BY concept_id')).toEqual([
      { message_id: 'm1', concept_id: 'c1' },
      { message_id: 'm1', concept_id: 'c2' },
    ])
    expect(store.query<{ metadata: string }>('SELECT metadata FROM messages WHERE id = ?', ['m1'])[0]?.metadata).toContain('missing')
    expect(store.query<{ status: string; error_message: string }>('SELECT status, error_message FROM llm_tasks WHERE id = ?', ['legacy-segmentation'])[0]).toMatchObject({
      status: 'cancelled',
      error_message: expect.stringContaining('已停用'),
    })
  })
})
