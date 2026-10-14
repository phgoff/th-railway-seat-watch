const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { dashboard } = require('./dashboard-harness.cjs');
const route = {
  origin: { id: '1', name: 'Origin station' },
  destination: { id: '2', name: 'Destination station' },
};

test('first launch has no preset trip or alert trains and requires a route before checking', async () => {
  const app = await dashboard();
  assert.equal(app.elements.origin.value, '');
  assert.equal(app.elements.destination.value, '');
  assert.equal(app.elements.from.value, '');
  assert.equal(app.elements.through.value, '');
  assert.equal(app.elements.alertTrainOptions.innerHTML, '');
  assert.equal(
    app.filters.every((input) => input.checked),
    true,
  );
  app.elements.refresh.click();
  assert.equal(
    app.elements.statusText.textContent,
    'Choose two different stations from the suggestions.',
  );
  assert.deepEqual(app.requests, []);
  await app.elements.launcher.onclick();
  assert.deepEqual(app.requests, ['getStation']);
  assert.equal(app.timers.size, 0);
});

test('close control hides the dashboard, stops its timer and returns focus to the launcher', async () => {
  const app = await dashboard();
  await app.elements.launcher.onclick();
  app.elements.close.click();
  assert.equal(app.elements.shell.hidden, true);
  assert.equal(app.elements.launcher.hidden, false);
  assert.equal(app.root.activeElement.id, 'launcher');
  assert.equal(app.timers.size, 0);
});

test('fully booked notice appears in the status region and distinguishes unchecked dates', async () => {
  const app = await dashboard({
    responses: {
      getTrip: [{ tripId: 't38', trainNo: '38', departureTime: '18:00', arrivalTime: '10:00' }],
      getTrainCoach: {
        results: [{ coachId: 'c38', coachClass: '2', availableSeatCount: 0, coachSeats: [] }],
      },
    },
    saved: {
      railWatch: {
        schema: 2,
        route,
        from: '2026-10-13',
        through: '2026-10-13',
        data: [
          { date: '13/10/2026', train: '38', departure: '18:00', arrival: '10:00', coaches: [] },
        ],
      },
    },
  });
  assert.equal(app.elements.availabilityNotice.hidden, false);
  assert.equal(
    app.elements.availabilityNotice.textContent,
    'No seats available yet. Click Check now to check again.',
  );
  assert.doesNotMatch(app.elements.matrix.innerHTML, /sold-note|No seats available yet/);
  await app.elements.launcher.onclick();
  assert.match(
    app.elements.availabilityNotice.textContent,
    /^No seats available yet\. Next check at/,
  );
  app.elements.pause.click();
  assert.equal(
    app.elements.availabilityNotice.textContent,
    'No seats available yet. Automatic checks are paused. Resume scanning to check again.',
  );
  app.elements.pause.click();
  assert.match(
    app.elements.availabilityNotice.textContent,
    /^No seats available yet\. Next check at/,
  );
  const checking = app.elements.refresh.onclick();
  assert.equal(
    app.elements.availabilityNotice.textContent,
    'No seats available yet. Checking again…',
  );
  await checking;
  assert.match(
    app.elements.availabilityNotice.textContent,
    /^No seats available yet\. Next check at/,
  );
  app.elements.through.value = '2026-10-14';
  app.elements.through.emit('change');
  assert.match(app.elements.availabilityNotice.textContent, /^No seats found in the checked dates/);
  app.elements.from.value = '2026-10-14';
  app.elements.from.emit('change');
  assert.equal(app.elements.availabilityNotice.hidden, true);
});

