<script setup>
import { computed } from 'vue';
import SessionRow from './SessionRow.vue';
import { STATUS_STYLES } from './statusStyles.js';
import { visibleBadges, pillClass } from './ciBadge.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  name: { type: String, required: true },
  sessions: { type: Array, required: true }, // [{ sessionId, title, lastPrompt, updatedAt, lastEvent, ... }]
  status: { type: String, required: true },
  now: { type: Number, default: () => Date.now() },
  ci: { type: Object, default: null },
});
const emit = defineEmits(['open', 'send-message']);

const isQuestion = computed(() => props.status === 'question');
const style = computed(() => STATUS_STYLES[props.status]);
const badges = computed(() => visibleBadges(props.ci?.users));
const overflowTitle = computed(() => badges.value.overflow.map((b) => `${b.login} — ${b.state}`).join('\n'));

function open(sessionId) {
  emit('open', { name: props.name, sessionId });
}
</script>

<template>
  <div
    :class="['rounded-xl bg-white shadow-md p-3 border-l-4', style.border, isQuestion ? style.ring : '']"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="font-medium text-slate-800 min-w-0 truncate">{{ name }}</div>
      <div class="flex items-center gap-1 shrink-0">
        <span
          v-for="b in badges.shown" :key="b.login"
          data-test="ci-badge"
          role="img"
          :title="`${b.login} — ${b.state}`"
          :aria-label="`${b.login} — ${b.state}`"
          :class="['text-[10px] leading-none font-semibold border rounded-sm px-1 py-0.5', pillClass(b.state)]"
        >{{ b.initials }}</span>
        <span
          v-if="badges.overflow.length"
          data-test="ci-overflow"
          role="img"
          :title="overflowTitle"
          :aria-label="overflowTitle"
          class="text-[10px] leading-none font-semibold border border-slate-300 bg-slate-100 text-slate-500 rounded-sm px-1 py-0.5"
        >+{{ badges.overflow.length }}</span>
      </div>
    </div>
    <p v-if="sessions.length === 0" class="mt-1 text-xs text-slate-400">{{ t('card.noActiveSession') }}</p>
    <div v-else class="mt-2 flex flex-col gap-1.5">
      <SessionRow v-for="s in sessions" :key="s.sessionId" :session="s" :repo-name="name" :now="now" @open="open" @send-message="$emit('send-message', $event)" />
    </div>
  </div>
</template>
