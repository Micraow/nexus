import { describe, expect, it } from 'vitest'
import {
  buildConceptPrompt,
  buildConversationPrompt,
  buildHarnessPrompt,
  buildMaintenancePrompt,
  buildOriginConceptPrompt,
  buildRepairPrompt,
  buildSegmentationPrompt,
  buildSessionTriagePrompt,
  buildTitleSummaryPrompt,
  formatDisclosureContext,
  formatMaintenanceActionApi,
  maintenanceActionDefinition,
  maintenanceMcpToolsList,
  maintenanceToolCallSuggestion,
  listMaintenanceMcpTools,
  NEXUS_HARNESS_PROMPT,
  MAINTENANCE_ACTION_API,
  parseDisclosureContext,
  PROGRESSIVE_DISCLOSURE_PROTOCOL,
  replaceDisclosureContext,
} from '@/services/prompts'

const session = { id: 's', source: 'local' as const, platform: 'local', title: '会话', createdAt: '', updatedAt: '', messageCount: 1, unitCount: 1, knowledgeKind: 'knowledge' as const, knowledgeRetainInGraph: true, revision: 1, localOnly: true }
const unit = { id: 'u', sessionId: 's', title: null, summary: null, orderInSession: 0, status: 'pending' as const, revision: 1, createdAt: '', updatedAt: '' }

describe('unit metadata prompt', () => {
  it('requests title and summary in one structured response', () => {
    const prompt = buildTitleSummaryPrompt(session, unit, [{ id: 'm', sessionId: 's', role: 'user', content: '讨论', orderInSession: 0 }], [])
    expect(prompt).toContain('一次生成标题和摘要')
    expect(prompt).toContain('{"title":"...","summary":"..."}')
    expect(prompt).toContain('不超过 30 个中文字符')
    expect(prompt).toContain('不超过 120 个中文字符')
  })
})

describe('conversation prompt', () => {
  it('requests Session metadata and carries the current exploration path', () => {
    const prompt = buildConversationPrompt({
      question: '继续解释',
      topic: '网络',
      context: '',
      navigationPath: '1. 网络\n2. Clos',
      conversationHistory: '消息 #1 [assistant]\n先前回答',
      targetSessionId: 'session-1',
      targetMessageId: 'question-1',
      targetAssistantMessageId: 'answer-1',
    })
    expect(prompt).toContain('session_title')
    expect(prompt).toContain('session_summary')
    expect(prompt).toContain('1. 网络\n2. Clos')
    expect(prompt).toContain('先前回答')
    expect(prompt).toContain('本次 assistant Message ID：answer-1')
    expect(prompt).toContain('"client_ref":"new:1"')
    expect(prompt).toContain('本轮绝不能返回空数组')
    expect(prompt).toContain('units[].concepts 也必须是对象数组')
    expect(prompt).toContain('Nexus 标记只能出现在 answer 字符串中')
    expect(prompt).toContain('新建时必须省略 unit_id')
    expect(prompt).not.toContain('unit-eval-1')
    expect(prompt).not.toContain('如果回答没有稳定、可复用的证据片段，返回空数组')
    expect(prompt).toContain('黄色建议不要创建为 Concept')
    expect(prompt).toContain('语义范围最窄的已有直接父主题')
    expect(prompt).toContain('只有确无合适上位主题才允许暂作根')
    expect(prompt).toContain('relations 只表达 hierarchy')
    expect(prompt).toContain('related 不由对话模型返回')
    expect(prompt).toContain('回答中实际出现的词组')
    expect(prompt).toContain('编号列表、项目符号和表格')
    expect(prompt).toContain('严禁使用“原文”“正文”“主题名称”等占位文字')
    expect(prompt).toContain('教材的章节大标题或小标题')
    expect(prompt).toContain('多个具有独立知识含义的概念词，可以分别标记多个推荐词')
    expect(prompt).toContain('每个具有独立知识含义且尚未在目录确认存在的概念词都可以分别作为 suggested marker')
    expect(prompt).toContain('不要把多个概念合并成一个 marker')
    expect(prompt).toContain('最外层只能返回一个 JSON 对象，禁止 Markdown 围栏')
    expect(prompt).toContain('没有目录证据的独立概念一律使用 suggested')
    expect(prompt).toContain('禁止用字符串数组或 parent/child 替代字段')
    expect(prompt).not.toContain(']]原文[[/nexus]]')
  })

  it('makes hierarchy-first rules explicit for conversation concepts', () => {
    const prompt = buildConversationPrompt({ question: '继续', context: '', topic: '网络' })
    expect(prompt).toContain('根节点是例外')
    expect(prompt).toContain('最窄且有直接证据的父主题')
    expect(prompt).toContain('relations')
  })

  it('passes the configured Concept limit and disclosure availability into prompts', () => {
    const prompt = buildConversationPrompt({ question: '继续', context: '', conceptLimit: 3 })
    expect(prompt).toContain('最多 3 项')
    expect(prompt).toContain('new:1 到 new:3')
    expect(prompt).toContain('本 Prompt 没有提供 DISCLOSURE_INDEX 目录')
    expect(prompt).toContain('disclosure_requests 必须返回空数组 []')
    expect(prompt).not.toContain('DISCLOSURE_INDEX（首层目录与已展开记录）:')
  })

  it('only shows a real current unit id in reuse examples', () => {
    const firstTurn = buildConversationPrompt({ question: '第一轮', context: '', availableUnits: [] })
    expect(firstTurn).not.toContain('"unit_id"')
    const followUp = buildConversationPrompt({ question: '继续', context: '', availableUnits: [{ id: 'unit-real', title: '已有片段', summary: '摘要' }] })
    expect(followUp).toContain('"unit_id":"unit-real"')
  })
})

