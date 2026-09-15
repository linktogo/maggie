<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useBoard } from './useBoard.js';
import { useConfig } from './useConfig.js';
import { useCi } from './useCi.js';
import { useNotifications } from './useNotifications.js';
import { useNow } from './useRelativeTime.js';
import { useI18n } from './i18n.js';
import LocaleSwitcher from './LocaleSwitcher.vue';
import ThemeSwitcher from './ThemeSwitcher.vue';
import ModeSwitcher from './ModeSwitcher.vue';
import Icon from './Icon.vue';

const { t } = useI18n();

const props = defineProps({
  fetchImpl: { type: Function, default: undefined },
  intervalMs: { type: Number, default: 3000 },
});
const fetchImpl = props.fetchImpl ?? fetch;

const { repos, transitions, connected, refresh } = useBoard({ intervalMs: props.intervalMs, fetchImpl });
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

const ciUnavailable = computed(() => {
  for (const repo of Object.values(ci.value)) {
    if (repo?.unavailable) return repo.unavailable;
  }
  return null;
});

const routeProps = computed(() => {
  if (route.name === 'history') return { fetchImpl };
  if (route.name === 'retro-doc') return { config: config.value, now: now.value, fetchImpl };
  return { repos: repos.value, config: config.value, ci: ci.value, now: now.value, fetchImpl, refresh };
});
</script>

<template>
  <main class="min-h-screen p-6">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-ink-strong">maggie · workspace board</h1>
        <div class="inline-flex items-center bg-surface-muted rounded-control p-0.5 gap-0.5 text-sm">
          <router-link
            data-test="view-board" to="/"
            :class="['nav-tab rounded-md px-3 py-1 font-medium transition-colors', route.name === 'board' ? 'bg-surface shadow-panel text-ink-strong' : 'text-ink-muted hover:text-ink-soft']"
          >{{ t('nav.board') }}</router-link>
          <router-link
            data-test="view-history" to="/history"
            :class="['nav-tab rounded-md px-3 py-1 font-medium transition-colors', route.name === 'history' ? 'bg-surface shadow-panel text-ink-strong' : 'text-ink-muted hover:text-ink-soft']"
          >{{ t('nav.history') }}</router-link>
          <router-link
            data-test="view-retro-doc" to="/retro-doc"
            :class="['rounded-md px-3 py-1 font-medium transition-colors', route.name === 'retro-doc' ? 'bg-white shadow-xs text-slate-900' : 'text-slate-500 hover:text-slate-700']"
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
        <button
          class="border border-line rounded-control shadow-panel hover:shadow-card hover:bg-surface-hover px-3 py-1.5 text-sm bg-surface"
          :class="soundOn ? 'text-ink-soft' : 'text-ink-faint'"
          @click="toggleSound"
        ><Icon :name="soundOn ? 'volume_up' : 'volume_off'" :emoji="soundOn ? '🔊' : '🔇'" /> {{ t('notifications.sound') }}</button>
      </div>
    </div>

    <p v-if="!connected" class="mb-3 text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ t('banner.disconnected') }}</p>
    <p v-if="ciError" data-test="ci-desync" class="mb-3 text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ t('banner.ciDesync', { reason: ciError }) }}</p>
    <p v-if="ciUnavailable" data-test="ci-unavailable-banner" class="mb-3 text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ t('banner.ciUnavailable', { reason: ciUnavailable }) }}</p>
    <p v-if="permission === 'denied'" class="mb-3 text-xs text-ink-muted">{{ t('notifications.blocked') }}</p>

    <router-view v-slot="{ Component }">
      <component :is="Component" v-bind="routeProps" />
    </router-view>
  </main>
</template>
