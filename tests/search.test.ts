import { describe, expect, it } from 'vitest'
import { rankSearchDocuments, searchKnowledge } from '@/services/search'
import type { Concept, ConceptAlias, KnowledgeUnit, Message } from '@/types/domain'

const concept = (id: string, name: string, updatedAt = '2026-08-25T00:00:00.000Z'): Concept => ({
  id,
  name,
  normalizedName: name.toUpperCase(),
  notes: '',
  status: 'active',
  mergedIntoId: null,
  createdAt: updatedAt,
  updatedAt,
  deletedAt: null,
})

const unit = (id: string, title: string, summary: string): KnowledgeUnit => ({
  id,
  sessionId: 'session_1',
  title,
  summary,
  orderInSession: 0,
  status: 'ready',
  revision: 1,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
})

const message = (id: string, content: string): Message => ({
  id,
  sessionId: 'session_1',
  unitId: null,
  role: 'assistant',
  content,
  orderInSession: 0,
  timestamp: '2026-08-25T00:00:00.000Z',
  metadata: null,
})

describe('中文知识搜索', () => {
  it('支持中文短语、别名和字符级回退', () => {
    const rdma = concept('c1', 'RDMA 拥塞控制')
    const aliases: ConceptAlias[] = [{
      id: 'a1', conceptId: 'c1', alias: '远程直接内存访问', normalizedAlias: '远程直接内存访问', source: 'manual', createdAt: rdma.createdAt,
    }]
    const result = searchKnowledge('内存访问', {
      concepts: [rdma], aliases, units: [], messages: [],
    })
    expect(result.concepts.map((item) => item.item.id)).toEqual(['c1'])
    expect(result.concepts[0]?.field).toBe('alias')
  })

  it('按知识主题名称、单元标题、摘要和正文的优先级排序', () => {
    const concepts = [concept('c1', '向量数据库')]
    const units = [unit('u1', '向量数据库实践', '部署与索引'), unit('u2', '检索系统', '向量数据库作为摘要中的内容')]
    const messages = [message('m1', '正文提到向量数据库')]
    const result = searchKnowledge('向量数据库', { concepts, aliases: [], units, messages })
    expect(result.concepts[0]?.item.id).toBe('c1')
    expect(result.units[0]?.item.id).toBe('u1')
    expect(result.units[1]?.item.id).toBe('u2')
    expect(result.messages[0]?.item.id).toBe('m1')
  })

  it('英文名称匹配不区分大小写', () => {
    const result = searchKnowledge('rdma', { concepts: [concept('c1', 'RDMA')], aliases: [], units: [], messages: [] })
    expect(result.concepts[0]?.item.name).toBe('RDMA')
  })

  it('带空格的中文短语经字符级回退命中，排序低于子串直接命中', () => {
    const spaced = unit('u_spaced', '拥塞控制协议', '')
    const exact = unit('u_exact', '拥塞 控制入门', '')
    const result = searchKnowledge('拥塞 控制', { concepts: [], aliases: [], units: [spaced, exact], messages: [] })
    // 查询里的空格使子串匹配失败，回退按二元组命中“拥塞控制协议”；无空格的标题子串命中排前。
    expect(result.units.map((item) => item.item.id)).toEqual(['u_exact', 'u_spaced'])
  })

  it('二元组覆盖率不足 72% 时不返回模糊结果', () => {
    const result = searchKnowledge('拥塞协议', { concepts: [], aliases: [], units: [unit('u1', '拥塞控制协议', '')], messages: [] })
    // “拥塞协议”的三个二元组只有两个出现在文本里（缺“塞协”），按设计不命中，避免过度召回。
    expect(result.units).toEqual([])
  })

  it('FTS5 bm25 仅作为同分时的决胜项', () => {
    const documents = [
      { id: 'message:m1', kind: 'message' as const, refId: 'm1', fields: { content: '拥塞控制' }, updatedAt: '2026-08-25T00:00:00.000Z' },
      { id: 'message:m2', kind: 'message' as const, refId: 'm2', fields: { content: '拥塞控制' }, updatedAt: '2026-08-25T00:00:00.000Z' },
    ]
    const ranked = rankSearchDocuments('拥塞', documents, new Map([['message:m2', -1], ['message:m1', -5]]))
    // bm25 越接近 0 越好：m2（rank=-1）排在 m1（rank=-5）之前，其余得分完全相同。
    expect(ranked.map((item) => item.refId)).toEqual(['m2', 'm1'])
  })
})
