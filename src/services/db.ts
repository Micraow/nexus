import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { invokeTauri, isTauriRuntime } from '@/services/tauri'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

const STORAGE_KEY = 'nexus:sqlite:v1'
const BACKUP_STORAGE_PREFIX = 'nexus:sqlite:backup:'
const CURRENT_SCHEMA_VERSION = 2

export interface DatabaseIntegrityReport {
  ok: boolean
  result: string
  schemaVersion: number
}

export interface DatabaseBackup {
  reference: string
  createdAt: string
  runtime: 'tauri' | 'browser'
}

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
CREATE TABLE IF NOT EXISTS graph_viewport (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  scale REAL NOT NULL DEFAULT 1,
  layout_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS quick_phrases (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS operation_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_operation_log_created ON operation_log(created_at DESC);
`

const migrations: Array<{ version: number; apply: (database: Database) => void }> = [
  {
    version: 2,
    apply(database) {
      database.run(`
        CREATE TABLE IF NOT EXISTS search_documents (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          ref_id TEXT NOT NULL,
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_search_documents_kind_ref ON search_documents(kind, ref_id);
      `)
    },
  },
]

export class SqliteStore {
  private db: Database | null = null
  private sqlJs: SqlJsStatic | null = null
  private persistQueue: Promise<void> = Promise.resolve()
  private fts5Available = false
  private lastIntegrity: DatabaseIntegrityReport | null = null

  async init(): Promise<void> {
    if (this.db) return
    this.sqlJs = await initSqlJs({ locateFile: () => wasmUrl })
    const stored = isTauriRuntime()
      ? await invokeTauri<string | null>('read_database')
      : typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    this.db = stored ? new this.sqlJs.Database(decode(stored)) : new this.sqlJs.Database()
    this.db.run('PRAGMA foreign_keys = ON;')
    this.db.run(schema)
    const initialIntegrity = this.integrityCheck()
    if (!initialIntegrity.ok) {
      this.db.close()
      this.db = null
      throw new Error(`数据库完整性检查失败：${initialIntegrity.result}`)
    }
    const isNewDatabase = !stored
    const storedVersion = Number(this.getMeta('schema_version') ?? '1')
    if (!Number.isInteger(storedVersion) || storedVersion < 1) throw new Error('数据库 schema 版本无效')
    if (storedVersion < CURRENT_SCHEMA_VERSION) {
      let backup: DatabaseBackup | null = null
      try {
        if (!isNewDatabase) backup = await this.createBackup()
        this.applyMigrations(storedVersion)
      } catch (error) {
        if (backup) {
          try { await this.restoreBackup(backup.reference) } catch (restoreError) { console.error('恢复迁移备份失败', restoreError) }
        }
        throw new Error(`数据库迁移失败${backup ? `（备份：${backup.reference}）` : ''}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (storedVersion >= CURRENT_SCHEMA_VERSION) this.ensureCurrentSchema()
    this.ensureFts5()
    this.seedPhrases()
    this.setMeta('schema_version', String(CURRENT_SCHEMA_VERSION))
    if (!this.getMeta('graph_revision')) this.setMeta('graph_revision', '1')
    this.persist()
  }

  private applyMigrations(fromVersion: number): void {
    const database = this.requireDb()
    database.run('BEGIN')
    try {
      migrations.filter((migration) => migration.version > fromVersion).sort((left, right) => left.version - right.version).forEach((migration) => {
        migration.apply(database)
        database.run('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['schema_version', String(migration.version)])
      })
      database.run('COMMIT')
      this.persist()
    } catch (error) {
      database.run('ROLLBACK')
      throw error
    }
  }

  private ensureFts5(): void {
    const database = this.requireDb()
    try {
      const existing = database.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_documents_fts'")
      if (!existing.length) database.run('CREATE VIRTUAL TABLE search_documents_fts USING fts5(kind UNINDEXED, ref_id UNINDEXED, content)')
      this.fts5Available = true
    } catch {
      this.fts5Available = false
    }
  }

  private ensureCurrentSchema(): void {
    // Idempotent repair for databases created by pre-release builds that may
    // already report the latest version but missed a derived search table.
    this.requireDb().run(`
      CREATE TABLE IF NOT EXISTS search_documents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_search_documents_kind_ref ON search_documents(kind, ref_id);
    `)
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

  integrityCheck(): DatabaseIntegrityReport {
    this.requireDb()
    const result = this.query<{ integrity: string }>('PRAGMA integrity_check')[0]?.integrity ?? 'unknown'
    const report = { ok: result.toLowerCase() === 'ok', result, schemaVersion: Number(this.getMeta('schema_version') ?? '1') }
    this.lastIntegrity = report
    return report
  }

  getIntegrityReport(): DatabaseIntegrityReport | null {
    return this.lastIntegrity
  }

  supportsFts5(): boolean {
    return this.fts5Available
  }

  rebuildSearchDocuments(documents: Array<{ id?: string; kind: string; refId: string; content?: string; fields?: Record<string, string | undefined>; updatedAt: string }>): void {
    const database = this.requireDb()
    database.run('BEGIN')
    try {
      database.run('DELETE FROM search_documents')
      if (this.fts5Available) database.run('DELETE FROM search_documents_fts')
      documents.forEach((document, index) => {
        const id = document.id ?? `${document.kind}:${document.refId}`
        const content = document.content ?? Object.values(document.fields ?? {}).filter(Boolean).join('\n')
        database.run('INSERT INTO search_documents(id, kind, ref_id, content, updated_at) VALUES (?, ?, ?, ?, ?)', [id, document.kind, document.refId, content, document.updatedAt])
        if (this.fts5Available) database.run('INSERT INTO search_documents_fts(rowid, kind, ref_id, content) VALUES (?, ?, ?, ?)', [index + 1, document.kind, document.refId, content])
      })
      database.run('COMMIT')
      this.persist()
    } catch (error) {
      database.run('ROLLBACK')
      throw error
    }
  }

  searchFts(query: string): Array<{ kind: string; refId: string; rank: number }> {
    if (!this.fts5Available || !query.trim()) return []
    try {
      return this.query<{ kind: string; ref_id: string; rank: number }>(
        'SELECT kind, ref_id, bm25(search_documents_fts) AS rank FROM search_documents_fts WHERE search_documents_fts MATCH ? ORDER BY rank',
        [query.trim().replace(/["*]/g, ' ')],
      ).map((row) => ({ kind: row.kind, refId: row.ref_id, rank: Number(row.rank) }))
    } catch {
      return []
    }
  }

  async createBackup(): Promise<DatabaseBackup> {
    const createdAt = new Date().toISOString()
    if (isTauriRuntime()) {
      const reference = await invokeTauri<string | null>('backup_database')
      if (!reference) throw new Error('当前没有可备份的数据库')
      return { reference, createdAt, runtime: 'tauri' }
    }
    if (typeof localStorage === 'undefined') throw new Error('当前运行环境不支持数据库备份')
    const encoded = this.db ? encode(this.db.export()) : localStorage.getItem(STORAGE_KEY)
    if (!encoded) throw new Error('当前没有可备份的数据库')
    const reference = `${BACKUP_STORAGE_PREFIX}${Date.now()}`
    localStorage.setItem(reference, encoded)
    return { reference, createdAt, runtime: 'browser' }
  }

  async restoreBackup(reference: string): Promise<void> {
    if (isTauriRuntime()) {
      await invokeTauri<void>('restore_database_backup', { path: reference })
    } else {
      if (typeof localStorage === 'undefined') throw new Error('当前运行环境不支持数据库恢复')
      const encoded = localStorage.getItem(reference)
      if (!encoded) throw new Error('找不到数据库备份')
      localStorage.setItem(STORAGE_KEY, encoded)
    }
    if (this.db) this.db.close()
    this.db = null
    this.fts5Available = false
    this.lastIntegrity = null
    await this.init()
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
