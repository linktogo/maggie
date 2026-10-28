<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useBoard } from './useBoard.js';
import { useConfig } from './useConfig.js';
import { useCi } from './useCi.js';
import { useNotifications } from './useNotifications.js';
import { useDayHistory } from './useDayHistory.js';
import { useBudgetAlerts } from './useBudgetAlerts.js';
import { dayTotal } from './dayCost.js';
import { budget } from './budget.js';
import BudgetSettings from './BudgetSettings.vue';
import { useNow } from './useRelativeTime.js';
import { useI18n } from './i18n.js';
import LocaleSwitcher from './LocaleSwitcher.vue';
import ThemeSwitcher from './ThemeSwitcher.vue';
import ModeSwitcher from './ModeSwitcher.vue';
import Icon from './Icon.vue';
import { ciReasonLabel } from './labels.js';

const { t } = useI18n();

const props = defineProps({
  fetchImpl: { type: Function, default: undefined },
  intervalMs: { type: Number, default: 3000 },
});
const fetchImpl = props.fetchImpl ?? fetch;

const { repos, transitions, connected, loaded: boardLoaded, refresh } = useBoard({ intervalMs: props.intervalMs, fetchImpl });
const { repos: config } = useConfig({ fetchImpl });
const { repos: ci, syncError: ciError } = useCi({ fetchImpl });
const now = useNow();
const route = useRoute();

const questionCount = computed(() => {
  let n = 0;
  for (const repoEntry of Object.values(repos.value)) {
    for (const s of Object.values(repoEntry.sessions ?? {})) {
      if (s.status === 'question') n += 1;
    }
  }
  return n;
});
const { permission, soundOn, requestPermission, toggleSound } = useNotifications(transitions, questionCount, {});

// The day total needs closed sessions from /api/history; that is only fetched
// while a day threshold is set.
const dayEnabled = computed(() => budget.value.day !== null);
// A session closing is the only thing that grows the history, so refetch when
// the number of live sessions changes rather than on every board poll.
const liveSessionCount = computed(() => Object.values(repos.value).reduce((n, r) => n + Object.keys(r.sessions ?? {}).length, 0));
const { entries: dayEntries, loaded: historyLoaded } = useDayHistory({ fetchImpl, enabled: dayEnabled, refreshOn: liveSessionCount });
// Ready only once both halves of the total have arrived, so a reload never takes
// its baseline from one of them alone.
const dayReady = computed(() => boardLoaded.value && historyLoaded.value);
const dayCost = computed(() => (dayEnabled.value ? dayTotal(repos.value, dayEntries.value, now.value) : null));
useBudgetAlerts({ repos, dayCost, dayReady, now, permission, soundOn });

const ciUnavailable = computed(() => {
  for (const repo of Object.values(ci.value)) {
    if (repo?.unavailable) return repo.unavailable;
  }
  return null;
});

const routeProps = computed(() => {
  if (route.name === 'history') return { fetchImpl };
  if (route.name === 'retro-doc') return { config: config.value, now: now.value, fetchImpl };
  return { repos: repos.value, config: config.value, ci: ci.value, now: now.value, fetchImpl, refresh, dayCost: dayCost.value, dayPartial: dayEnabled.value && !historyLoaded.value };
});
</script>

<template>
  <main class="min-h-screen p-4 sm:p-6">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <div class="flex items-center gap-3 flex-wrap">
        <h1 class="text-xl font-bold text-ink-strong whitespace-nowrap">maggie · {{ t('app.subtitle') }}</h1>
        <div class="inline-flex items-center bg-surface-muted rounded-control p-0.5 gap-0.5 text-sm">
          <router-link
            data-test="view-board" to="/"
            :class="['nav-tab rounded-control px-3 py-1 font-medium whitespace-nowrap transition-colors', route.name === 'board' ? 'bg-surface shadow-panel text-ink-strong' : 'text-ink-muted hover:text-ink-soft']"
          >{{ t('nav.board') }}</router-link>
          <router-link
            data-test="view-history" to="/history"
            :class="['nav-tab rounded-control px-3 py-1 font-medium whitespace-nowrap transition-colors', route.name === 'history' ? 'bg-surface shadow-panel text-ink-strong' : 'text-ink-muted hover:text-ink-soft']"
          >{{ t('nav.history') }}</router-link>
          <router-link
            data-test="view-retro-doc" to="/retro-doc"
            :class="['nav-tab rounded-control px-3 py-1 font-medium whitespace-nowrap transition-colors', route.name === 'retro-doc' ? 'bg-surface shadow-panel text-ink-strong' : 'text-ink-muted hover:text-ink-soft']"
          >{{ t('nav.retroDoc') }}</router-link>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <ThemeSwitcher />
        <ModeSwitcher />
        <LocaleSwitcher />
        <button
          v-if="permission !== 'granted'"
          class="border border-line rounded-control shadow-panel hover:shadow-card hover:bg-surface-hover px-3 py-1.5 text-sm bg-surface"
          @click="requestPermission"
        ><Icon name="notifications" emoji="🔔" /> {{ t('notifications.enable') }}</button>
        <BudgetSettings />
        <button
          class="border border-line rounded-control shadow-panel hover:shadow-card hover:bg-surface-hover px-3 py-1.5 text-sm bg-surface"
          :class="soundOn ? 'text-ink-soft' : 'text-ink-faint'"
          @click="toggleSound"
        ><Icon :name="soundOn ? 'volume_up' : 'volume_off'" :emoji="soundOn ? '🔊' : '🔇'" /> {{ t('notifications.sound') }}</button>
      </div>
    </div>

    <p v-if="!connected" class="mb-3 text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ t('banner.disconnected') }}</p>
    <p v-if="ciError" data-test="ci-desync" class="mb-3 text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ t('banner.ciDesync', { reason: ciReasonLabel(ciError) }) }}</p>
    <p v-if="ciUnavailable" data-test="ci-unavailable-banner" class="mb-3 text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ t('banner.ciUnavailable', { reason: ciReasonLabel(ciUnavailable) }) }}</p>
    <p v-if="permission === 'denied'" class="mb-3 text-xs text-ink-muted">{{ t('notifications.blocked') }}</p>

    <router-view v-slot="{ Component }">
      <component :is="Component" v-bind="routeProps" />
    </router-view>
  </main>
</template>
