const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboard } = require('./dashboard-harness.cjs');

test('restoration clamps past Bangkok dates and discards expired availability', async () => {
  const app = await dashboard({
    now: '2026-10-10T18:00:00Z',
    saved: {
      railWatch: {
        schema: 2,
        route: {
          origin: { id: '341', name: 'Hat Yai Junction' },
          destination: { id: '1679', name: 'Krung Thep Aphiwat' },
        },
        from: '2026-10-10',
        through: '2026-10-21',
        data: [{ date: '10/10/2026', train: '38' }],
        lastCheck: '2026-10-10T12:00:00Z',
        selected: ['10/10/2026', '38'],
      },
    },
  });
  assert.equal(app.elements.from.min, '2026-10-11');
  assert.equal(app.elements.through.min, '2026-10-11');
  assert.equal(app.elements.from.value, '2026-10-11');
  assert.equal(app.elements.through.value, '2026-10-21');
  assert.match(app.elements.matrix.innerHTML, /No data for these dates/);
  assert.match(app.elements.detail.innerHTML, /Select a train/);
});

test('date changes move the end to the start and cap the range at 31 days', async () => {
  const app = await dashboard();
  app.elements.from.value = '2026-11-01';
  app.elements.from.emit('change');
  assert.equal(app.elements.through.value, '2026-11-01');
  assert.equal(app.dateLabels.start.textContent, 'Sun 1 Nov');
  assert.equal(app.dateLabels.end.textContent, 'Sun 1 Nov');
  app.elements.through.value = '2027-01-01';
  app.elements.through.emit('change');
  assert.equal(app.elements.from.value, '2026-12-02');
  assert.equal(app.elements.rangeHint.textContent, 'Max range is 31 days');
  assert.equal(app.memory.railWatch.from, '2026-12-02');
});

test('date minimum advances after Bangkok midnight without reloading', async () => {
  const app = await dashboard({
    now: '2026-10-13T16:59:00Z',
    saved: { railWatch: { from: '2026-10-13', through: '2026-10-13' } },
  });
  app.setTime('2026-10-13T17:01:00Z');
  app.elements.from.emit('focus');
  assert.equal(app.elements.from.min, '2026-10-14');
  assert.equal(app.elements.from.value, '2026-10-14');
});

test('calendar buttons select both endpoints, update labels and persist the range', async () => {
  const app = await dashboard();
  const pick = (field, day) => {
    app.elements[field + 'Calendar'].click();
    assert.equal(app.elements.dateCalendar.open, true);
    app.elements.calendarDays.onclick({
      target: { closest: () => ({ dataset: { day }, disabled: false }) },
    });
    assert.equal(app.elements.dateCalendar.open, false);
    assert.equal(app.root.activeElement.id, field + 'Calendar');
  };
  pick('from', '2026-10-16');
  pick('through', '2026-10-20');
  assert.equal(app.dateLabels.start.textContent, 'Fri 16 Oct');
  assert.equal(app.dateLabels.end.textContent, 'Tue 20 Oct');
  assert.equal(app.memory.railWatch.from, '2026-10-16');
  assert.equal(app.memory.railWatch.through, '2026-10-20');
  const restored = await dashboard({ saved: app.memory });
  assert.equal(restored.elements.from.value, '2026-10-16');
  assert.equal(restored.elements.through.value, '2026-10-20');
});

test('Escape while the calendar is open leaves the dashboard open', async () => {
  const app = await dashboard();
  await app.elements.launcher.onclick();
  app.elements.fromCalendar.click();
  for (const handler of app.root.listeners.keydown)
    handler({ key: 'Escape', target: app.elements.calendarClose });
  assert.equal(app.elements.shell.hidden, false);
});

const route = {
  origin: { id: '341', name: 'Hat Yai' },
  destination: { id: '1679', name: 'Bangkok' },
};
const availability = (endpoint, params) =>
  endpoint === 'getStation'
    ? []
    : endpoint === 'getTrip'
      ? [{ tripId: params.dateStart, trainNo: '38', departureTime: '18:00', arrivalTime: '10:00' }]
      : {
          results: [
            {
              coachId: '116',
              coachClass: '1',
              coachSeatTypeEn: 'Sleeping Coach',
              availableSeatCount: 2,
              coachSeats: [],
            },
          ],
        };
