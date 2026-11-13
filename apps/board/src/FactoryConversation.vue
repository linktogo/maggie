<script setup>
import { computed, nextTick, ref, watch } from 'vue';
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
  // A worktree removal in flight: its button stays disabled until it settles.
  removingWorktree: { type: Boolean, default: false },
});
const emit = defineEmits(['console', 'remove-worktree']);

const worktree = computed(() => props.thread.worktree ?? null);
// Only read under v-if="worktree".
const worktreeTooltip = computed(() => t('factory.worktree.tooltip', { path: worktree.value.path, base: worktree.value.base, ahead: worktree.value.ahead ?? '?' }));

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
  // Oldest first, read top to bottom like a terminal transcript; the composer sits below.
  return out;
});

// Follow the conversation: a new message (or a switch of thread) scrolls to the latest one.
const scroller = ref(null);
watch(() => [props.thread.id, props.messages.length], async () => {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}, { immediate: true });

// An agent turn that ends on a question is waiting for the user: it gets the question colours.
function asksQuestion(text) {
  const lastLine = String(text ?? '').trim().split('\n').at(-1);
  return /\?[\s*_`)"»]*$/.test(lastLine);
}

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

const BUBBLE = 'rounded-card border px-3.5 py-2.5 text-sm';
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <header class="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-2">
      <h3 class="min-w-0 truncate text-sm font-semibold text-ink-strong">{{ thread.title }}</h3>
      <span class="flex flex-wrap items-center gap-2">
        <span class="whitespace-nowrap rounded-badge bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">{{ [thread.provider, thread.model].filter(Boolean).join(' · ') }}</span>
        <span v-if="worktree" v-tooltip="worktreeTooltip" data-test="factory-worktree-badge" :aria-label="`${t('factory.worktree.badge')} ${worktree.branch}`" class="inline-flex items-center gap-1 whitespace-nowrap rounded-badge bg-worktree-soft px-1.5 py-0.5 font-mono text-[11px] text-worktree-on-soft">
          <Icon name="branch" emoji="⎇" :size="14" /> {{ worktree.branch }}
          <span v-if="worktree.exists === false" class="text-question-on-soft">{{ t('factory.worktree.missing') }}</span>
          <span v-if="worktree.dirty === true" data-test="factory-worktree-dirty" class="rounded-control border border-line px-1 text-ink-muted">{{ t('factory.worktree.dirty') }}</span>
          <!-- A disabled button gets no pointer events: the tooltip sits on its wrapper. -->
          <span v-tooltip="t('factory.worktree.remove')">
            <button
              type="button" data-test="factory-worktree-remove" :disabled="thread.status === 'running' || removingWorktree" :aria-label="t('factory.worktree.remove')"
              class="inline-flex items-center rounded-control p-0.5 opacity-70 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
              @click="emit('remove-worktree')"
            ><Icon name="close" emoji="✕" :size="14" /></button>
          </span>
        </span>
        <!-- A disabled button gets no pointer events: the tooltip sits on its wrapper. -->
        <span v-tooltip="consoleLabel">
          <button
            type="button" data-test="factory-console-button" :disabled="!consoleAvailable" :aria-label="consoleLabel"
            class="btn !h-7 !px-2 !text-xs disabled:cursor-not-allowed disabled:opacity-40"
            @click="emit('console')"
          ><Icon name="terminal" emoji="⌘" :size="16" /> {{ t('factory.console.open') }}</button>
        </span>
      </span>
    </header>
    <slot name="tabs" />
    <div v-show="showMessages" ref="scroller" data-test="factory-messages" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
      <template v-for="item in items" :key="item.id">
        <details v-if="item.type === 'steps'" data-test="factory-steps" class="group ml-5 text-xs text-ink-muted">
          <summary class="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-badge px-1.5 py-0.5 font-mono hover:bg-surface-hover before:text-ink-faint before:transition-transform before:content-['›'] group-open:before:rotate-90 [&::-webkit-details-marker]:hidden">{{ stepsLabel(item.steps) }}</summary>
          <ul class="mt-1.5 ml-2 flex flex-col gap-1 border-l border-line pl-3 font-mono">
            <li v-for="s in item.steps" :key="s.id"><span class="font-medium text-ink-soft">{{ s.content.tool }}</span> {{ s.content.summary }}</li>
          </ul>
        </details>
        <div v-else-if="item.message.kind === 'status'" data-test="factory-outcome" class="flex items-center gap-3 font-mono text-[11px] text-ink-faint before:h-px before:flex-1 before:bg-line-soft after:h-px after:flex-1 after:bg-line-soft">{{ outcomeLabel(item.message.content) }}</div>
        <p v-else-if="item.message.kind === 'error'" data-test="factory-error-message" class="alert text-xs text-question-on-soft">{{ item.message.content }}</p>
        <div v-else-if="item.message.role === 'user'" data-test="factory-user" :class="[BUBBLE, 'max-w-[85%] self-end whitespace-pre-wrap border-line-soft bg-surface-muted text-ink']">{{ item.message.content }}</div>
        <div
          v-else-if="asksQuestion(item.message.content)" data-test="factory-agent" data-question
          :class="[BUBBLE, 'border-question-ring bg-question-soft text-ink']"
        >
          <p class="mb-1.5 flex items-center gap-1 text-xs font-semibold text-question-on-soft"><Icon name="reply" emoji="❓" :size="16" /> {{ t('factory.question') }}</p>
          <!-- eslint-disable-next-line vue/no-v-html -- sanitised by DOMPurify in renderMarkdown -->
          <div class="markdown break-words" v-html="renderMarkdown(item.message.content)" />
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- sanitised by DOMPurify in renderMarkdown -->
        <div v-else data-test="factory-agent" class="markdown relative min-w-0 pl-5 text-sm text-ink break-words before:absolute before:left-0.5 before:top-[0.5em] before:size-2 before:rounded-full before:bg-accent" v-html="renderMarkdown(item.message.content)" />
      </template>
    </div>
    <slot name="composer" />
  </div>
</template>
