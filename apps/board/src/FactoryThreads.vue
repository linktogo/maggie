<script setup>
import Icon from './Icon.vue';
import { useI18n } from './i18n.js';
import { relativeTime, useNow } from './useRelativeTime.js';

const { t } = useI18n();

defineProps({
  threads: { type: Array, required: true },
  selected: { type: String, default: '' },
  archived: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'new', 'toggle-archived', 'archive', 'restore']);

const now = useNow(30000);

const BADGE = {
  running: 'bg-accent-soft text-on-accent-soft',
  idle: 'bg-surface-muted text-ink-muted',
  failed: 'bg-question-soft text-question-on-soft',
  archived: 'bg-surface-muted text-ink-faint',
};
const DOT = {
  running: 'bg-accent status-dot-live',
  idle: 'bg-ink-faint',
  failed: 'bg-question-solid',
  archived: 'bg-ink-faint',
};
// Row actions stay out of the way until the row is hovered or focused.
const LINK = 'absolute right-2 top-2 rounded-badge bg-surface px-1.5 py-0.5 text-[11px] text-ink-muted opacity-0 transition-opacity hover:bg-surface-hover hover:text-ink-strong focus-visible:opacity-100 group-hover:opacity-100';
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-col gap-2.5 border-b border-line-soft p-3">
      <div class="flex items-center justify-between gap-2 px-1">
        <span class="eyebrow">{{ t('factory.requests') }}</span>
        <label class="flex items-center gap-1.5 text-xs text-ink-muted">
          <input data-test="factory-archived-toggle" type="checkbox" :checked="archived" @change="emit('toggle-archived')"> {{ t('factory.showArchived') }}
        </label>
      </div>
      <button
        type="button"
        data-test="factory-new"
        class="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-control bg-accent px-3 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-strong"
        @click="emit('new')"
      ><span aria-hidden="true" class="text-base leading-none">+</span> {{ t('factory.newRequest') }}</button>
    </div>
    <p v-if="threads.length === 0" data-test="factory-no-threads" class="p-4 text-xs text-ink-faint">{{ t('factory.noThreads') }}</p>
    <ul class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
      <li v-for="thread in threads" :key="thread.id" class="group relative flex items-start">
        <button
          type="button"
          :data-test="`factory-thread-${thread.id}`"
          :class="['flex min-w-0 flex-1 flex-col gap-1 rounded-control border px-2.5 py-2 text-left text-sm transition-colors', selected === thread.id ? 'border-line bg-surface-muted' : 'border-transparent hover:bg-surface-hover']"
          @click="emit('select', thread.id)"
        >
          <span class="flex items-center gap-1 font-medium text-ink-strong">
            <span v-if="thread.worktree" :data-test="`factory-thread-worktree-${thread.id}`" class="text-ink-faint"><Icon name="branch" emoji="⎇" :size="14" /></span>
            <span class="truncate">{{ thread.title }}</span>
          </span>
          <span class="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span :class="['inline-flex items-center gap-1 rounded-badge px-1.5 py-px font-medium', BADGE[thread.status]]"><span :class="['size-1.5 rounded-full', DOT[thread.status]]" aria-hidden="true"></span>{{ t(`factory.thread.${thread.status}`) }}</span>
            <span>{{ relativeTime(thread.updatedAt, now) }}</span>
          </span>
        </button>
        <button v-if="archived" type="button" :data-test="`factory-restore-${thread.id}`" :class="LINK" @click="emit('restore', thread.id)">{{ t('factory.restore') }}</button>
        <button v-else type="button" :data-test="`factory-archive-${thread.id}`" :class="LINK" @click="emit('archive', thread.id)">{{ t('factory.archive') }}</button>
      </li>
    </ul>
  </div>
</template>
