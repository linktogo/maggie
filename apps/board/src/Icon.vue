<script setup>
import { computed } from 'vue';
import { ICONS, ICON_VIEWBOX } from './icons.js';

const props = defineProps({
  name: { type: String, required: true },
  // What the legacy theme shows instead of the glyph. Both are rendered; CSS
  // picks one, so no call site needs a conditional.
  emoji: { type: String, default: '' },
  size: { type: Number, default: 18 },
});

const path = computed(() => ICONS[props.name]);
</script>

<template>
  <span :class="['icon', emoji ? 'has-emoji' : '']" aria-hidden="true">
    <svg
      class="icon-symbol" :width="size" :height="size"
      :viewBox="ICON_VIEWBOX" fill="currentColor" focusable="false"
    ><path :d="path" /></svg>
    <span v-if="emoji" class="icon-emoji">{{ emoji }}</span>
  </span>
</template>
