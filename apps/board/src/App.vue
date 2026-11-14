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

const FACTORY_ROUTES = new Set(['factory', 'factory-repo', 'factory-thread']);

const tabs = computed(() => [
  { test: 'view-board', to: '/', label: 'nav.board', active: route.name === 'board' },
  { test: 'view-history', to: '/history', label: 'nav.history', active: route.name === 'history' },
  { test: 'view-retro-doc', to: '/retro-doc', label: 'nav.retroDoc', active: route.name === 'retro-doc' },
  { test: 'view-factory', to: '/factory', label: 'nav.factory', active: FACTORY_ROUTES.has(route.name) },
]);

const routeProps = computed(() => {
  if (route.name === 'history') return { fetchImpl };
  if (route.name === 'retro-doc') return { config: config.value, now: now.value, fetchImpl };
  if (FACTORY_ROUTES.has(route.name)) return { fetchImpl };
  return { repos: repos.value, config: config.value, ci: ci.value, now: now.value, fetchImpl, refresh, dayCost: dayCost.value, dayPartial: dayEnabled.value && !historyLoaded.value };
});
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <header class="sticky top-0 z-30 border-b border-line bg-ground/85 backdrop-blur-md">
      <div class="mx-auto flex min-h-14 w-full max-w-[1680px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-6 lg:py-0">
        <div class="flex min-w-0 items-center gap-6 self-stretch">
          <h1 class="flex shrink-0 items-center gap-2.5 whitespace-nowrap">
            <img data-test="logo" class="logo-light size-6" src="/maggie-mark-light.svg" alt="" />
            <img data-test="logo-dark" class="logo-dark size-6" src="/maggie-mark-dark.svg" alt="" />
            <span class="text-[15px] font-semibold tracking-tight text-ink-strong">maggie</span>
            <span class="hidden h-4 w-px bg-line sm:block" aria-hidden="true"></span>
            <span class="hidden text-sm text-ink-muted sm:inline">{{ t('app.subtitle') }}</span>
          </h1>
          <nav class="-mb-px flex items-stretch self-stretch gap-1 overflow-x-auto text-sm">
            <router-link
              v-for="tab in tabs" :key="tab.test"
              :data-test="tab.test" :to="tab.to"
              :class="['nav-tab inline-flex items-center border-b-2 px-2.5 font-medium whitespace-nowrap transition-colors',
                       tab.active ? 'border-accent text-ink-strong' : 'border-transparent text-ink-muted hover:text-ink-strong']"
            >{{ t(tab.label) }}</router-link>
          </nav>
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <span
            data-test="live-indicator"
            :class="['mr-1 hidden items-center gap-1.5 text-xs md:inline-flex', connected ? 'text-ink-muted' : 'text-question-solid']"
          ><span :class="['size-1.5 rounded-full', connected ? 'bg-done-solid status-dot-live' : 'bg-question-solid']"></span>{{ connected ? t('app.live') : t('app.offline') }}</span>
          <button
            v-if="permission !== 'granted'"
            class="btn"
            @click="requestPermission"
          ><Icon name="notifications" emoji="🔔" :size="16" /> {{ t('notifications.enable') }}</button>
          <button
            class="btn"
            :class="soundOn ? 'text-ink-soft' : 'text-ink-faint'"
            @click="toggleSound"
          ><Icon :name="soundOn ? 'volume_up' : 'volume_off'" :emoji="soundOn ? '🔊' : '🔇'" :size="16" /> {{ t('notifications.sound') }}</button>
          <BudgetSettings />
          <span class="mx-1 hidden h-5 w-px bg-line lg:block" aria-hidden="true"></span>
          <ThemeSwitcher />
          <ModeSwitcher />
          <LocaleSwitcher />
        </div>
      </div>
    </header>

    <main class="mx-auto w-full max-w-[1680px] flex-1 px-4 py-5 sm:px-6">
      <div v-if="!connected || ciError || ciUnavailable || permission === 'denied'" class="mb-4 flex flex-col gap-2">
        <p v-if="!connected" class="alert"><Icon name="warning" emoji="⚠" :size="16" /> {{ t('banner.disconnected') }}</p>
        <p v-if="ciError" data-test="ci-desync" class="alert"><Icon name="warning" emoji="⚠" :size="16" /> {{ t('banner.ciDesync', { reason: ciReasonLabel(ciError) }) }}</p>
        <p v-if="ciUnavailable" data-test="ci-unavailable-banner" class="alert"><Icon name="warning" emoji="⚠" :size="16" /> {{ t('banner.ciUnavailable', { reason: ciReasonLabel(ciUnavailable) }) }}</p>
        <p v-if="permission === 'denied'" class="text-xs text-ink-muted">{{ t('notifications.blocked') }}</p>
      </div>

      <router-view v-slot="{ Component }">
        <component :is="Component" v-bind="routeProps" />
      </router-view>
    </main>
  </div>
</template>
