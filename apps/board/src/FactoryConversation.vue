<script setup>
import { computed } from 'vue';
import { renderMarkdown } from './markdown.js';
import Icon from './Icon.vue';
import { vTooltip } from './tooltip.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  thread: { type: Object, required: true },
  messages: { type: Array, required: true },
  consoleAvailable: { type: Boolean, default: false },
  consoleReason: { type: String, default: '' },
  showMessages: { type: Boolean, default: true },
});
const emit = defineEmits(['console']);

const consoleLabel = computed(() => (props.consoleAvailable
  ? t('factory.console.open')
  : t('factory.console.unavailable', { reason: props.consoleReason })));

// Consecutive steps of one run fold into a single block.
const items = computed(() => {
  const out = [];
  for (const message of props.messages) {
    const last = out.at(-1);
    if (message.kind === 'step') {
      if (last?.type === 'steps' && last.runId === message.runId) last.steps.push(message);
      else out.push({ type: 'steps', id: message.id, runId: message.runId, steps: [message] });
    } else {
      out.push({ type: 'message', id: message.id, message });
    }
  }
  return out;
});

function stepsLabel(steps) {
  const counts = new Map();
  for (const { content } of steps) counts.set(content.tool, (counts.get(content.tool) ?? 0) + 1);
  const tally = [...counts].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join(', ');
  return t(steps.length === 1 ? 'factory.steps.one' : 'factory.steps.other', { n: steps.length, tally });
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function outcomeLabel({ outcome, durationMs, costUsd }) {
  const parts = [t(`factory.outcome.${outcome}`)];
  if (durationMs != null) parts.push(duration(durationMs));
  if (costUsd != null) parts.push(`$${costUsd.toFixed(2)}`);
  return parts.join(' · ');
}

const BUBBLE = 'max-w-[85%] rounded-card border border-line px-3 py-2 text-sm';
</script>

<template>
  <div class="flex flex-col gap-3">
    <header class="flex items-baseline justify-between gap-2 border-b border-line pb-2">
      <h3 class="truncate font-semibold text-ink-strong">{{ thread.title }}</h3>
      <span class="flex items-center gap-2">
        <span class="whitespace-nowrap text-xs text-ink-faint">{{ [thread.provider, thread.model].filter(Boolean).join(' · ') }}</span>
        <!-- A disabled button gets no pointer events: the tooltip sits on its wrapper. -->
        <span v-tooltip="consoleLabel">
          <button
            type="button" data-test="factory-console-button" :disabled="!consoleAvailable" :aria-label="consoleLabel"
            class="inline-flex items-center gap-1 rounded-control border border-line bg-surface px-1.5 py-0.5 text-xs text-ink-soft hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            @click="emit('console')"
          ><Icon name="terminal" emoji="⌘" /> {{ t('factory.console.open') }}</button>
        </span>
      </span>
    </header>
    <slot name="tabs" />
    <div v-show="showMessages" class="flex flex-col gap-3">
      <template v-for="item in items" :key="item.id">
        <details v-if="item.type === 'steps'" data-test="factory-steps" class="text-xs text-ink-muted">
          <summary class="cursor-pointer">{{ stepsLabel(item.steps) }}</summary>
          <ul class="mt-1 flex flex-col gap-0.5 pl-4">
            <li v-for="s in item.steps" :key="s.id"><span class="font-medium text-ink-soft">{{ s.content.tool }}</span> {{ s.content.summary }}</li>
          </ul>
        </details>
        <div v-else-if="item.message.kind === 'status'" data-test="factory-outcome" class="border-t border-line pt-1 text-center text-xs text-ink-faint">{{ outcomeLabel(item.message.content) }}</div>
        <p v-else-if="item.message.kind === 'error'" data-test="factory-error-message" class="text-xs text-question-on-soft">{{ item.message.content }}</p>
        <div v-else-if="item.message.role === 'user'" data-test="factory-user" :class="[BUBBLE, 'self-end whitespace-pre-wrap bg-surface-muted text-ink']">{{ item.message.content }}</div>
        <!-- eslint-disable-next-line vue/no-v-html -- sanitised by DOMPurify in renderMarkdown -->
        <div v-else data-test="factory-agent" :class="[BUBBLE, 'self-start bg-surface text-ink-soft break-words']" v-html="renderMarkdown(item.message.content)" />
      </template>
    </div>
  </div>
</template>
