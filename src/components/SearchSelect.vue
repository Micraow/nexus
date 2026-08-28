<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Check, ChevronDown, Search } from 'lucide-vue-next'
import { cleanGraphText } from '@/services/graph'

export interface SearchSelectOption {
  value: string | null
  label: string
  hint?: string
}

const props = withDefaults(defineProps<{
  modelValue: string | null
  options: SearchSelectOption[]
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
}>(), { placeholder: '搜索并选择', ariaLabel: '搜索选择', disabled: false })

const emit = defineEmits<{ (event: 'update:modelValue', value: string | null): void }>()
const rootElement = ref<HTMLElement | null>(null)
const triggerElement = ref<HTMLButtonElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')

const selected = computed(() => props.options.find((option) => option.value === props.modelValue) ?? null)
const displayText = (value: unknown) => cleanGraphText(value)
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return props.options
  return props.options.filter((option) => `${displayText(option.label)} ${displayText(option.hint)}`.toLocaleLowerCase().includes(needle))
})

function choose(value: string | null): void {
  emit('update:modelValue', value)
  open.value = false
  query.value = ''
}

async function toggleOpen(): Promise<void> {
  open.value = !open.value
  if (open.value) {
    await nextTick()
    searchInput.value?.focus()
  }
}

function closeAndRestoreFocus(): void {
  open.value = false
  query.value = ''
  triggerElement.value?.focus()
}

function closeOnFocusOut(event: FocusEvent): void {
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && rootElement.value?.contains(nextTarget)) return
  open.value = false
  query.value = ''
}

watch(() => props.modelValue, () => { if (!open.value) query.value = '' })
</script>

<template>
  <div ref="rootElement" class="search-select" :class="{ open, disabled }" @focusout="closeOnFocusOut">
    <button ref="triggerElement" type="button" class="search-select-trigger" :aria-label="props.ariaLabel" aria-haspopup="listbox" :aria-expanded="open" :disabled="props.disabled" @click="toggleOpen">
      <span :class="{ placeholder: !selected }">{{ displayText(selected?.label) || props.placeholder }}</span>
      <ChevronDown :size="14" />
    </button>
    <div v-if="open" class="search-select-popover" role="listbox" :aria-label="props.ariaLabel">
      <label class="search-select-input"><Search :size="14" /><input ref="searchInput" v-model="query" :placeholder="props.placeholder" :aria-label="`${props.ariaLabel}搜索`" @keydown.esc.prevent="closeAndRestoreFocus" /></label>
      <button v-for="option in filtered" :key="option.value ?? 'none'" type="button" class="search-select-option" :class="{ selected: option.value === props.modelValue }" @mousedown.prevent @click="choose(option.value)">
        <span><strong>{{ displayText(option.label) }}</strong><small v-if="option.hint">{{ displayText(option.hint) }}</small></span>
        <Check v-if="option.value === props.modelValue" :size="14" />
      </button>
      <p v-if="!filtered.length" class="search-select-empty">没有匹配项</p>
    </div>
  </div>
</template>
