import { describe, expect, it } from 'vitest'
import { searchKnowledge } from '@/services/search'
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
})
