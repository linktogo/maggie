import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, withDirectives } from 'vue';
import { vTooltip, TOOLTIP_DELAY_MS } from './tooltip.js';

const label = ref('Send');

const Host = defineComponent({
  setup() {
    return () => withDirectives(h('button', { 'data-test': 'btn' }), [[vTooltip, label.value]]);
  },
});

function tip() { return document.body.querySelector('[data-test=tooltip]'); }

function rect(values) {
  return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {}, ...values };
}

let wrapper;
beforeEach(() => {
  vi.useFakeTimers();
  label.value = 'Send';
  wrapper = mount(Host, { attachTo: document.body });
});
afterEach(() => {
  wrapper.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('shows the text only after the pointer rests for the delay', async () => {
  await wrapper.get('[data-test=btn]').trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
  expect(tip()).toBeNull();
  vi.advanceTimersByTime(1);
  expect(tip().textContent).toBe('Send');
  expect(tip().getAttribute('aria-hidden')).toBe('true');
});

test('leaving before the delay cancels the popover', async () => {
  const btn = wrapper.get('[data-test=btn]');
  await btn.trigger('mouseenter');
  await btn.trigger('mouseleave');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  expect(tip()).toBeNull();
});

test('leaving or clicking hides a visible popover', async () => {
  const btn = wrapper.get('[data-test=btn]');
  await btn.trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  await btn.trigger('mouseleave');
  expect(tip()).toBeNull();

  await btn.trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  await btn.trigger('click');
  expect(tip()).toBeNull();
});

test('re-entering does not stack popovers', async () => {
  const btn = wrapper.get('[data-test=btn]');
  await btn.trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  await btn.trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  expect(document.body.querySelectorAll('[data-test=tooltip]')).toHaveLength(1);
});

test('an empty text shows nothing', async () => {
  label.value = '';
  await wrapper.vm.$nextTick();
  await wrapper.get('[data-test=btn]').trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  expect(tip()).toBeNull();
});

test('follows text changes, including while visible', async () => {
  const btn = wrapper.get('[data-test=btn]');
  label.value = 'Envoyer';
  await wrapper.vm.$nextTick();
  await btn.trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  expect(tip().textContent).toBe('Envoyer');
  label.value = 'Senden';
  await wrapper.vm.$nextTick();
  expect(tip().textContent).toBe('Senden');
});

test('sits centred above the element', async () => {
  const btn = wrapper.get('[data-test=btn]');
  vi.spyOn(btn.element, 'getBoundingClientRect').mockReturnValue(rect({ left: 100, width: 20, top: 200, bottom: 220 }));
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect({ width: 40, height: 20 }));
  await btn.trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  expect(tip().style.left).toBe('90px');
  expect(tip().style.top).toBe('174px');
});

test('flips below when there is no room above and stays inside the viewport', async () => {
  const btn = wrapper.get('[data-test=btn]');
  vi.spyOn(btn.element, 'getBoundingClientRect').mockReturnValue(rect({ left: window.innerWidth - 10, width: 10, top: 0, bottom: 10 }));
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect({ width: 100, height: 20 }));
  await btn.trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  expect(tip().style.left).toBe(`${window.innerWidth - 104}px`);
  expect(tip().style.top).toBe('16px');
});

test('clamps to the left edge', async () => {
  const btn = wrapper.get('[data-test=btn]');
  vi.spyOn(btn.element, 'getBoundingClientRect').mockReturnValue(rect({ left: 0, width: 10, top: 200, bottom: 210 }));
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(rect({ width: 100, height: 20 }));
  await btn.trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  expect(tip().style.left).toBe('4px');
});

test('unmounting removes a visible popover and cancels a pending one', async () => {
  await wrapper.get('[data-test=btn]').trigger('mouseenter');
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  wrapper.unmount();
  expect(tip()).toBeNull();

  wrapper = mount(Host, { attachTo: document.body });
  await wrapper.get('[data-test=btn]').trigger('mouseenter');
  wrapper.unmount();
  vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
  expect(tip()).toBeNull();
  wrapper = mount(Host, { attachTo: document.body });
});
