<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, ChevronDown, Search } from 'lucide-vue-next'
import { cleanGraphText } from '@/services/graph'

export interface SearchSelectOption {
  value: string | null
  label: string
  hint?: string
}

export type SearchSelectValue = string | null | string[]

const props = withDefaults(defineProps<{
  modelValue: SearchSelectValue
  options: SearchSelectOption[]
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  multiple?: boolean
}>(), { placeholder: '搜索并选择', ariaLabel: '搜索选择', disabled: false })

const emit = defineEmits<{ (event: 'update:modelValue', value: SearchSelectValue): void }>()
const rootElement = ref<HTMLElement | null>(null)
const triggerElement = ref<HTMLButtonElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')

const selectedValues = computed<string[]>(() => {
  if (Array.isArray(props.modelValue)) return props.modelValue.filter((value): value is string => typeof value === 'string')
  return typeof props.modelValue === 'string' ? [props.modelValue] : []
})
const selected = computed(() => {
  if (props.multiple) return null
  return props.options.find((option) => option.value === props.modelValue) ?? null
})
const selectedOptions = computed(() => selectedValues.value
  .map((value) => props.options.find((option) => option.value === value))
  .filter(Boolean) as SearchSelectOption[])
const displayText = (value: unknown) => cleanGraphText(value)
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return props.options
  return props.options.filter((option) => `${displayText(option.label)} ${displayText(option.hint)}`.toLocaleLowerCase().includes(needle))
})

function choose(value: string | null): void {
  if (props.multiple) {
    if (value === null) {
      emit('update:modelValue', [])
    } else {
      const next = selectedValues.value.includes(value)
        ? selectedValues.value.filter((item) => item !== value)
        : [...selectedValues.value, value]
      emit('update:modelValue', next)
    }
    query.value = ''
    return
  }
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
  // WebView focus transitions can report a null relatedTarget while the
  // pointer is moving from the trigger into the popover. Defer that case to
  // the next microtask so an inside click cannot close the list before its
  // click handler runs.
  if (!nextTarget) {
    queueMicrotask(() => {
      const active = document.activeElement
      if (active instanceof Node && rootElement.value?.contains(active)) return
      open.value = false
      query.value = ''
    })
    return
  }
  open.value = false
  query.value = ''
}

function closeOnPointerDown(event: PointerEvent): void {
  const target = event.target
  if (target instanceof Node && rootElement.value?.contains(target)) return
  open.value = false
  query.value = ''
}

onMounted(() => document.addEventListener('pointerdown', closeOnPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOnPointerDown, true))

watch(() => props.modelValue, () => { if (!open.value) query.value = '' })
</script>

<template>
  <div ref="rootElement" class="search-select" :class="{ open, disabled }" @focusout="closeOnFocusOut">
    <button ref="triggerElement" type="button" class="search-select-trigger" :aria-label="props.ariaLabel" aria-haspopup="listbox" :aria-expanded="open" :aria-multiselectable="props.multiple || undefined" :disabled="props.disabled" @click="toggleOpen">
      <span v-if="props.multiple && selectedOptions.length" class="search-select-chips"><span v-for="option in selectedOptions" :key="option.value ?? 'none'" class="search-select-chip">{{ displayText(option.label) }}</span></span>
      <span v-else :class="{ placeholder: !selected }">{{ displayText(selected?.label) || (props.multiple ? props.placeholder : props.placeholder) }}</span>
      <ChevronDown :size="14" />
    </button>
    <div v-if="open" class="search-select-popover" role="listbox" :aria-label="props.ariaLabel" @pointerdown.stop @mousedown.stop>
      <label class="search-select-input"><Search :size="14" /><input ref="searchInput" v-model="query" :placeholder="props.placeholder" :aria-label="`${props.ariaLabel}搜索`" @keydown.esc.prevent="closeAndRestoreFocus" /></label>
      <button v-for="option in filtered" :key="option.value ?? 'none'" type="button" class="search-select-option" :class="{ selected: props.multiple ? selectedValues.includes(option.value as string) : option.value === props.modelValue }" @mousedown.prevent @click="choose(option.value)">
        <span><strong>{{ displayText(option.label) }}</strong><small v-if="option.hint">{{ displayText(option.hint) }}</small></span>
        <Check v-if="props.multiple ? selectedValues.includes(option.value as string) : option.value === props.modelValue" :size="14" />
      </button>
      <p v-if="!filtered.length" class="search-select-empty">没有匹配项</p>
    </div>
  </div>
</template>
