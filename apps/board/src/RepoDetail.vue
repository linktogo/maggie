<script setup>
import { onMounted, onUnmounted, computed, ref } from 'vue';
import { relativeTime } from './useRelativeTime.js';
import RetroDocLog from './RetroDocLog.vue';
import { visibleBadges, pillClass } from './ciBadge.js';
import { useI18n } from './i18n.js';
import Icon from './Icon.vue';

const { t } = useI18n();

const props = defineProps({
  name: { type: String, default: null },
  sessionId: { type: String, default: null },
  session: { type: Object, default: null },
  meta: { type: Object, default: null },
  now: { type: Number, default: () => Date.now() },
  ci: { type: Object, default: null },
  retroDoc: { type: Object, default: null },
  retroDocAvailable: { type: Boolean, default: true },
});
const emit = defineEmits(['close', 'send-message', 'generate-retro-doc']);

const provider = ref('claude');
const retroRunning = computed(() => props.retroDoc?.status === 'running');
// The last log line the run emitted — the whole console sits under it.
const retroProgress = computed(() => props.retroDoc?.log?.at(-1)?.text ?? null);
const retroLog = computed(() => props.retroDoc?.log ?? []);
function generateRetroDoc() {
  emit('generate-retro-doc', { repo: props.name, provider: provider.value });
}

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
    <div data-test="overlay" class="absolute inset-0 bg-overlay" @click="emit('close')"></div>
    <aside class="absolute right-0 top-0 h-full w-full sm:w-80 max-w-full bg-surface shadow-overlay p-4 overflow-y-auto">
      <button class="float-right text-ink-faint hover:text-ink-soft" :aria-label="t('detail.close')" @click="emit('close')"><Icon name="close" emoji="✕" /></button>
      <div class="pb-3 border-b border-line-soft mb-3">
        <h2 class="font-bold text-ink-strong">{{ name }}</h2>
        <p v-if="session?.title" class="text-sm text-ink-soft mt-1">{{ session.title }}</p>
        <a v-if="meta?.url" :href="meta.url" target="_blank" rel="noopener"
           class="text-sm text-accent underline break-all">{{ meta.url }}</a>
        <div v-if="meta" class="mt-2 flex flex-wrap gap-1">
          <span v-for="t in (meta.technologies || [])" :key="t" class="text-xs font-medium bg-surface-muted px-2 py-0.5 rounded-chip">{{ t }}</span>
          <span v-for="t in (meta.targets || [])" :key="t" class="text-xs font-medium bg-accent-soft text-on-accent-soft px-2 py-0.5 rounded-chip">{{ t }}</span>
        </div>
      </div>
      <p v-if="session?.lastPrompt" class="mt-3 text-sm text-ink-soft whitespace-pre-wrap">{{ session.lastPrompt }}</p>

      <template v-if="sessionId">
        <h3 class="mt-4 text-xs font-semibold text-ink-muted uppercase">{{ t('detail.message') }}</h3>
        <ul v-if="pending.length" data-test="pending-messages" class="mt-1 space-y-1">
          <li v-for="(m, i) in pending" :key="i" class="text-xs text-ink-soft flex gap-1">
            <Icon name="reply" emoji="↩" class="text-ink-faint" />
            <span class="whitespace-pre-wrap break-words">{{ m.text }}</span>
          </li>
        </ul>
        <p v-else data-test="pending-empty" class="mt-1 text-xs text-ink-faint">{{ t('detail.messageEmpty') }}</p>
        <form data-test="detail-message-form" class="mt-2 flex items-start gap-1" @submit.prevent="send">
          <textarea
            v-model="draft"
            data-test="detail-message-input"
            rows="2"
            :placeholder="t('session.messagePlaceholder')"
            class="min-w-0 flex-1 resize-y rounded-control border border-line bg-surface px-2 py-1 text-xs text-ink-soft focus:border-accent focus:outline-hidden"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button
            type="submit"
            data-test="detail-message-send"
            :disabled="!draft.trim()"
            class="shrink-0 rounded-control bg-accent px-2 py-1 text-xs font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed"
          >{{ t('session.send') }}</button>
        </form>
      </template>

      <h3 class="mt-4 text-xs font-semibold text-ink-muted uppercase">{{ t('detail.retroDoc') }}</h3>
      <p v-if="!retroDocAvailable" data-test="retro-doc-unavailable" class="mt-1 text-xs text-ink-muted">
        {{ t('detail.retroDocUnavailable') }}
      </p>
      <template v-else>
        <p class="mt-1 text-xs text-ink-faint">{{ t('detail.retroDocHint') }}</p>
        <div class="mt-2 flex items-center gap-1">
          <select
            v-model="provider"
            data-test="retro-doc-provider"
            class="min-w-0 flex-1 rounded-control border border-line bg-surface px-2 py-1 text-xs text-ink-soft focus:border-accent focus:outline-hidden"
          >
            <option value="claude">Claude (API)</option>
            <option value="claude-cli">Claude Code (CLI)</option>
            <option value="copilot">GitHub Copilot (CLI)</option>
          </select>
          <button
            type="button"
            data-test="retro-doc-run"
            :disabled="retroRunning"
            class="shrink-0 rounded-control bg-accent px-2 py-1 text-xs font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed"
            @click="generateRetroDoc"
          >{{ retroRunning ? t('detail.retroDocRunning') : t('detail.retroDocRun') }}</button>
        </div>
        <p v-if="retroRunning" data-test="retro-doc-progress" class="mt-1 text-xs text-ink-soft">
          ⏳ {{ retroProgress ?? t('detail.retroDocRunning') }}
        </p>
        <p v-else-if="retroDoc?.status === 'done'" data-test="retro-doc-done" class="mt-1 text-xs text-ink-soft">
          ✓ {{ t('detail.retroDocDone', { out: retroDoc.out }) }} · {{ retroDoc.generator }}
        </p>
        <p v-else-if="retroDoc?.status === 'error'" data-test="retro-doc-error" class="mt-1 text-xs text-question-on-soft">
          ⚠ {{ t('detail.retroDocFailed', { reason: retroDoc.error }) }}
        </p>
        <RetroDocLog v-if="retroLog.length" :log="retroLog" />
      </template>

      <h3 class="mt-4 text-xs font-semibold text-ink-muted uppercase">{{ t('detail.ci') }}</h3>
      <p v-if="ci?.unavailable" data-test="ci-unavailable" class="mt-1 text-xs text-ink-muted">
        {{ t('detail.ciUnavailable', { reason: ci.unavailable }) }}
      </p>
      <p v-else-if="ciUsers.length === 0" data-test="ci-empty" class="mt-1 text-xs text-ink-muted">
        {{ t('detail.ciEmpty') }}
      </p>
      <ul v-else class="mt-1 space-y-1">
        <li v-for="u in ciUsers" :key="u.login" data-test="ci-user" class="text-xs text-ink-soft">
          <span :class="['border rounded-badge px-1 py-0.5 mr-1 font-semibold', pillClass(u.state)]">{{ u.initials }}</span>
          <b>{{ u.login }}</b> ·
          <a data-test="ci-link" :href="ci.users[u.login].run.url" target="_blank" rel="noopener" class="text-accent underline">
            {{ ci.users[u.login].run.workflow }}
          </a>
          · {{ ci.users[u.login].run.branch }}
          · {{ ci.users[u.login].run.conclusion }}
          · {{ relativeTime(ci.users[u.login].run.startedAt, now) }}
        </li>
      </ul>

      <h3 class="mt-4 text-xs font-semibold text-ink-muted uppercase">{{ t('detail.history') }}</h3>
      <ul class="mt-1 space-y-1">
        <li v-for="(e, i) in (session?.events || [])" :key="i" class="text-xs text-ink-soft">
          • {{ e.event }} — {{ relativeTime(e.at, now) }}
        </li>
      </ul>
    </aside>
  </div>
</template>
