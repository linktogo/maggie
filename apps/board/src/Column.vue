<script setup>
import { ref, computed } from 'vue';
import Card from './Card.vue';
import { STATUS_STYLES } from './statusStyles.js';

const props = defineProps({
  title: { type: String, required: true },
  status: { type: String, required: true },
  entries: { type: Array, required: true }, // [{ name, sessions }]
  now: { type: Number, default: () => Date.now() },
  ci: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['open', 'close-session', 'send-message']);

const style = computed(() => STATUS_STYLES[props.status]);
const isDropTarget = computed(() => props.status === 'done');
const dragOver = ref(false);

function onDragOver(e) {
  e.preventDefault();
  dragOver.value = true;
}
function onDragLeave() {
  dragOver.value = false;
}
function onDrop(e) {
  e.preventDefault();
  dragOver.value = false;
  const { repo, sessionId } = JSON.parse(e.dataTransfer.getData('application/json'));
  emit('close-session', { repo, sessionId });
}
</script>

<template>
  <section class="min-w-0">
    <h2 :class="['inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold mb-2', style.pill]">
      {{ title }} <span class="opacity-80">({{ entries.length }})</span>
    </h2>
    <div
      data-test="column-body"
      :class="['flex flex-col gap-gutter bg-panel rounded-panel p-2 min-h-[4rem]',
               dragOver ? 'ring-2 ring-drop-ring' : '']"
      v-on="isDropTarget ? { dragover: onDragOver, dragleave: onDragLeave, drop: onDrop } : {}"
    >
      <Card v-for="e in entries" :key="e.name" :name="e.name" :sessions="e.sessions" :status="status" :now="now" :ci="ci[e.name] ?? null" @open="$emit('open', $event)" @send-message="$emit('send-message', $event)" />
    </div>
  </section>
</template>
