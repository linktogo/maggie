// v-tooltip: shows the bound text in a popover after the pointer has rested on
// the element for TOOLTIP_DELAY_MS. Meant for icon-only buttons, which keep
// their aria-label as the accessible name — the popover is aria-hidden so
// screen readers do not announce the label twice.
//
// The popover is appended to <body> with position: fixed, so scrollable
// containers (the detail panel, the factory conversation) cannot clip it.
// Native `title` is not used: its delay is browser-controlled and it would
// show a second tooltip next to this one.

export const TOOLTIP_DELAY_MS = 2000;
const GAP = 6;
const MARGIN = 4;

const states = new WeakMap();

function place(el, tip) {
  const anchor = el.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const maxLeft = window.innerWidth - box.width - MARGIN;
  const left = Math.max(MARGIN, Math.min(anchor.left + anchor.width / 2 - box.width / 2, maxLeft));
  const above = anchor.top - box.height - GAP;
  const top = above >= MARGIN ? above : anchor.bottom + GAP;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function show(el) {
  const state = states.get(el);
  state.timer = null;
  if (!state.text) return;
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('data-test', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  tip.textContent = state.text;
  document.body.appendChild(tip);
  state.tip = tip;
  place(el, tip);
}

function hide(el) {
  const state = states.get(el);
  clearTimeout(state.timer);
  state.timer = null;
  state.tip?.remove();
  state.tip = null;
}

function schedule(el) {
  hide(el);
  states.get(el).timer = setTimeout(() => show(el), TOOLTIP_DELAY_MS);
}

export const vTooltip = {
  mounted(el, binding) {
    const state = {
      text: binding.value,
      timer: null,
      tip: null,
      enter: () => schedule(el),
      leave: () => hide(el),
    };
    states.set(el, state);
    el.addEventListener('mouseenter', state.enter);
    el.addEventListener('mouseleave', state.leave);
    el.addEventListener('click', state.leave);
  },
  updated(el, binding) {
    const state = states.get(el);
    state.text = binding.value;
    if (state.tip) state.tip.textContent = binding.value;
  },
  beforeUnmount(el) {
    const state = states.get(el);
    hide(el);
    el.removeEventListener('mouseenter', state.enter);
    el.removeEventListener('mouseleave', state.leave);
    el.removeEventListener('click', state.leave);
    states.delete(el);
  },
};