describe('maintenance prompt', () => {
  it('describes a graph-wide scope and exposes root direct-child index', () => {
    const prompt = buildMaintenancePrompt({
      concepts: [
        { id: 'root', name: '网络', aliases: [], summary: '网络', notes: '' },
        { id: 'child', name: 'RoCE', aliases: [], summary: 'RDMA 网络', notes: '' },
      ],
      relations: [{ sourceId: 'root', targetId: 'child', type: 'hierarchy', status: 'confirmed' }],
      units: [],
      scope: { conceptIds: ['child'] },
    })
    expect(prompt).toContain('维护的是整个知识图谱')
    expect(prompt).toContain('一级主题及直接子主题引用')
    expect(prompt).toContain('"direct_children"')
    expect(prompt).toContain('根节点是例外')
    expect(prompt).toContain('create_concept')
    expect(prompt).toContain('remove_hierarchy')
    expect(prompt).toContain('机器可读动作目录')
    for (const action of MAINTENANCE_ACTION_API) expect(prompt).toContain(`"type": "${action.type}"`)
  })

  it('requires graph maintenance to audit and repair missing reading units', () => {
    const prompt = buildMaintenancePrompt({
      concepts: [{ id: 'root', name: '网络', aliases: [], summary: '网络', notes: '' }],
      relations: [],
      units: [],
      messages: [
        { id: 'm1', sessionId: 's1', role: 'user', content: '什么是拥塞控制？' },
        { id: 'm2', sessionId: 's1', role: 'assistant', content: '拥塞控制用于避免网络过载。' },
      ],
    })
    expect(prompt).toContain('阅读片段覆盖审计（必查项）')
    expect(prompt).toContain('当前有 2 条未归属消息，分布在 1 个 Session')
    expect(prompt).toContain('必须提出 unit_create')
    expect(prompt).toContain('不能因为图谱层级无需修改而忽略')
    expect(prompt).toContain('分别交代 Concept/关系检查与阅读片段覆盖检查')
    expect(prompt).toContain('suggestions[].title 最长 30 个字符')
    expect(prompt).toContain('message_ids 是不透明字符串')
    expect(prompt).toContain('禁止生成、猜测、缩写、截断或引用目录外 ID')
  })

  it('publishes strict MCP-shaped schemas for every maintenance action', () => {
    const actions = new Map(MAINTENANCE_ACTION_API.map((action) => [action.type, action]))
    expect(actions.get('set_hierarchy_parents')?.input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['concept_id', 'parent_concept_ids', 'reason'],
    })
    expect(actions.get('set_hierarchy_parents')?.input_schema.properties.parent_concept_ids).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(actions.get('unit_relink')?.input_schema.properties.replace).toMatchObject({ type: 'boolean' })
    expect(actions.get('create_concept')?.input_schema.properties.parent_concept_id).toMatchObject({ type: ['string', 'null'] })
    expect(actions.get('update_concept')?.inputSchema.properties.summary).toMatchObject({ type: 'string', maxLength: 120 })
    expect(actions.get('unit_revision')?.inputSchema.properties.title).toMatchObject({ type: 'string', maxLength: 30 })
    expect(actions.get('unit_create')?.inputSchema.properties.title).toMatchObject({ type: 'string', maxLength: 30 })
    expect(actions.get('set_hierarchy_parents')?.input_schema.properties.parent_concept_ids).toMatchObject({ uniqueItems: true })
    expect(actions.get('remove_alias')?.input_schema.required).toContain('alias_id')
    expect(actions.get('set_relation_status')?.input_schema.properties.status).toMatchObject({ enum: ['proposed', 'confirmed', 'rejected'] })
    const serialized = JSON.parse(formatMaintenanceActionApi()) as Array<{ input_schema: { additionalProperties: boolean } }>
    expect(serialized.every((action) => action.input_schema.additionalProperties === false)).toBe(true)
    expect(actions.get('create_concept')).toMatchObject({ name: 'nexus_maintenance_create_concept', description: expect.any(String) })
    expect(actions.get('create_concept')?.inputSchema).toEqual(actions.get('create_concept')?.input_schema)
    expect(actions.get('remove_relation')).toMatchObject({ alias_for: 'delete_relation', deprecated: true })
    expect(actions.get('delete_relation')?.inputSchema.properties.reason).toMatchObject({ type: 'string', minLength: 1 })
    expect(actions.get('create_concept')?.inputSchema.properties.aliases).toMatchObject({ type: 'array', uniqueItems: true })
    expect(actions.get('create_concept')?.inputSchema.properties.parent_concept_ids).toMatchObject({ type: 'array', uniqueItems: true })
    expect(actions.get('create_concept')?.properties).toHaveProperty('reason', 'string')
    expect(listMaintenanceMcpTools().every((tool) => Object.keys(tool).sort().join(',') === 'description,inputSchema,name')).toBe(true)
    expect(listMaintenanceMcpTools().map((tool) => tool.name)).toContain('nexus_maintenance_set_hierarchy_parents')
    expect(maintenanceMcpToolsList().tools).toEqual(listMaintenanceMcpTools())
    expect(maintenanceActionDefinition('nexus_maintenance_merge')?.type).toBe('merge')
    expect(maintenanceActionDefinition('set_hierarchy_parents')?.name).toBe('nexus_maintenance_set_hierarchy_parents')
    expect(maintenanceToolCallSuggestion('nexus_maintenance_update_concept', JSON.stringify({ concept_id: 'c1', summary: '新摘要', reason: '证据' }))).toEqual({ type: 'update_concept', concept_id: 'c1', summary: '新摘要', reason: '证据' })
    expect(maintenanceToolCallSuggestion('nexus_maintenance_update_concept', '{bad')).toBeNull()
    expect(maintenanceToolCallSuggestion('nexus_maintenance_unknown', '{}')).toBeNull()
  })
})

