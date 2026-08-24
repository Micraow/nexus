import { dump, load } from 'js-yaml'
import { invokeTauri, isTauriRuntime } from '@/services/tauri'
import type { AppConfig, ProviderConfig } from '@/types/domain'

const CONFIG_STORAGE_KEY = 'nexus:config:v1'

type YamlConfig = {
  llm?: {
    mode?: AppConfig['llm']['mode']
    default_provider?: string | null
    defaultProvider?: string | null
    concurrency?: number
    token_budget?: number
    tokenBudget?: number
    providers?: Array<Partial<ProviderConfig> & { base_url?: string; api_key?: string }>
    task_overrides?: Record<string, string>
    taskOverrides?: Record<string, string>
  }
  prompts?: { override_dir?: string; overrideDir?: string }
  ui?: {
    theme?: AppConfig['ui']['theme']
    reduced_motion?: boolean
    reducedMotion?: boolean
    graph?: {
      show_units?: boolean
      showUnits?: boolean
      show_messages?: boolean
      showMessages?: boolean
      show_proposed?: boolean
      showProposed?: boolean
    }
  }
  storage?: { database_path?: string; databasePath?: string }
}

export function serializeConfig(config: AppConfig): string {
  return dump({
    llm: {
      mode: config.llm.mode,
      default_provider: config.llm.defaultProvider,
      concurrency: config.llm.concurrency,
      token_budget: config.llm.tokenBudget,
      providers: config.llm.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        base_url: provider.baseUrl,
        model: provider.model,
        api_key: provider.apiKey,
      })),
      task_overrides: config.llm.taskOverrides,
    },
    prompts: { override_dir: config.prompts.overrideDir },
    ui: {
      theme: config.ui.theme,
      reduced_motion: config.ui.reducedMotion,
      graph: {
        show_units: config.ui.graph.showUnits,
        show_messages: config.ui.graph.showMessages,
        show_proposed: config.ui.graph.showProposed,
      },
    },
    storage: { database_path: config.storage.databasePath },
  }, { noRefs: true })
}

export function parseConfig(value: unknown): Partial<AppConfig> {
  if (!value || typeof value !== 'object') throw new Error('config.yaml 必须是对象')
  const raw = value as YamlConfig
  const providers = raw.llm?.providers?.map((provider) => ({
    id: String(provider.id ?? ''),
    name: String(provider.name ?? provider.id ?? ''),
    baseUrl: String(provider.base_url ?? provider.baseUrl ?? ''),
    model: String(provider.model ?? ''),
    apiKey: String(provider.api_key ?? provider.apiKey ?? ''),
  })).filter((provider) => provider.id) ?? []
  return {
    llm: {
      mode: raw.llm?.mode ?? null,
      defaultProvider: raw.llm?.default_provider ?? raw.llm?.defaultProvider ?? null,
      concurrency: Number.isInteger(raw.llm?.concurrency) ? Math.min(4, Math.max(1, raw.llm?.concurrency as number)) : 2,
      tokenBudget: Number.isInteger(raw.llm?.token_budget ?? raw.llm?.tokenBudget) ? Math.max(1000, Number(raw.llm?.token_budget ?? raw.llm?.tokenBudget)) : 8000,
      providers,
      taskOverrides: raw.llm?.task_overrides ?? raw.llm?.taskOverrides ?? {},
    },
    prompts: { overrideDir: raw.prompts?.override_dir ?? raw.prompts?.overrideDir ?? '' },
    ui: {
      theme: raw.ui?.theme ?? 'system',
      reducedMotion: raw.ui?.reduced_motion ?? raw.ui?.reducedMotion ?? false,
      graph: {
        showUnits: raw.ui?.graph?.show_units ?? raw.ui?.graph?.showUnits ?? false,
        showMessages: raw.ui?.graph?.show_messages ?? raw.ui?.graph?.showMessages ?? false,
        showProposed: raw.ui?.graph?.show_proposed ?? raw.ui?.graph?.showProposed ?? false,
      },
    },
    storage: { databasePath: raw.storage?.database_path ?? raw.storage?.databasePath ?? '' },
  }
}

export async function readConfigText(): Promise<string | null> {
  if (isTauriRuntime()) return await invokeTauri<string | null>('read_config')
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(CONFIG_STORAGE_KEY)
}

export function writeConfig(config: AppConfig): void {
  const content = serializeConfig(config)
  if (isTauriRuntime()) {
    void invokeTauri<void>('write_config', { content }).catch((error) => console.error('保存 config.yaml 失败', error))
    return
  }
  if (typeof localStorage !== 'undefined') localStorage.setItem(CONFIG_STORAGE_KEY, content)
}

export function parseConfigText(content: string): Partial<AppConfig> {
  return parseConfig(load(content))
}