test('swapping back restores saved results and keeps both routes after a reload', async () => {
  const row = {
    date: '13/10/2026',
    train: '38',
    departure: '18:00',
    arrival: '10:00',
    coaches: [{ class: '1', type: 'Sleeping Coach', air: 'Air Coach', count: 2, prices: [] }],
  };
  const reverseRow = { ...row, train: '37' };
  const app = await dashboard({
    saved: {
      railWatch: {
        schema: 2,
        route,
        from: '2026-10-13',
        through: '2026-10-13',
        data: [row],
        filter: 'all',
        lastCheck: '2026-10-13T04:55:00Z',
        routeResults: {
          reverse: {
            origin: '2',
            destination: '1',
            filter: 'all',
            data: [reverseRow],
            lastCheck: '2026-10-13T04:56:00Z',
          },
        },
      },
    },
  });
  app.elements.swap.click();
  assert.match(app.elements.matrix.innerHTML, /Train 37/);
  assert.equal(app.memory.railWatch.route.origin.id, '2');
  app.elements.swap.click();
  assert.match(app.elements.matrix.innerHTML, /Train 38/);
  assert.equal(app.memory.railWatch.lastCheck, '2026-10-13T04:55:00Z');
  assert.equal(app.elements.statusText.textContent, 'Last check 11:55');
  assert.equal(app.elements.statusText.title, 'Last check 13 Oct 2026, 11:55:00 Bangkok');
  const restored = await dashboard({ saved: app.memory });
  restored.elements.swap.click();
  assert.match(restored.elements.matrix.innerHTML, /Train 37/);
});

test('train selections synchronize all, mixed and none states and survive reloads', async () => {
  const saved = {
    railWatch: {
      schema: 2,
      route,
      from: '2026-10-13',
      through: '2026-10-13',
      data: ['38', '170', '170'].map((train) => ({
        date: '13/10/2026',
        train,
        departure: '18:00',
        arrival: '10:00',
        coaches: [],
      })),
    },
  };
  let app = await dashboard({ saved });
  const all = () => app.elements.alertsPanel.querySelector('[data-chk-all]');
  const choose = (number, checked) => {
    const input = {
      checked,
      dataset: { alertTrain: number },
      matches: () => false,
      closest: (selector) => (selector === '[data-alert-train]' ? input : null),
    };
    for (const fn of app.root.listeners.change) fn({ target: input });
  };
  const toggleAll = (checked) => {
    all().checked = checked;
    all().emit('change');
  };
  assert.equal(all().checked, true);
  assert.match(app.elements.alertTrainOptions.innerHTML, /data-alert-train="38"[^>]*checked/);
  toggleAll(false);
  assert.equal(app.memory.railWatchAlertSettings.trains, 'none');
  assert.equal(app.elements.alertTrainLabel.textContent, 'No trains');
  assert.equal(all().indeterminate, false);
  choose('38', true);
  assert.equal(all().checked, false);
  assert.equal(all().indeterminate, true);
  assert.equal(app.elements.alertTrainLabel.textContent, 'Train 38');
  app = await dashboard({ saved: app.memory });
  assert.equal(all().indeterminate, true);
  choose('170', true);
  assert.equal(all().checked, true);
  assert.equal(all().indeterminate, false);
  assert.equal(app.memory.railWatchAlertSettings.trains, '');
  choose('38', false);
  assert.equal(app.memory.railWatchAlertSettings.trains, '170');
  assert.equal(all().indeterminate, true);
  choose('170', false);
  assert.equal(app.memory.railWatchAlertSettings.trains, 'none');
  app = await dashboard({ saved: app.memory });
  assert.equal(all().checked, false);
  assert.equal(all().indeterminate, false);
  assert.equal(app.elements.alertTrainLabel.textContent, 'No trains');
  toggleAll(true);
  assert.equal(app.elements.alertTrainLabel.textContent, 'All trains');
  assert.equal(app.memory.railWatchAlertSettings.trains, '');
});

