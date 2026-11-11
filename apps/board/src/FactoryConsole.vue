<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useTerminal } from './useTerminal.js';
import { createXterm } from './xtermAdapter.js';
import { mode, theme } from './theme.js';
import Icon from './Icon.vue';
import { useI18n } from './i18n.js';

const { t } = useI18n();

const props = defineProps({
  thread: { type: String, required: true },
  fetchImpl: { type: Function, default: undefined },
  EventSourceImpl: { type: Function, default: undefined },
  terminalFactory: { type: Function, default: createXterm },
  ResizeObserverImpl: { type: Function, default: undefined },
});

const shell = useTerminal({
  ...(props.fetchImpl ? { fetchImpl: props.fetchImpl } : {}),
  ...(props.EventSourceImpl ? { EventSourceImpl: props.EventSourceImpl } : {}),
});
const { status, exitCode, error, cwd } = shell;
const screen = ref(null);
let term = null;
let observer = null;

// The terminal takes the board's colours, so it follows the theme and the light/dark mode.
function readTheme() {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();
  return { background: token('--color-surface'), foreground: token('--color-ink'), cursor: token('--color-accent'), selectionBackground: token('--color-accent-soft') };
}

const message = computed(() => {
  if (status.value === 'opening') return t('factory.console.opening');
  if (status.value === 'exited') return t('factory.console.exited', { code: exitCode.value });
  if (status.value === 'disconnected') return t('factory.console.disconnected');
  if (status.value === 'error') return error.value;
  return null;
});
const ended = computed(() => ['exited', 'disconnected', 'error'].includes(status.value));

function start() {
  term.fit();
  return shell.open({ thread: props.thread }, { cols: term.cols, rows: term.rows }, (bytes) => term.write(bytes));
}

async function reopen() {
  await shell.close();
  term.clear();
  await start();
}

onMounted(() => {
  term = props.terminalFactory(screen.value, readTheme());
  term.onData((data) => shell.write(data));
  const Observer = props.ResizeObserverImpl ?? globalThis.ResizeObserver;
  observer = new Observer(() => {
    term.fit();
    shell.resize(term.cols, term.rows);
  });
  observer.observe(screen.value);
  void start();
});

watch([theme, mode], async () => {
  await nextTick(); // the new data-theme / data-mode attributes are stamped by then
  term?.setTheme(readTheme());
});

onBeforeUnmount(() => {
  observer.disconnect();
  term.dispose();
});

defineExpose({ focus: () => term.focus() });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div class="flex items-center justify-between gap-2 text-xs text-ink-faint">
      <span v-if="cwd" data-test="factory-console-cwd" class="truncate font-mono">{{ cwd }}</span>
      <span v-if="message" data-test="factory-console-status" :class="ended ? 'text-question-on-soft' : ''">{{ message }}</span>
      <button
        v-if="ended" type="button" data-test="factory-console-reopen"
        class="inline-flex items-center gap-1 whitespace-nowrap text-accent hover:underline" @click="reopen"
      >
        <Icon name="play_arrow" emoji="▶" /> {{ t('factory.console.reopen') }}
      </button>
    </div>
    <div ref="screen" data-test="factory-console-screen" class="h-[60vh] min-h-0 overflow-hidden rounded-card border border-line bg-surface p-1" />
  </div>
</template>
