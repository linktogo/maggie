<script setup>
import { nextTick, ref, watch } from 'vue';

// The console of a retro-documentation run. Its job is to answer "is this thing
// still alive": every line carries the time it appeared, and the box follows
// the tail so the newest line is the one on screen.
const props = defineProps({
  log: { type: Array, default: () => [] },
});

const box = ref(null);

function at(entry) {
  const date = new Date(entry.at);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

watch(() => props.log.length, async () => {
  await nextTick();
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
});
</script>

<template>
  <pre
    ref="box"
    data-test="retro-log"
    class="mt-2 max-h-56 overflow-auto rounded-md bg-slate-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100 whitespace-pre-wrap break-words"
  ><template v-for="(entry, i) in log" :key="i"><span class="text-slate-500">{{ at(entry) }}</span>  {{ entry.text }}
</template></pre>
</template>
