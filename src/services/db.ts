import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { invokeTauri, isTauriRuntime } from '@/services/tauri'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

const STORAGE_KEY = 'nexus:sqlite:v1'

function encode(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

function decode(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const schema = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  platform TEXT NOT NULL,
  model TEXT,
  external_session_id TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  unit_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  local_only INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_external ON sessions(platform, external_session_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  unit_id TEXT REFERENCES knowledge_units(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  order_in_session INTEGER NOT NULL,
  timestamp TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session_order ON messages(session_id, order_in_session);
CREATE TABLE IF NOT EXISTS knowledge_units (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT,
  summary TEXT,
  order_in_session INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_session_order ON knowledge_units(session_id, order_in_session);
CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  normalized_name TEXT NOT NULL UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  merged_into_id TEXT REFERENCES concepts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS concept_aliases (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  alias TEXT NOT NULL UNIQUE,
  normalized_alias TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS unit_concepts (
  unit_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (unit_id, concept_id)
);
CREATE TABLE IF NOT EXISTS concept_relations (
  id TEXT PRIMARY KEY,
  parent_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  child_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(parent_concept_id, child_concept_id, relation_type)
);
CREATE TABLE IF NOT EXISTS nav_tree_nodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES nav_tree_nodes(id) ON DELETE CASCADE,
  trigger_concept_id TEXT REFERENCES concepts(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  depth INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nav_tree_node_units (
  node_id TEXT NOT NULL REFERENCES nav_tree_nodes(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  order_in_node INTEGER NOT NULL,
  PRIMARY KEY(node_id, unit_id)
);
CREATE TABLE IF NOT EXISTS context_references (
  id TEXT PRIMARY KEY,
  target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_unit_id TEXT REFERENCES knowledge_units(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  order_in_context INTEGER NOT NULL,
  include_full_content INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS llm_tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  prompt_version TEXT NOT NULL,
  input_revision TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT,
  parsed_result TEXT,
  validation_errors TEXT,
  status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  scope_label TEXT
);
CREATE TABLE IF NOT EXISTS manual_graph_edges (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_ref_id TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_layout (
  node_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  fixed INTEGER NOT NULL DEFAULT 0,
  layout_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(node_type, ref_id)
);
CREATE TABLE IF NOT EXISTS quick_phrases (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
`

export class SqliteStore {
  private db: Database | null = null
  private sqlJs: SqlJsStatic | null = null
  private persistQueue: Promise<void> = Promise.resolve()

  async init(): Promise<void> {
    if (this.db) return
    this.sqlJs = await initSqlJs({ locateFile: () => wasmUrl })
    const stored = isTauriRuntime()
      ? await invokeTauri<string | null>('read_database')
      : typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    this.db = stored ? new this.sqlJs.Database(decode(stored)) : new this.sqlJs.Database()
    this.db.run('PRAGMA foreign_keys = ON;')
    this.db.run(schema)
    this.seedPhrases()
    this.setMeta('schema_version', '1')
    if (!this.getMeta('graph_revision')) this.setMeta('graph_revision', '1')
    this.persist()
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('数据库尚未初始化')
    return this.db
  }

  run(sql: string, params: unknown[] = []): void {
    this.requireDb().run(sql, params as any)
  }

  query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const results = this.requireDb().exec(sql, params as any)
    if (!results.length) return []
    const [result] = results
    return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])) as T)
  }

  transaction(callback: () => void): void {
    const db = this.requireDb()
    db.run('BEGIN')
    try {
      callback()
      db.run('COMMIT')
      this.persist()
    } catch (error) {
      db.run('ROLLBACK')
      throw error
    }
  }

  persist(): void {
    if (!this.db) return
    const encoded = encode(this.db.export())
    if (isTauriRuntime()) {
      this.persistQueue = this.persistQueue
        .then(() => invokeTauri<void>('write_database', { encoded }))
        .catch((error) => console.error('保存 nexus.db 失败', error))
      return
    }
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, encoded)
  }

  clear(): void {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
    this.db = null
  }

  getMeta(key: string): string | null {
    const rows = this.query<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', [key])
    return rows[0]?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
  }

  bumpGraphRevision(): number {
    const next = Number(this.getMeta('graph_revision') ?? '0') + 1
    this.setMeta('graph_revision', String(next))
    return next
  }

  private seedPhrases(): void {
    const count = this.query<{ count: number }>('SELECT COUNT(*) AS count FROM quick_phrases')[0]?.count ?? 0
    if (count > 0) return
    const phrases = [
      '$(topic) 是什么',
      '$(topic) 有什么好处',
      '$(topic) 有什么缺陷',
      '$(topic) 和 $(context) 有什么区别',
      '$(topic) 的实际应用场景',
      '$(topic) 的最新研究进展',
    ]
    phrases.forEach((template, index) => {
      this.run('INSERT INTO quick_phrases(id, template, is_builtin, sort_order) VALUES (?, ?, 1, ?)', [`phrase_${index + 1}`, template, index])
    })
  }
}

export const db = new SqliteStore()