test('matrix renders year-boundary dates, selected low seats and exact coach booking data', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('extension/ui.js', 'utf8'), context);
  const elements = { matrix: {}, detail: { querySelector: () => null } };
  const state = {
    data: [
      {
        date: '1/01/2027',
        train: '99',
        departure: '10:00',
        arrival: '11:00',
        coaches: [
          {
            id: 'a|1',
            class: '1',
            count: 1,
            type: 'Sleeping Coach',
            air: 'Air Coach',
            prices: [{ type: 'Lower Berth', price: 1205 }],
          },
        ],
      },
    ],
    selected: ['1/01/2027', '99'],
  };
  const ui = context.RailWatchUI.create({
    state,
    root: { querySelectorAll: () => [], querySelector: () => null },
    $: (id) => elements[id],
    escape: (value) => String(value).replaceAll('&', '&amp;'),
    dates: () => ['2027-01-01'],
    key: () => '1/01/2027',
    match: () => true,
  });
  ui.render();
  assert.match(elements.matrix.innerHTML, /Fri 1 Jan/);
  assert.match(elements.matrix.innerHTML, /class="mx-cell st-low"[^>]*aria-pressed="true"/);
  assert.match(elements.detail.innerHTML, /data-book-coach="a\|1"/);
  assert.match(elements.detail.innerHTML, /Lower Berth ฿1,205/);
  assert.match(elements.detail.innerHTML, /lang="th">ชั้น 1 · รถนอน · ปรับอากาศ/);
  state.data[0].coaches[0].desc = 'รถนอนปรับอากาศ & ชั้น 1 - ผู้โดยสารทั่วไป';
  ui.showDetail('1/01/2027', '99');
  assert.match(elements.detail.innerHTML, /รถนอนปรับอากาศ &amp; ชั้น 1<br>ผู้โดยสารทั่วไป/);
});

test('train detail orders available coaches by lowest count, class, then A/C before fan, with sold-out coaches last', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('extension/ui.js', 'utf8'), context);
  const coach = (id, count, cls, air) => ({ id, count, class: cls, air, type: 'Seat', prices: [] });
  const coaches = [
    coach('many', 20, '1', 'Air Coach'),
    coach('fan', 2, '2', 'Fan Coach'),
    coach('third', 2, '3', 'Air Coach'),
    coach('ac', 2, '2', 'Air Coach'),
    coach('first', 2, '1', 'Fan Coach'),
    coach('low', 1, '3', 'Fan Coach'),
    coach('sold-out', 0, '3', 'Fan Coach'),
    coach('ac-tie', 2, '2', 'Air Coach'),
  ];
  const original = structuredClone(coaches);
  const detail = {};
  const state = {
    data: [{ date: '15/10/2026', train: '38', departure: '18:05', arrival: '09:05', coaches }],
  };
  const ui = context.RailWatchUI.create({
    state,
    root: { querySelectorAll: () => [] },
    $: () => detail,
    escape: String,
  });
  ui.showDetail('15/10/2026', '38');
  const rows = [...detail.innerHTML.matchAll(/<li\b[\s\S]*?<\/li>/g)].map((match) => match[0]);
  assert.match(rows.at(-1), /Sold out/);
  assert.deepEqual(
    rows.slice(0, -1).map((row) => row.match(/data-book-coach="([^"]+)"/)[1]),
    ['low', 'first', 'ac', 'ac-tie', 'fan', 'third', 'many'],
  );
  assert.deepEqual(coaches, original);
});

test('unchanged availability keeps matrix and detail markup while a changed seat count still updates both', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('extension/ui.js', 'utf8'), context);
  const writes = { matrix: 0, detail: 0 },
    markup = {},
    elements = {};
  for (const id of ['matrix', 'detail']) {
    elements[id] = { querySelector: () => null };
    Object.defineProperty(elements[id], 'innerHTML', {
      get: () => markup[id],
      set(value) {
        writes[id]++;
        markup[id] = value;
      },
    });
  }
  const state = {
    data: [
      {
        date: '14/10/2026',
        train: '38',
        departure: '18:00',
        arrival: '10:00',
        coaches: [
          { id: '116', class: '1', count: 2, type: 'Sleeping Coach', air: 'Air Coach', prices: [] },
        ],
      },
    ],
    selected: ['14/10/2026', '38'],
  };
  const ui = context.RailWatchUI.create({
    state,
    root: { querySelectorAll: () => [], querySelector: () => null },
    $: (id) => elements[id],
    escape: String,
    dates: () => ['2026-10-14'],
    key: () => '14/10/2026',
    match: () => true,
  });
  ui.render();
  ui.render();
  assert.deepEqual(writes, { matrix: 1, detail: 1 });
  assert.match(markup.matrix, /2 seats available/);
  state.data[0].coaches[0].count = 0;
  ui.render();
  assert.deepEqual(writes, { matrix: 2, detail: 2 });
  assert.match(markup.matrix, /fully booked/);
  assert.match(markup.detail, /Sold out/);
});

