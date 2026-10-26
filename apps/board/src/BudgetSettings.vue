<script setup>
import { budget, setBudget } from './budget.js';
import { useI18n } from './i18n.js';

const { t } = useI18n();

// An empty box turns the threshold off; anything the store rejects is shown
// back as the value it kept.
function commit(field, event) {
  const raw = event.target.value.trim();
  setBudget({ [field]: raw === '' ? null : Number(raw) });
  event.target.value = budget.value[field] ?? '';
}
</script>

<template>
  <details data-test="budget-settings" class="relative">
    <summary class="list-none cursor-pointer border border-line rounded-control shadow-panel hover:shadow-card hover:bg-surface-hover px-3 py-1.5 text-sm bg-surface text-ink-soft">{{ t('budget.title') }}</summary>
    <div class="absolute right-0 z-10 mt-1 w-56 rounded-control border border-line bg-surface shadow-overlay p-3 space-y-2 text-sm text-ink-soft">
      <label class="block">
        <span class="block text-xs text-ink-muted mb-0.5">{{ t('budget.session') }}</span>
        <input
          data-test="budget-session" type="number" min="0" step="0.5" :value="budget.session ?? ''"
          class="w-full rounded-control border border-line bg-surface px-2 py-1" @change="commit('session', $event)"
        />
      </label>
      <label class="block">
        <span class="block text-xs text-ink-muted mb-0.5">{{ t('budget.day') }}</span>
        <input
          data-test="budget-day" type="number" min="0" step="0.5" :value="budget.day ?? ''"
          class="w-full rounded-control border border-line bg-surface px-2 py-1" @change="commit('day', $event)"
        />
      </label>
    </div>
  </details>
</template>
