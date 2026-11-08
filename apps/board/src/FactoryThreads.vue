<script setup>
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
  running: 'text-accent',
  idle: 'text-ink-faint',
  failed: 'text-question-on-soft',
  archived: 'text-ink-faint',
};
const LINK = 'text-xs text-accent hover:underline';
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <button
        type="button"
        data-test="factory-new"
        class="whitespace-nowrap rounded-control bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-strong"
        @click="emit('new')"
      >{{ t('factory.newRequest') }}</button>
      <label class="flex items-center gap-1 text-xs text-ink-muted">
        <input data-test="factory-archived-toggle" type="checkbox" :checked="archived" @change="emit('toggle-archived')"> {{ t('factory.showArchived') }}
      </label>
    </div>
    <p v-if="threads.length === 0" data-test="factory-no-threads" class="text-xs text-ink-faint">{{ t('factory.noThreads') }}</p>
    <ul class="flex flex-col gap-1">
      <li v-for="thread in threads" :key="thread.id" class="flex items-start gap-1">
        <button
          type="button"
          :data-test="`factory-thread-${thread.id}`"
          :class="['flex min-w-0 flex-1 flex-col rounded-control px-2 py-1 text-left text-sm', selected === thread.id ? 'bg-surface-muted' : 'hover:bg-surface-hover']"
          @click="emit('select', thread.id)"
        >
          <span class="truncate font-medium text-ink">{{ thread.title }}</span>
          <span class="text-xs text-ink-faint">
            <span :class="BADGE[thread.status]">{{ t(`factory.thread.${thread.status}`) }}</span>
            · {{ relativeTime(thread.updatedAt, now) }}
          </span>
        </button>
        <button v-if="archived" type="button" :data-test="`factory-restore-${thread.id}`" :class="LINK" @click="emit('restore', thread.id)">{{ t('factory.restore') }}</button>
        <button v-else type="button" :data-test="`factory-archive-${thread.id}`" :class="LINK" @click="emit('archive', thread.id)">{{ t('factory.archive') }}</button>
      </li>
    </ul>
  </div>
</template>