test('saved availability renders a compact table and escapes the route label', async () => {
  const app = await dashboard({
    saved: {
      railWatchAvailabilityLog: {
        entries: [
          {
            at: Date.parse('2026-10-11T18:00:00Z'),
            route: '<Hat Yai>',
            date: '20/10/2026',
            train: '38',
            filter: '1,2',
            count: 3,
          },
        ],
      },
    },
  });
  assert.match(app.elements.availabilityLog.innerHTML, /&lt;Hat Yai&gt;/);
  assert.match(app.elements.availabilityLog.innerHTML, /20 Oct/);
  assert.match(app.elements.availabilityLog.innerHTML, /st-txt-low">3<\/td>/);
  assert.match(
    app.elements.availabilityLog.innerHTML,
    /<time datetime="2026-10-11T18:00:00\.000Z">01:00<\/time>/,
  );
  assert.doesNotMatch(app.elements.availabilityLog.innerHTML, /log-date|12 Oct 2026/);
  assert.match(app.elements.availabilityLog.innerHTML, /title="&lt;Hat Yai&gt;"/);
  assert.doesNotMatch(app.elements.availabilityLog.innerHTML, /Classes:/);
  assert.equal(app.elements.clearLog.disabled, false);
});

test('history can collapse, restore after reload and expand without changing its entries', async () => {
  const saved = {
    railWatchAvailabilityLog: { entries: [{ at: 0, date: '20/10/2026', train: '38', count: 3 }] },
  };
  const app = await dashboard({ saved });
  const before = app.elements.availabilityLog.innerHTML;
  assert.equal(app.elements.historyTable.hidden, false);
  assert.equal(app.elements.historyToggle.getAttribute('aria-expanded'), 'true');
  app.elements.historyToggle.click();
  assert.equal(app.elements.historyTable.hidden, true);
  assert.equal(app.elements.historyToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(app.elements.availabilityLog.innerHTML, before);
  const restored = await dashboard({ saved: app.memory });
  assert.equal(restored.elements.historyTable.hidden, true);
  restored.elements.historyToggle.click();
  assert.equal(restored.elements.historyTable.hidden, false);
  assert.equal(restored.elements.historyToggle.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(restored.memory.railWatchAvailabilityLog, saved.railWatchAvailabilityLog);
});

test('clearing history preserves dashboard and alert preferences', async () => {
  const saved = {
    railWatchAvailabilityLog: { entries: [{ at: 0, date: '20/10/2026', train: '38', count: 3 }] },
    railWatchAlertHistory: { counts: { train: 3 } },
  };
  const app = await dashboard({ saved });
  await app.elements.clearLog.onclick();
  assert.equal(app.memory.railWatchAvailabilityLog, undefined);
  assert.deepEqual(app.memory.railWatchAlertHistory, saved.railWatchAlertHistory);
  assert.equal(app.elements.clearLog.disabled, true);
  assert.match(app.elements.availabilityLog.innerHTML, /No entries yet/);
});

test('a failed history clear preserves rows and permits retry', async () => {
  const app = await dashboard({
    saved: {
      railWatchAvailabilityLog: { entries: [{ at: 0, date: '20/10/2026', train: '38', count: 3 }] },
    },
    removeError: 'Storage unavailable',
  });
  const before = app.elements.availabilityLog.innerHTML;
  await app.elements.clearLog.onclick();
  assert.equal(app.elements.availabilityLog.innerHTML, before);
  assert.equal(app.elements.clearLog.disabled, false);
  assert.equal(
    app.elements.statusText.textContent,
    'Could not clear the availability log: Storage unavailable',
  );
});

test('theme, palette and cadence controls save preferences through the actual controller', async () => {
  const app = await dashboard();
  app.elements.themeToggle.click();
  assert.equal(app.elements.shell.dataset.theme, 'light');
  assert.equal(app.memory.railWatch.theme, 'light');
  app.palettes[2].click();
  assert.equal(app.elements.shell.dataset.accent, 'forest');
  assert.equal(app.palettes[2].getAttribute('aria-checked'), 'true');
  app.cadences[1].click();
  assert.equal(app.memory.railWatch.interval, '600000');
  assert.equal(app.memory.railWatch.accent, 'forest');
  app.elements.themeToggle.click();
  assert.equal(app.memory.railWatch.theme, 'dark');
});

test('class filtering redraws cached seats without starting a scan or disabling the date inputs', async () => {
  const app = await dashboard();
  app.filters[2].checked = false;
  app.elements.filter.emit('change');
  assert.equal(app.memory.railWatch.filter, '1,2,sleep');
  assert.equal(app.elements.from.disabled, false);
  assert.equal(app.elements.refresh.disabled, false);
});

test('next-check label explains missing setup, scheduled Bangkok time and paused scanning on hover', async () => {
  const empty = await dashboard();
  await empty.elements.launcher.onclick();
  assert.equal(empty.elements.nextCheckText.textContent, 'Not scheduled');
  assert.equal(
    empty.elements.nextCheckText.dataset.tip,
    'Choose two different stations to schedule automatic checks.',
  );
  const app = await dashboard({
    saved: { railWatch: { schema: 2, route, from: '2026-10-13', through: '2026-10-13', data: [] } },
  });
  await app.elements.launcher.onclick();
  assert.equal(app.elements.nextCheckText.textContent, 'Next 12:15:00');
  assert.equal(
    app.elements.nextCheckText.dataset.tip,
    'Next automatic check 13 Oct 2026, 12:15:00 Bangkok.',
  );
  app.elements.nextCheckText.title = '';
  app.elements.pause.click();
  assert.equal(app.elements.nextCheckText.textContent, 'Paused');
  assert.equal(
    app.elements.nextCheckText.dataset.tip,
    'Automatic checks are paused. Click Resume scanning to continue.',
  );
  app.elements.pause.click();
  assert.equal(app.elements.nextCheckText.textContent, 'Next 12:15:00');
  const checking = app.elements.refresh.onclick();
  assert.equal(app.elements.nextCheckText.textContent, 'Checking…');
  assert.equal(
    app.elements.nextCheckText.dataset.tip,
    'A check is running. The next automatic check will be scheduled when it finishes.',
  );
  await checking;
  assert.equal(app.elements.nextCheckText.textContent, 'Next 12:15:00');
  app.elements.close.click();
  assert.equal(app.elements.nextCheckText.textContent, 'Not scheduled');
  assert.equal(
    app.elements.nextCheckText.dataset.tip,
    'Open the dashboard to resume automatic checks.',
  );
});

test('alert selection handles empty and single-train lists and synchronizes external saved settings', async () => {
  const empty = await dashboard();
  const none = empty.elements.alertsPanel.querySelector('[data-chk-all]');
  assert.equal(none.disabled, true);
  assert.equal(none.indeterminate, false);
  const app = await dashboard({
    saved: {
      railWatch: {
        schema: 2,
        route,
        from: '2026-10-13',
        through: '2026-10-13',
        data: [
          { date: '13/10/2026', train: '38', departure: '18:00', arrival: '10:00', coaches: [] },
        ],
      },
    },
  });
  const all = app.elements.alertsPanel.querySelector('[data-chk-all]');
  assert.equal(all.disabled, false);
  assert.equal(all.checked, true);
  await app.storage.set({ railWatchAlertSettings: { enabled: true, trains: 'none', minimum: 3 } });
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, false);
  assert.equal(app.elements.alertMinimum.value, 3);
  assert.equal(app.elements.alertSwitch.getAttribute('aria-checked'), 'true');
  await app.storage.set({ railWatchAlertSettings: { enabled: true, trains: '38', minimum: 3 } });
  assert.equal(all.checked, true);
  assert.equal(app.elements.alertTrainLabel.textContent, 'All trains');
  const input = {
    checked: false,
    dataset: { alertTrain: '38' },
    matches: () => false,
    closest: (selector) => (selector === '[data-alert-train]' ? input : null),
  };
  for (const fn of app.root.listeners.change) fn({ target: input });
  assert.equal(all.checked, false);
  assert.equal(all.indeterminate, false);
  assert.equal(app.memory.railWatchAlertSettings.trains, 'none');
  app.elements.alertTrainPicker.open = true;
  await app.storage.set({ railWatchAlertSettings: { enabled: false, trains: '', minimum: 1 } });
  assert.equal(app.elements.alertTrainPicker.open, false);
  assert.equal(all.checked, true);
});
