<script setup>
import { computed } from 'vue';
import SessionRow from './SessionRow.vue';
import Icon from './Icon.vue';
import { STATUS_STYLES } from './statusStyles.js';
import { visibleBadges, pillClass } from './ciBadge.js';
import { useI18n } from './i18n.js';
import { ciStateLabel } from './labels.js';

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
const overflowTitle = computed(() => badges.value.overflow.map((b) => `${b.login} — ${ciStateLabel(b.state)}`).join('\n'));

function open(sessionId) {
  emit('open', { name: props.name, sessionId });
}
</script>

<template>
  <div
    :class="['rounded-card bg-surface shadow-card p-card transition-shadow hover:shadow-overlay', isQuestion ? style.ring : '']"
  >
    <div class="flex items-start justify-between gap-2">
      <button
        type="button"
        data-test="open-repo"
        :title="t('card.openRepo', { repo: name })"
        class="flex min-w-0 items-center gap-1.5 text-left font-mono text-[13px] text-ink-strong card-title hover:text-accent"
        @click="emit('open', { name, sessionId: null })"
      ><Icon name="branch" :size="14" class="shrink-0 text-ink-faint" /><span class="truncate">{{ name }}</span></button>
      <div class="flex items-center gap-1 shrink-0">
        <span
          v-for="b in badges.shown" :key="b.login"
          data-test="ci-badge"
          role="img"
          :title="`${b.login} — ${ciStateLabel(b.state)}`"
          :aria-label="`${b.login} — ${ciStateLabel(b.state)}`"
          :class="['text-[10px] leading-none font-semibold border rounded-badge px-1 py-0.5', pillClass(b.state)]"
        >{{ b.initials }}</span>
        <span
          v-if="badges.overflow.length"
          data-test="ci-overflow"
          role="img"
          :title="overflowTitle"
          :aria-label="overflowTitle"
          :class="['text-[10px] leading-none font-semibold border rounded-badge px-1 py-0.5', pillClass('neutral')]"
        >+{{ badges.overflow.length }}</span>
      </div>
    </div>
    <p v-if="sessions.length === 0" class="mt-1 text-xs text-ink-faint">{{ t('card.noActiveSession') }}</p>
    <div v-else class="mt-2.5 flex flex-col gap-2">
      <SessionRow v-for="s in sessions" :key="s.sessionId" :session="s" :repo-name="name" :now="now" @open="open" @send-message="$emit('send-message', $event)" />
    </div>
  </div>
</template>
