// apps/board/src/statusStyles.js
// Semantic classes only — the hues live in the theme files under
// apps/board/src/themes/, so a theme can restyle every status at once. The
// human-readable column labels live in the i18n catalogs under `status.<key>`.
//
// Each string must stay a complete literal: Tailwind's scanner cannot see a
// class name that is assembled at runtime.
export const STATUS_STYLES = {
  todo: {
    pill: 'bg-todo-solid text-on-status',
    border: 'border-todo-solid',
    chip: 'bg-todo-soft text-todo-on-soft',
  },
  inprogress: {
    pill: 'bg-inprogress-solid text-on-status',
    border: 'border-inprogress-solid',
    chip: 'bg-inprogress-soft text-inprogress-on-soft',
  },
  question: {
    pill: 'bg-question-solid text-on-status',
    border: 'border-question-solid',
    chip: 'bg-question-soft text-question-on-soft',
    ring: 'ring-2 ring-question-ring',
  },
  done: {
    pill: 'bg-done-solid text-on-status',
    border: 'border-done-solid',
    chip: 'bg-done-soft text-done-on-soft',
  },
};

export const STATUS_ORDER = ['todo', 'inprogress', 'question', 'done'];
