<script setup>
import { onMounted, onUnmounted, computed, ref } from 'vue';
import { relativeTime } from './useRelativeTime.js';
import { visibleBadges, pillClass } from './ciBadge.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  name: { type: String, default: null },
  sessionId: { type: String, default: null },
  session: { type: Object, default: null },
  meta: { type: Object, default: null },
  now: { type: Number, default: () => Date.now() },
  ci: { type: Object, default: null },
});
const emit = defineEmits(['close', 'send-message']);

const ciUsers = computed(() => visibleBadges(props.ci?.users, Infinity).shown);

const draft = ref('');
const pending = computed(() => props.session?.pendingMessages ?? []);
function send() {
  const text = draft.value.trim();
  if (!text) return;
  emit('send-message', { repo: props.name, sessionId: props.sessionId, text });
  draft.value = '';
}

function onKey(e) { if (e.key === 'Escape') emit('close'); }
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div v-if="name" class="fixed inset-0 z-20">
    <div data-test="overlay" class="absolute inset-0 bg-slate-900/30" @click="emit('close')"></div>
    <aside class="absolute right-0 top-0 h-full w-full sm:w-80 max-w-full bg-white shadow-xl p-4 overflow-y-auto">
      <button class="float-right text-slate-400 hover:text-slate-600" @click="emit('close')">✕</button>
      <div class="pb-3 border-b border-slate-100 mb-3">
        <h2 class="font-bold text-slate-900">{{ name }}</h2>
        <p v-if="session?.title" class="text-sm text-slate-600 mt-1">{{ session.title }}</p>
        <a v-if="meta?.url" :href="meta.url" target="_blank" rel="noopener"
           class="text-sm text-blue-600 underline break-all">{{ meta.url }}</a>
        <div v-if="meta" class="mt-2 flex flex-wrap gap-1">
          <span v-for="t in (meta.technologies || [])" :key="t" class="text-xs font-medium bg-slate-100 px-2 py-0.5 rounded-full">{{ t }}</span>
          <span v-for="t in (meta.targets || [])" :key="t" class="text-xs font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">{{ t }}</span>
        </div>
      </div>
      <p v-if="session?.lastPrompt" class="mt-3 text-sm text-slate-700 whitespace-pre-wrap">{{ session.lastPrompt }}</p>

      <template v-if="sessionId">
        <h3 class="mt-4 text-xs font-semibold text-slate-500 uppercase">{{ t('detail.message') }}</h3>
        <ul v-if="pending.length" data-test="pending-messages" class="mt-1 space-y-1">
          <li v-for="(m, i) in pending" :key="i" class="text-xs text-slate-600 flex gap-1">
            <span class="text-slate-400" aria-hidden="true">↩</span>
            <span class="whitespace-pre-wrap break-words">{{ m.text }}</span>
          </li>
        </ul>
        <p v-else data-test="pending-empty" class="mt-1 text-xs text-slate-400">{{ t('detail.messageEmpty') }}</p>
        <form data-test="detail-message-form" class="mt-2 flex items-start gap-1" @submit.prevent="send">
          <textarea
            v-model="draft"
            data-test="detail-message-input"
            rows="2"
            :placeholder="t('session.messagePlaceholder')"
            class="min-w-0 flex-1 resize-y rounded-sm border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:border-blue-400 focus:outline-hidden"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button
            type="submit"
            data-test="detail-message-send"
            :disabled="!draft.trim()"
            class="shrink-0 rounded-sm bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >{{ t('session.send') }}</button>
        </form>
      </template>

      <h3 class="mt-4 text-xs font-semibold text-slate-500 uppercase">{{ t('detail.ci') }}</h3>
      <p v-if="ci?.unavailable" data-test="ci-unavailable" class="mt-1 text-xs text-slate-500">
        {{ t('detail.ciUnavailable', { reason: ci.unavailable }) }}
      </p>
      <p v-else-if="ciUsers.length === 0" data-test="ci-empty" class="mt-1 text-xs text-slate-500">
        {{ t('detail.ciEmpty') }}
      </p>
      <ul v-else class="mt-1 space-y-1">
        <li v-for="u in ciUsers" :key="u.login" data-test="ci-user" class="text-xs text-slate-600">
          <span :class="['border rounded-sm px-1 py-0.5 mr-1 font-semibold', pillClass(u.state)]">{{ u.initials }}</span>
          <b>{{ u.login }}</b> ·
          <a data-test="ci-link" :href="ci.users[u.login].run.url" target="_blank" rel="noopener" class="text-blue-600 underline">
            {{ ci.users[u.login].run.workflow }}
          </a>
          · {{ ci.users[u.login].run.branch }}
          · {{ ci.users[u.login].run.conclusion }}
          · {{ relativeTime(ci.users[u.login].run.startedAt, now) }}
        </li>
      </ul>

      <h3 class="mt-4 text-xs font-semibold text-slate-500 uppercase">{{ t('detail.history') }}</h3>
      <ul class="mt-1 space-y-1">
        <li v-for="(e, i) in (session?.events || [])" :key="i" class="text-xs text-slate-600">
          • {{ e.event }} — {{ relativeTime(e.at, now) }}
        </li>
      </ul>
    </aside>
  </div>
</template>
