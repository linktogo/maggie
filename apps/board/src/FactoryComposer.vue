<script setup>
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import { vTooltip } from './tooltip.js';
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
  <div class="flex flex-col gap-2 border-t border-line-soft px-4 py-3">
    <p v-if="error" data-test="factory-error" class="alert text-xs"><Icon name="warning" emoji="⚠" :size="16" /> {{ error }}</p>
    <p v-if="!running && !resumable" data-test="factory-cannot-resume" class="text-xs text-ink-muted">{{ t('factory.cannotResume') }}</p>
    <form
      :class="['flex flex-col rounded-card border bg-surface transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent)]',
               running || !resumable ? 'border-line-soft' : 'border-line']"
      @submit.prevent="submit"
    >
      <textarea
        v-model="prompt"
        data-test="factory-reply"
        rows="2"
        :placeholder="t('factory.reply')"
        :disabled="running || !resumable"
        class="min-h-[3.25rem] resize-none bg-transparent px-3 pt-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-hidden disabled:opacity-50"
        @keydown.enter.exact.prevent="submit"
      />
      <div class="flex items-center justify-between gap-2 px-2 pb-2">
        <span class="pl-1 text-[11px] text-ink-faint">
          <template v-if="running"><span class="inline-flex items-center gap-1.5 text-accent"><span class="size-1.5 rounded-full bg-accent status-dot-live" aria-hidden="true"></span>{{ t('factory.thread.running') }}</span></template>
          <template v-else>{{ t('factory.composerHint') }}</template>
        </span>
        <span class="flex items-center gap-2">
          <button v-if="showRestart" type="button" data-test="factory-restart" class="text-xs text-accent hover:underline" @click="emit('restart')">{{ t('factory.restart') }}</button>
          <button
            v-if="running"
            type="button"
            data-test="factory-stop"
            :aria-label="t('factory.stop')"
            v-tooltip="t('factory.stop')"
            class="inline-flex size-8 items-center justify-center rounded-control border border-line bg-surface text-ink-soft hover:bg-surface-hover"
            @click="emit('stop')"
          ><Icon name="stop" emoji="⏹" /></button>
          <button
            v-else
            type="submit"
            data-test="factory-send"
            :disabled="!resumable || !prompt.trim() || blocked"
            :aria-label="t('factory.send')"
            v-tooltip="t('factory.send')"
            class="inline-flex size-8 items-center justify-center rounded-control bg-accent text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed"
          ><Icon name="send" emoji="➤" /></button>
        </span>
      </div>
    </form>
  </div>
</template>
