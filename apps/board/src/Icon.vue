<script setup>
import { computed } from 'vue';
import { ICONS, ICON_VIEWBOX } from './icons.js';

const props = defineProps({
  name: { type: String, required: true, validator: (v) => v in ICONS },
  // What the legacy theme shows instead of the glyph. Both are rendered; CSS
  // picks one, so no call site needs a conditional.
  emoji: { type: String, default: '' },
  size: { type: Number, default: 18 },
});

const path = computed(() => ICONS[props.name]);
</script>

<template>
  <!--
    aria-hidden: this component never carries a name of its own. Every call
    site is expected to pair it with adjacent visible text that already says
    what it means (e.g. a button's own label) — an icon-only control (a bare
    button with nothing but an <Icon> inside it) must add its own aria-label,
    or it ships as a nameless control.
  -->
  <span :class="['icon', emoji ? 'has-emoji' : '']" aria-hidden="true">
    <svg
      class="icon-symbol" :width="size" :height="size"
      :viewBox="ICON_VIEWBOX" fill="currentColor" focusable="false"
    ><path :d="path" /></svg>
    <span v-if="emoji" class="icon-emoji">{{ emoji }}</span>
  </span>
</template>
