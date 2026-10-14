const { test } = require('node:test');
const assert = require('node:assert/strict');
const { days, bind } = require('../extension/calendar.js');
test('calendar handles leap years and previous month across year boundaries', () => {
  assert.equal(days(2028, 1).length, 29);
  assert.equal(days(2026, -1).at(-1), '2025-12-31');
});
test('calendar opens a top-layer dialog, disables past days and applies a selected date', () => {
  global.innerWidth = 1200;
  global.innerHeight = 800;
  let open = false,
    changes = 0;
  const elements = Object.fromEntries(
    [
      'from',
      'through',
      'fromCalendar',
      'throughCalendar',
      'calendarPrev',
      'calendarNext',
      'calendarClose',
      'calendarDays',
      'calendarMonth',
      'dateCalendar',
    ].map((id) => [id, {}]),
  );
  Object.assign(elements.from, {
    value: '2026-10-13',
    min: '2026-10-12',
    getBoundingClientRect: () => ({ left: 100, bottom: 100 }),
    focus() {},
  });
  Object.assign(elements.fromCalendar, {
    getBoundingClientRect: () => ({ left: 100, bottom: 100 }),
    setAttribute() {},
    focus() {},
  });
  Object.assign(elements.dateCalendar, {
    style: {},
    offsetWidth: 310,
    offsetHeight: 300,
    showModal: () => (open = true),
    close() {
      open = false;
      this.onclose?.();
    },
  });
  bind({ root: {}, $: (id) => elements[id], updateDateBounds() {}, onChange: () => changes++ });
  elements.fromCalendar.onclick();
  assert.equal(open, true);
  assert.match(elements.calendarDays.innerHTML, /data-day="2026-10-11"[^>]*disabled/);
  elements.calendarDays.onclick({
    target: { closest: () => ({ dataset: { day: '2026-10-20' }, disabled: false }) },
  });
  assert.equal(elements.from.value, '2026-10-20');
  assert.equal(changes, 1);
  assert.equal(open, false);
});