describe('prompt harness and progressive disclosure', () => {
  it('keeps a stable prefix and does not double-wrap a prompt', () => {
    const prompt = buildHarnessPrompt('只返回 JSON：{"ok":true}')
    expect(prompt.startsWith(NEXUS_HARNESS_PROMPT)).toBe(true)
    expect(prompt.indexOf(NEXUS_HARNESS_PROMPT)).toBe(prompt.lastIndexOf(NEXUS_HARNESS_PROMPT))
    expect(prompt).toContain('--- NEXUS TASK SPEC BEGIN ---')
    expect(buildHarnessPrompt(prompt)).toBe(prompt)
    const halfWrapped = `${NEXUS_HARNESS_PROMPT}${prompt.slice(NEXUS_HARNESS_PROMPT.length, prompt.indexOf('--- NEXUS TASK SPEC BEGIN ---'))}旧任务`
    const normalized = buildHarnessPrompt(halfWrapped)
    expect(normalized.indexOf(NEXUS_HARNESS_PROMPT)).toBe(normalized.lastIndexOf(NEXUS_HARNESS_PROMPT))
    expect(normalized.indexOf(PROGRESSIVE_DISCLOSURE_PROTOCOL)).toBe(normalized.lastIndexOf(PROGRESSIVE_DISCLOSURE_PROTOCOL))
    const repair = buildRepairPrompt('{"bad":true}', ['缺少字段'], undefined, prompt)
    expect(repair.indexOf(NEXUS_HARNESS_PROMPT)).toBe(repair.lastIndexOf(NEXUS_HARNESS_PROMPT))
    expect(repair).toContain('原任务规格')
    expect(repair).toContain('只返回 JSON：{"ok":true}')
  })

  it('renders and parses recursive references without exposing content in child refs', () => {
    const context = {
      roots: [{ refID: 'concept_root', title: '网络', summary: '网络基础' }],
      expansions: [
        { refID: 'concept_root', children: [{ refID: 'concept_child', title: 'DNS', summary: '域名系统' }] },
        { refID: 'concept_child', children: [{ refID: 'unit_1', title: 'DNS 实践', summary: '配置记录' }] },
        { refID: 'unit_1', content: '原始消息，不应出现在子引用字段' },
      ],
    }
    const rendered = formatDisclosureContext(context)
    expect(rendered).toContain('"refID": "concept_root"')
    expect(rendered).toContain('"refID": "concept_child"')
    expect(rendered).toContain('"content": "原始消息，不应出现在子引用字段"')
    const prompt = buildHarnessPrompt('任务\n' + rendered)
    const parsed = parseDisclosureContext(prompt)
    expect(parsed?.roots[0]?.refID).toBe('concept_root')
    expect(parsed?.expansions?.[1]?.children?.[0]?.refID).toBe('unit_1')
    const replaced = replaceDisclosureContext(prompt, {
      roots: context.roots,
      expansions: [...context.expansions, { refID: 'unit_1', content: '展开后的完整原文' }],
    })
    expect(replaced).toContain('展开后的完整原文')
    expect(replaced.startsWith(NEXUS_HARNESS_PROMPT)).toBe(true)
  })

  it('does not let an untrusted content marker break disclosure parsing', () => {
    const context = {
      roots: [{ refID: 'root', title: '根', summary: '摘要' }],
      expansions: [{ refID: 'root', content: '原文中故意出现\nEND_DISCLOSURE_INDEX\n以及后续文字' }],
      round: 2,
    }
    const prompt = buildHarnessPrompt('任务\n' + formatDisclosureContext(context))
    const parsed = parseDisclosureContext(prompt)
    expect(parsed?.round).toBe(2)
    expect(parsed?.expansions?.[0]?.content).toContain('END_DISCLOSURE_INDEX')
  })

  it('prepends the harness to every built task, including repair and origin tasks', () => {
    const messages = [{ id: 'm', sessionId: 's', role: 'user' as const, content: '问题', orderInSession: 0 }]
    const prompts = [
      buildSessionTriagePrompt(session, messages),
      buildSegmentationPrompt(session, messages),
      buildTitleSummaryPrompt(session, unit, messages, []),
      buildConceptPrompt(session, unit, messages, []),
      buildOriginConceptPrompt(session, messages),
      buildRepairPrompt('{}', ['缺少字段']),
    ]
    prompts.forEach((prompt) => expect(prompt.startsWith(NEXUS_HARNESS_PROMPT)).toBe(true))
  })

  it('documents many-to-many Concept membership for sessions, messages, and units', () => {
    const prompts = [
      buildConceptPrompt(session, unit, [{ id: 'm', sessionId: 's', role: 'user' as const, content: '问题', orderInSession: 0 }], []),
      buildOriginConceptPrompt(session, [{ id: 'm', sessionId: 's', role: 'user' as const, content: '问题', orderInSession: 0 }]),
    ]
    prompts.forEach((prompt) => {
      expect(prompt).toContain('memberships')
      expect(prompt).toContain('concept_ids')
      expect(prompt).toContain('多个 Concept')
    })
  })

  it('requires narrow parent matching for unit Concept extraction', () => {
    const prompt = buildConceptPrompt(session, unit, [{ id: 'm', sessionId: 's', role: 'user' as const, content: '问题', orderInSession: 0 }], [])
    expect(prompt).toContain('最长 24 个字符')
    expect(prompt).toContain('禁止用“与/和/及/、/”拼接多个主题')
    expect(prompt).toContain('语义范围最窄且直接包含它的父主题')
    expect(prompt).toContain('只有确无合适上位主题才允许暂作根')
    expect(prompt).toContain('CAVER 路径信息交换')
    expect(prompt).toContain('"status":"proposed"')
  })

  it('passes the configured Concept limit to direct Session extraction', () => {
    const prompt = buildOriginConceptPrompt(session, [{ id: 'm', sessionId: 's', role: 'user' as const, content: '问题', orderInSession: 0 }], undefined, undefined, 3)
    expect(prompt).toContain('最多只能返回 3 个 Concept')
    expect(prompt).toContain('client_ref 只能使用 new:1 到 new:3')
    expect(prompt).toContain('不需要为前缀匹配另开 API 调用')
  })
})

