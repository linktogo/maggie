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

const routeProps = computed(() => (route.name === 'history'
  ? { fetchImpl }
  : { repos: repos.value, config: config.value, ci: ci.value, now: now.value, fetchImpl, refresh }));
</script>

<template>
  <main class="min-h-screen bg-slate-100 p-6">
    <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold text-slate-900">maggie · workspace board</h1>
        <div class="inline-flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5 text-sm">
          <router-link
            data-test="view-board" to="/"
            :class="['rounded-md px-3 py-1 font-medium transition-colors', route.name === 'board' ? 'bg-white shadow-xs text-slate-900' : 'text-slate-500 hover:text-slate-700']"
          >{{ t('nav.board') }}</router-link>
          <router-link
            data-test="view-history" to="/history"
            :class="['rounded-md px-3 py-1 font-medium transition-colors', route.name === 'history' ? 'bg-white shadow-xs text-slate-900' : 'text-slate-500 hover:text-slate-700']"
          >{{ t('nav.history') }}</router-link>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <LocaleSwitcher />
        <button
          v-if="permission !== 'granted'"
          class="border border-slate-200 rounded-lg shadow-xs hover:shadow-sm px-3 py-1.5 text-sm bg-white"
          @click="requestPermission"
        >🔔 {{ t('notifications.enable') }}</button>
        <button
          class="border border-slate-200 rounded-lg shadow-xs hover:shadow-sm px-3 py-1.5 text-sm bg-white"
          :class="soundOn ? 'text-slate-700' : 'text-slate-400'"
          @click="toggleSound"
        >{{ soundOn ? '🔊' : '🔇' }} {{ t('notifications.sound') }}</button>
      </div>
    </div>

    <p v-if="!connected" class="mb-3 text-xs text-amber-700">⚠ {{ t('banner.disconnected') }}</p>
    <p v-if="ciError" data-test="ci-desync" class="mb-3 text-xs text-amber-700">⚠ {{ t('banner.ciDesync', { reason: ciError }) }}</p>
    <p v-if="ciUnavailable" data-test="ci-unavailable-banner" class="mb-3 text-xs text-amber-700">⚠ {{ t('banner.ciUnavailable', { reason: ciUnavailable }) }}</p>
    <p v-if="permission === 'denied'" class="mb-3 text-xs text-slate-500">{{ t('notifications.blocked') }}</p>

    <router-view v-slot="{ Component }">
      <component :is="Component" v-bind="routeProps" />
    </router-view>
  </main>
</template>
