<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ChevronDown, Search } from 'lucide-vue-next'

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
const open = ref(false)
const query = ref('')

const selected = computed(() => props.options.find((option) => option.value === props.modelValue) ?? null)
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return props.options
  return props.options.filter((option) => `${option.label} ${option.hint ?? ''}`.toLocaleLowerCase().includes(needle))
})

function choose(value: string | null): void {
  emit('update:modelValue', value)
  open.value = false
  query.value = ''
}

function closeOnBlur(): void {
  window.setTimeout(() => { open.value = false }, 120)
}

watch(() => props.modelValue, () => { if (!open.value) query.value = '' })
</script>

<template>
  <div class="search-select" :class="{ open, disabled }" @focusout="closeOnBlur">
    <button type="button" class="search-select-trigger" :aria-label="props.ariaLabel" :aria-expanded="open" :disabled="props.disabled" @click="open = !open">
      <span :class="{ placeholder: !selected }">{{ selected?.label || props.placeholder }}</span>
      <ChevronDown :size="14" />
    </button>
    <div v-if="open" class="search-select-popover" role="listbox" :aria-label="props.ariaLabel">
      <label class="search-select-input"><Search :size="14" /><input v-model="query" autofocus :placeholder="props.placeholder" :aria-label="`${props.ariaLabel}搜索`" @keydown.esc.prevent="open = false" /></label>
      <button v-for="option in filtered" :key="option.value ?? 'none'" type="button" class="search-select-option" :class="{ selected: option.value === props.modelValue }" @mousedown.prevent="choose(option.value)">
        <span><strong>{{ option.label }}</strong><small v-if="option.hint">{{ option.hint }}</small></span>
        <Check v-if="option.value === props.modelValue" :size="14" />
      </button>
      <p v-if="!filtered.length" class="search-select-empty">没有匹配项</p>
    </div>
  </div>
</template>
