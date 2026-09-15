<script setup>
import { computed } from 'vue';
import { STATUS_STYLES } from './statusStyles.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({ repos: { type: Object, required: true } });

// A repo with zero active sessions counts as one "todo" card (same
// placeholder behavior the board itself shows); otherwise every session
// counts individually, so a repo with two concurrent sessions counts twice.
const counts = computed(() => {
  const c = { todo: 0, inprogress: 0, question: 0, done: 0 };
  for (const repoEntry of Object.values(props.repos)) {
    const sessions = Object.values(repoEntry.sessions ?? {});
    if (sessions.length === 0) { c.todo += 1; continue; }
    for (const s of sessions) if (c[s.status] !== undefined) c[s.status] += 1;
  }
  return c;
});
const total = computed(() => Object.values(counts.value).reduce((a, b) => a + b, 0));
const percentDone = computed(() => (total.value ? Math.round((counts.value.done / total.value) * 100) : 0));
</script>

<template>
  <div class="bg-surface border border-line rounded-card shadow-panel px-4 py-3 mb-4">
    <div class="flex flex-wrap gap-2 mb-2.5">
      <span class="rounded-chip px-2 py-0.5 text-xs font-semibold bg-surface-muted text-ink-soft">{{ total }} {{ t('summary.repos') }}</span>
      <span :class="['rounded-chip px-2 py-0.5 text-xs font-semibold', STATUS_STYLES.todo.chip]">{{ counts.todo }} {{ t('status.todo') }}</span>
      <span :class="['rounded-chip px-2 py-0.5 text-xs font-semibold', STATUS_STYLES.inprogress.chip]">{{ counts.inprogress }} {{ t('status.inprogress') }}</span>
      <span :class="['rounded-chip px-2 py-0.5 text-xs font-semibold', STATUS_STYLES.question.chip]">{{ counts.question }} {{ t('status.question') }}</span>
      <span :class="['rounded-chip px-2 py-0.5 text-xs font-semibold', STATUS_STYLES.done.chip]">{{ counts.done }} {{ t('status.done') }}</span>
    </div>
    <div class="h-2.5 bg-surface-muted rounded-chip overflow-hidden">
      <div data-test="progress" class="h-full progress-fill rounded-chip" :style="{ width: percentDone + '%' }"></div>
    </div>
    <div class="text-xs text-ink-faint mt-1">{{ t('summary.percentDone', { percent: percentDone }) }}</div>
  </div>
</template>
