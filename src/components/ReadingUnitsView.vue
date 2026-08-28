<script setup lang="ts">
import { computed, ref } from 'vue'
import { BookOpen, ChevronRight, Search, X } from 'lucide-vue-next'
import type { KnowledgeUnit, Message, Session } from '@/types/domain'
import { renderMarkdown } from '@/services/markdown'

const props = defineProps<{ units: KnowledgeUnit[]; sessions: Session[]; messages: Message[]; selectedUnitId?: string | null }>()
const emit = defineEmits<{ (event: 'select', unitId: string): void; (event: 'close'): void }>()
const query = ref('')
const sessionTitle = (id: string) => props.sessions.find((session) => session.id === id)?.title || '未知会话'
const filteredUnits = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return props.units.filter((unit) => `${unit.title ?? ''} ${unit.summary ?? ''} ${sessionTitle(unit.sessionId)}`.toLocaleLowerCase().includes(needle)).slice().sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
})
const selected = computed(() => props.units.find((unit) => unit.id === props.selectedUnitId) ?? null)
const selectedMessages = computed(() => selected.value ? props.messages.filter((message) => message.unitId === selected.value?.id).sort((a, b) => a.orderInSession - b.orderInSession) : [])
const rendered = (message: Message) => renderMarkdown(message.content)
</script>

<template>
  <section class="view-panel units-view">
    <div class="page-toolbar"><div><span class="eyebrow">READING EXCERPTS</span><h2>阅读片段</h2></div><div class="compact-search"><Search :size="15" /><input v-model="query" placeholder="搜索标题、摘要或会话" aria-label="搜索阅读片段" /></div></div>
    <div class="units-layout"><div class="unit-list surface-section"><button v-for="unit in filteredUnits" :key="unit.id" class="unit-list-row" :class="{ selected: selectedUnitId === unit.id }" @click="emit('select', unit.id)"><BookOpen :size="16" /><div><strong>{{ unit.title || '未命名阅读片段' }}</strong><span>{{ unit.summary || '暂无摘要' }}</span><small>{{ sessionTitle(unit.sessionId) }} · {{ new Date(unit.updatedAt || unit.createdAt).toLocaleString('zh-CN') }}</small></div><ChevronRight :size="15" /></button><div v-if="!filteredUnits.length" class="empty-state compact"><BookOpen :size="28" /><strong>没有匹配的阅读片段</strong><span>生成或导入整理结果后，阅读片段会按最近更新显示。</span></div></div><div class="unit-detail surface-section"><template v-if="selected"><div class="detail-header"><div><span class="eyebrow">READING EXCERPT</span><h3>{{ selected.title || '未命名阅读片段' }}</h3><span class="detail-subtitle">{{ sessionTitle(selected.sessionId) }} · {{ new Date(selected.updatedAt || selected.createdAt).toLocaleString('zh-CN') }}</span></div><button class="icon-button" aria-label="关闭阅读片段详情" title="关闭" @click="emit('close')"><X :size="17" /></button></div><p class="unit-summary-copy">{{ selected.summary || '暂无摘要' }}</p><div class="message-stack"><article v-for="message in selectedMessages" :key="message.id" class="message-card" :class="message.role"><span>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI' : '系统' }}</span><div class="md-body" v-html="rendered(message)" /></article><div v-if="!selectedMessages.length" class="empty-inline">该片段暂未关联原始消息。</div></div></template><div v-else class="empty-detail"><BookOpen :size="30" /><strong>选择一个阅读片段</strong><span>按时间浏览片段，查看完整内容和来源会话。</span></div></div></div>
  </section>
</template>
