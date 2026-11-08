<script setup>
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  thread: { type: Object, required: true },
  resumable: { type: Boolean, default: false },
  error: { type: String, default: null },
  lastOutcome: { type: String, default: null },
  busy: { type: Boolean, default: false },
  // Sends the reply and resolves true once the server accepted it: the draft is
  // only cleared then, so a refused reply (409, network error) can be sent again.
  send: { type: Function, required: true },
});
const emit = defineEmits(['stop', 'restart']);

const prompt = ref('');
const sending = ref(false);
const running = computed(() => props.thread.status === 'running');
const showRestart = computed(() => !running.value && (!props.resumable || props.lastOutcome === 'failed'));
const blocked = computed(() => sending.value || props.busy);

async function submit() {
  const text = prompt.value.trim();
  if (!text || !props.resumable || blocked.value) return;
  sending.value = true;
  try {
    if (await props.send(text)) prompt.value = '';
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <p v-if="error" data-test="factory-error" class="text-xs text-question-on-soft"><Icon name="warning" emoji="⚠" /> {{ error }}</p>
    <p v-if="!running && !resumable" data-test="factory-cannot-resume" class="text-xs text-ink-muted">{{ t('factory.cannotResume') }}</p>
    <form class="flex items-end gap-2" @submit.prevent="submit">
      <textarea
        v-model="prompt"
        data-test="factory-reply"
        rows="2"
        :placeholder="t('factory.reply')"
        :disabled="running || !resumable"
        class="flex-1 rounded-control border border-line bg-surface px-2 py-1 text-sm text-ink-soft focus:border-accent focus:outline-hidden disabled:opacity-40"
      />
      <button
        v-if="running"
        type="button"
        data-test="factory-stop"
        class="whitespace-nowrap rounded-control border border-line bg-surface px-3 py-1 text-sm text-ink-soft hover:bg-surface-hover"
        @click="emit('stop')"
      >{{ t('factory.stop') }}</button>
      <button
        v-else
        type="submit"
        data-test="factory-send"
        :disabled="!resumable || !prompt.trim() || blocked"
        class="whitespace-nowrap rounded-control bg-accent px-3 py-1 text-sm font-medium text-on-accent hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed"
      >{{ t('factory.send') }}</button>
    </form>
    <div v-if="showRestart">
      <button type="button" data-test="factory-restart" class="text-xs text-accent hover:underline" @click="emit('restart')">{{ t('factory.restart') }}</button>
    </div>
  </div>
</template>
