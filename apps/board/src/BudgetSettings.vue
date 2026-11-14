<script setup>
import { budget, setBudget } from './budget.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();

// An empty box turns the threshold off; anything the store rejects is shown
// back as the value it kept.
function commit(field, event) {
  // A number input reports text it cannot parse as ''; that is a typo, not a
  // request to turn the threshold off.
  if (event.target.validity?.badInput) {
    event.target.value = budget.value[field] ?? '';
    return;
  }
  const raw = event.target.value.trim();
  setBudget({ [field]: raw === '' ? null : Number(raw) });
  event.target.value = budget.value[field] ?? '';
}
</script>

<template>
  <details data-test="budget-settings" class="relative">
    <summary class="btn list-none cursor-pointer [&::-webkit-details-marker]:hidden">{{ t('budget.title') }}</summary>
    <div class="absolute right-0 z-40 mt-2 w-60 rounded-card border border-line bg-surface shadow-overlay p-3 space-y-3 text-sm text-ink-soft">
      <label class="block">
        <span class="eyebrow block mb-1">{{ t('budget.session') }}</span>
        <input
          data-test="budget-session" type="number" min="0" step="0.5" :value="budget.session ?? ''"
          class="control w-full font-mono" @change="commit('session', $event)"
        />
      </label>
      <label class="block">
        <span class="eyebrow block mb-1">{{ t('budget.day') }}</span>
        <input
          data-test="budget-day" type="number" min="0" step="0.5" :value="budget.day ?? ''"
          class="control w-full font-mono" @change="commit('day', $event)"
        />
      </label>
    </div>
  </details>
</template>
