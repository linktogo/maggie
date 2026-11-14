<script setup>
import { ref, computed } from 'vue';
import { relativeTime } from './useRelativeTime.js';
import { formatTokens } from './formatTokens.js';
import { agentOf, agentLabel, agentPillClass } from './agentBadge.js';
import { useI18n } from './i18n.js';
import Icon from './Icon.vue';
import { vTooltip } from './tooltip.js';
import { eventLabel } from './labels.js';
import { describeUsage } from './liveUsage.js';
import { costText, costTitle } from './costDisplay.js';
import { budget } from './budget.js';
import { STATUS_STYLES } from './statusStyles.js';

const { t } = useI18n();

const PROMPT_CLIP = 140;

const props = defineProps({
  session: { type: Object, required: true },
  repoName: { type: String, default: '' },
  now: { type: Number, default: () => Date.now() },
});
const emit = defineEmits(['open', 'send-message']);

const expanded = ref(false);
const draft = ref('');
const when = computed(() => relativeTime(props.session.updatedAt, props.now));
const prompt = computed(() => props.session.lastPrompt ?? '');
const overflows = computed(() => prompt.value.length > PROMPT_CLIP);
const displayedPrompt = computed(() => (
  expanded.value || !overflows.value ? prompt.value : `${prompt.value.slice(0, PROMPT_CLIP)}…`
));

const agent = computed(() => agentOf(props.session));

const usage = computed(() => props.session.usage ?? null);
const described = computed(() => describeUsage(usage.value));
const overBudget = computed(() => budget.value.session !== null && described.value !== null && described.value.cost >= budget.value.session);
// Both are only read by the token badge, which renders only when there is
// usage — and with usage, `described` is never null.
const totalTokens = computed(() => {
  const u = usage.value;
  return u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
});
const usageTooltip = computed(() => {
  const u = usage.value;
  const tokens = t('session.usageTooltip', {
    input: u.inputTokens,
    output: u.outputTokens,
    cacheWrite: u.cacheCreationInputTokens,
    cacheRead: u.cacheReadInputTokens,
  });
  return `${tokens}\n${costTitle(described.value)}`;
});

function open() { emit('open', props.session.sessionId); }
function toggle(e) { e.stopPropagation(); expanded.value = !expanded.value; }
function send() {
  const text = draft.value.trim();
  if (!text) return;
  emit('send-message', { repo: props.repoName, sessionId: props.session.sessionId, text });
  draft.value = '';
}
function onDragStart(e) {
  e.dataTransfer.setData('application/json', JSON.stringify({ repo: props.repoName, sessionId: props.session.sessionId }));
  e.dataTransfer.effectAllowed = 'move';
}
</script>

<template>
  <div
    role="button"
    tabindex="0"
    data-test="session-row"
    draggable="true"
    class="group rounded-[min(var(--radius-control),0.75rem)] border border-line-soft bg-surface-muted p-2.5 cursor-grab transition-colors hover:border-line hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
    @click="open"
    @keydown.enter="open"
    @keydown.space.prevent="open"
    @dragstart="onDragStart"
  >
    <div class="truncate text-[13px] font-medium text-ink-strong">{{ session.title ?? t('session.untitled') }}</div>
    <div class="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-muted">
      <span :title="session.lastEvent" class="mr-0.5 font-mono">{{ eventLabel(session.lastEvent) }} · {{ when }}</span>
      <span
        data-test="agent-badge"
        :title="t('session.agentTooltip', { agent: agentLabel(agent) })"
        :class="['inline-flex items-center font-medium px-1.5 py-0.5 rounded-badge', agentPillClass(agent)]"
      >{{ agent }}</span>
      <span
        v-if="session.worktree"
        data-test="worktree-badge"
        :title="t('session.worktreeTooltip', { branch: session.worktree })"
        class="inline-flex items-center gap-0.5 max-w-full bg-worktree-soft text-worktree-on-soft font-medium px-1.5 py-0.5 rounded-badge"
      ><Icon name="account_tree" emoji="⎇" :size="14" /><span class="truncate">{{ session.worktree }}</span></span>
      <span v-if="described" data-test="cost-badge" :title="costTitle(described)" :class="['inline-flex items-center border font-medium px-1.5 py-0.5 rounded-badge', overBudget ? ['border-line-soft', STATUS_STYLES.question.chip] : 'bg-surface text-ink-soft border-line-soft']">{{ costText(described) }}</span>
      <span v-if="usage" data-test="token-badge" :title="usageTooltip" class="inline-flex items-center bg-surface text-ink-soft border border-line-soft font-medium px-1.5 py-0.5 rounded-badge">{{ t('session.tokens', { count: formatTokens(totalTokens) }) }}</span>
    </div>
    <p v-if="prompt" class="mt-2 border-l-2 border-line pl-2 text-xs leading-relaxed text-ink-soft whitespace-pre-wrap">
      {{ displayedPrompt }}
      <button
        v-if="overflows"
        type="button"
        data-test="toggle-prompt"
        class="text-accent hover:underline"
        @click="toggle"
      >{{ expanded ? t('session.showLess') : t('session.showMore') }}</button>
    </p>
    <form
      data-test="message-form"
      class="mt-2 flex items-center gap-1.5"
      draggable="false"
      @click.stop
      @mousedown.stop
      @dragstart.stop.prevent
      @submit.prevent="send"
    >
      <input
        v-model="draft"
        data-test="message-input"
        type="text"
        :placeholder="t('session.messagePlaceholder')"
        class="control !h-7 min-w-0 flex-1 !text-xs"
        @keydown.stop
      />
      <button
        type="submit"
        data-test="message-send"
        :disabled="!draft.trim()"
        :aria-label="t('session.send')"
        v-tooltip="t('session.send')"
        class="inline-flex size-7 shrink-0 items-center justify-center rounded-control bg-accent text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed"
      ><Icon name="send" emoji="➤" :size="16" /></button>
    </form>
  </div>
</template>