async function fireDateCheck(app) {
  const pending = [...app.timers].filter(([, timer]) => timer.delay === 300);
  assert.equal(pending.length, 1);
  const [id, timer] = pending[0];
  app.timers.delete(id);
  timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
}

test('date changes automatically fetch the final range once and reuse each date when switching back', async () => {
  const app = await dashboard({
    responses: availability,
    saved: { railWatch: { schema: 2, route, from: '2026-10-21', through: '2026-10-21', data: [] } },
  });
  await app.elements.launcher.onclick();
  app.requests.length = 0;
  app.elements.from.value = '2026-10-22';
  app.elements.from.emit('change');
  app.elements.through.value = '2026-10-23';
  app.elements.through.emit('change');
  assert.deepEqual(app.requests, []);
  await fireDateCheck(app);
  assert.deepEqual(app.requests, ['getTrip', 'getTrainCoach', 'getTrip', 'getTrainCoach']);
  assert.deepEqual(
    app.memory.railWatch.data.map((row) => row.date),
    ['22/10/2026', '23/10/2026'],
  );
  app.elements.through.value = '2026-10-22';
  app.elements.through.emit('change');
  await fireDateCheck(app);
  assert.equal(app.requests.length, 4);
  assert.deepEqual(
    app.memory.railWatch.data.map((row) => row.date),
    ['22/10/2026'],
  );
  app.elements.through.value = '2026-10-23';
  app.elements.through.emit('change');
  await fireDateCheck(app);
  assert.equal(app.requests.length, 4);
  const alerts = app.messages.filter((message) => message.type === 'rail-watch-alerts');
  assert.equal(alerts.length, 1);
  app.setTime('2026-10-13T05:15:01Z');
  app.elements.through.value = '2026-10-22';
  app.elements.through.emit('change');
  await fireDateCheck(app);
  assert.deepEqual(app.requests, [
    'getTrip',
    'getTrainCoach',
    'getTrip',
    'getTrainCoach',
    'getTrainCoach',
  ]);
});

test('calendar selection fetches automatically and closing or pausing cancels the pending date check', async () => {
  const app = await dashboard({
    responses: availability,
    saved: { railWatch: { schema: 2, route, from: '2026-10-21', through: '2026-10-21', data: [] } },
  });
  await app.elements.launcher.onclick();
  app.requests.length = 0;
  app.elements.fromCalendar.click();
  app.elements.calendarDays.onclick({
    target: { closest: () => ({ dataset: { day: '2026-10-22' }, disabled: false }) },
  });
  await fireDateCheck(app);
  assert.equal(app.requests.length, 2);
  app.elements.from.value = '2026-10-23';
  app.elements.from.emit('change');
  assert.match(app.elements.matrix.innerHTML, /Waiting/);
  app.elements.pause.click();
  assert.doesNotMatch(app.elements.matrix.innerHTML, /Waiting|Checking/);
  assert.match(app.elements.matrix.innerHTML, /Not checked/);
  assert.equal(
    [...app.timers.values()].some((timer) => timer.delay === 300),
    false,
  );
  assert.equal(app.requests.length, 2);
  app.elements.pause.click();
  app.elements.from.value = '2026-10-24';
  app.elements.from.emit('change');
  app.elements.close.click();
  assert.equal(
    [...app.timers.values()].some((timer) => timer.delay === 300),
    false,
  );
  assert.equal(app.requests.length, 2);
});