describe('Session and Message Concept extraction contract', () => {
  const closMessages = [
    { id: 'clos-question-1', sessionId: 's', role: 'user' as const, content: 'Spine Leaf是不是就是Clos?', orderInSession: 0 },
    { id: 'clos-question-2', sessionId: 's', role: 'user' as const, content: 'fat tree是不是也是clos？', orderInSession: 1 },
    { id: 'clos-question-3', sessionId: 's', role: 'user' as const, content: '为什么clos不阻塞', orderInSession: 2 },
  ]

  it('extracts direct multi-memberships without making KnowledgeUnit a boundary', () => {
    const prompt = buildOriginConceptPrompt({ ...session, title: 'Spine Leaf与Clos关系', messageCount: 3 }, closMessages)

    expect(prompt).toContain('直接从下面的 Session 和 Message')
    expect(prompt).toContain('client_ref')
    expect(prompt).toContain('"target_type":"message"')
    expect(prompt).toContain('同一个 Session 或 Message 可以属于多个 Concept')
    expect(prompt).toContain('禁止返回 unit membership')
    expect(prompt).toContain('不要为了生成主题而先把对话分段')
    expect(prompt).not.toContain('默认关联到本 Session 中相关的所有 KnowledgeUnit')
  })

  it('defines sparse hierarchy and related semantics independently', () => {
    const prompt = buildOriginConceptPrompt({ ...session, title: 'Spine Leaf与Clos关系', messageCount: 3 }, closMessages)

    expect(prompt).toContain('source 是直接父主题、target 是直接子主题')
    expect(prompt).toContain('上位概念/下位概念')
    expect(prompt).toContain('related 是无向、非层级的稳定语义关系')
    expect(prompt).toContain('普通 Concept 提取和对话响应绝不能返回 related')
    expect(prompt).toContain('普通提取只能返回 hierarchy 建议')
    expect(prompt).toContain('"type":"hierarchy","status":"proposed"')
    expect(prompt).not.toContain('"type":"hierarchy|related"')
    expect(prompt).toContain('不要为了把所有 Concept 连起来而补关系')
    expect(prompt).toContain('请像绘制知识导图一样组织清晰的直接父主题→直接子主题结构')
    expect(prompt).toContain('语义范围最窄且确实包含它的已有父主题')
    expect(prompt).toContain('同批次父主题')
    expect(prompt).toContain('status 只能省略或为 proposed')
  })

  it('treats caller windows as technical input limits instead of knowledge boundaries', () => {
    const prompt = buildOriginConceptPrompt(
      { ...session, title: 'Spine Leaf与Clos关系', messageCount: 3 },
      closMessages,
      undefined,
      { index: 2, total: 4 },
    )

    expect(prompt).toContain('技术窗口 2/4')
    expect(prompt).toContain('不是 KnowledgeUnit、知识边界或独立会话')
    expect(prompt).toContain('不要仅凭局部窗口给整个 Session 建立归属')
  })
})