test('changing dates during a fetch keeps the picker usable and checks the latest selection afterwards', async () => {
  let finishCoach;
  const app = await dashboard({
    saved: { railWatch: { schema: 2, route, from: '2026-10-21', through: '2026-10-21', data: [] } },
    responses: (endpoint, params) =>
      endpoint === 'getTrainCoach' && params.tripId === '22/10/2026'
        ? new Promise((resolve) => {
            finishCoach = () => resolve(availability(endpoint, params));
          })
        : availability(endpoint, params),
  });
  await app.elements.launcher.onclick();
  app.requests.length = 0;
  app.elements.from.value = '2026-10-22';
  app.elements.from.emit('change');
  await fireDateCheck(app);
  assert.equal(app.elements.fromCalendar.disabled, false);
  assert.equal(app.elements.throughCalendar.disabled, false);
  app.elements.from.value = '2026-10-23';
  app.elements.from.emit('change');
  assert.match(app.elements.statusText.textContent, /Checking 22\/10\/2026/);
  await fireDateCheck(app);
  assert.deepEqual(app.requests, ['getTrip', 'getTrainCoach']);
  finishCoach();
  await new Promise((resolve) => setImmediate(resolve));
  await fireDateCheck(app);
  assert.deepEqual(
    app.memory.railWatch.data.map((row) => row.date),
    ['23/10/2026'],
  );
  const alerts = app.messages.filter((message) => message.type === 'rail-watch-alerts');
  assert.equal(alerts.length, 1);
  assert.deepEqual([...alerts[0].config.dates], ['23/10/2026']);
  assert.equal(app.elements.from.value, '2026-10-23');
});

test('cached 14–17 and 14–16 ranges hide excluded dates and do not rebuild or fade after the cache check', async () => {
  const app = await dashboard({
    responses: availability,
    saved: { railWatch: { schema: 2, route, from: '2026-10-14', through: '2026-10-14', data: [] } },
  });
  await app.elements.launcher.onclick();
  app.requests.length = 0;
  app.elements.through.value = '2026-10-17';
  app.elements.through.emit('change');
  await fireDateCheck(app);
  const requests = app.requests.length;
  for (const fn of app.root.listeners.click)
    fn({
      target: {
        closest: (selector) =>
          selector === '[data-action="cell"]'
            ? { dataset: { date: '14/10/2026', train: '38' } }
            : null,
      },
    });
  let markup = app.elements.matrix.innerHTML,
    writes = 0;
  Object.defineProperty(app.elements.matrix, 'innerHTML', {
    get: () => markup,
    set(value) {
      writes++;
      markup = value;
    },
  });
  const changes = [];
  const toggle = app.elements.shell.classList.toggle;
  app.elements.shell.classList.toggle = (name, value) => {
    if (name === 'is-checking') changes.push(value);
    return toggle(name, value);
  };
  app.elements.through.value = '2026-10-16';
  app.elements.through.emit('change');
  assert.doesNotMatch(markup, /17\/10\/2026|skel-cell|<tfoot/);
  const reduced = markup,
    writesAfterChange = writes;
  await fireDateCheck(app);
  assert.equal(markup, reduced);
  assert.equal(writes, writesAfterChange);
  assert.doesNotMatch(markup, /17\/10\/2026|skel-cell|<tfoot/);
  app.elements.through.value = '2026-10-17';
  app.elements.through.emit('change');
  const expanded = markup,
    writesAfterExpand = writes;
  assert.doesNotMatch(markup, /data-dmy="17\/10\/2026"/);
  assert.match(markup, /data-date="17\/10\/2026"/);
  await fireDateCheck(app);
  assert.equal(markup, expanded);
  assert.equal(writes, writesAfterExpand);
  assert.equal(app.requests.length, requests);
  assert.equal(changes.includes(true), false);
  assert.deepEqual(app.memory.railWatch.selected, ['14/10/2026', '38']);
});

test('reopening after cancelling a queued date check clears its loading state', async () => {
  const app = await dashboard({
    responses: availability,
    saved: { railWatch: { schema: 2, route, from: '2026-10-21', through: '2026-10-21', data: [] } },
  });
  await app.elements.launcher.onclick();
  app.elements.from.value = '2026-10-22';
  app.elements.from.emit('change');
  assert.match(app.elements.matrix.innerHTML, /Checking availability/);
  app.elements.close.click();
  await app.elements.launcher.onclick();
  assert.doesNotMatch(app.elements.matrix.innerHTML, /Checking availability|Waiting/);
  assert.match(app.elements.matrix.innerHTML, /data-recheck-empty/);
  assert.equal(
    [...app.timers.values()].some((timer) => timer.delay === 300),
    false,
  );
  assert.equal(app.requests.filter(([name]) => name === 'getTrip').length, 0);
});
