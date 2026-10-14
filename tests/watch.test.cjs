const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { dashboard } = require('./dashboard-harness.cjs');
const now = Date.parse('2026-10-13T05:00:00Z');
const passenger = {
  mode: 'custom',
  firstName: 'Chosen',
  lastName: 'Passenger',
  gender: 'F',
  foreignerFlag: 'Y',
  idCard: 'AA123456',
  mobileNo: '0812345678',
  email: '',
};
const bookingUrl = 'https://dticket.railway.co.th/DTicketPublicWeb/booking/booking';
const outboundChoice = { train: '170', coachId: '123|24|4|5', coachLabel: 'Class 3 fan' };
const target = {
  origin: '341',
  destination: '1679',
  date: '21/10/2026',
  alternatives: [outboundChoice],
  passengers: [passenger],
};
async function selectWatchChoice(app, leg, choice, checked = true) {
  const input = {
    dataset: { watchLeg: leg, train: choice.train, coachId: choice.coachId },
    checked,
    closest(selector) {
      return selector === '[data-watch-leg]' ? this : null;
    },
    matches() {
      return false;
    },
  };
  for (const listener of app.root.listeners.change) listener({ target: input });
  await new Promise((resolve) => setImmediate(resolve));
}
function service({
  failOpen = false,
  saved = {},
  savedSession = {},
  onCreate,
  failBinding = false,
} = {}) {
  const local = structuredClone(saved),
    session = structuredClone(savedSession),
    listeners = [],
    urls = [],
    timeline = [],
    alarms = new Map(),
    alarmListeners = [],
    removedListeners = [],
    removedTabs = [];
  let clock = now,
    id = 0;
  const storage = (memory) => ({
    async get(keys) {
      return Object.fromEntries(
        (keys || Object.keys(memory))
          .filter((key) => key in memory)
          .map((key) => [key, structuredClone(memory[key])]),
      );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete memory[key];
    },
    async set(values) {
      if (
        failBinding &&
        memory === session &&
        Object.values(values).some((record) => record?.tabId)
      )
        throw Error('Cannot bind booking tab');
      Object.assign(memory, structuredClone(values));
      if (values.railWatchBookingWatch) timeline.push(values.railWatchBookingWatch.status);
    },
  });
  const context = vm.createContext({
    Date: class extends Date {
      static now() {
        return clock;
      }
    },
    URL,
    crypto: { randomUUID: () => 'id-' + ++id },
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } },
      notifications: { onClicked: { addListener() {} } },
      storage: { local: storage(local), session: storage(session) },
      alarms: {
        onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
        async create(name, options) {
          alarms.set(name, options);
        },
        async clear(name) {
          alarms.delete(name);
        },
      },
      tabs: {
        onRemoved: { addListener: (fn) => removedListeners.push(fn) },
        async remove(tabId) {
          removedTabs.push(tabId);
          removedListeners.forEach((fn) => fn(tabId));
        },
        async create({ url }) {
          timeline.push('tab-create');
          if (failOpen) throw Error('Cannot open tab');
          onCreate?.(url);
          urls.push(url);
          return { id: urls.length };
        },
      },
    },
    importScripts(...files) {
      for (const file of files)
        vm.runInContext(fs.readFileSync('extension/' + file, 'utf8'), context);
    },
  });
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  function call(
    message,
    url = 'https://dticket.railway.co.th/DTicketPublicWeb/home/Home',
    tabId = 1,
  ) {
    return new Promise((resolve) => {
      for (const fn of listeners) {
        let answered = false;
        const keepAlive = fn(message, { url, tab: { id: tabId } }, (result) => {
          answered = true;
          resolve(JSON.parse(JSON.stringify(result)));
        });
        if (keepAlive === true || answered) return;
      }
      resolve(undefined);
    });
  }
  const result = (id) => ({
    type: 'rail-watch-result',
    id,
    checks: [
      {
        config: { origin: '341', destination: '1679', dates: ['21/10/2026'] },
        fresh: true,
        at: clock,
        rows: [
          {
            date: '21/10/2026',
            train: '170',
            checkedAt: new Date(clock).toISOString(),
            coaches: [{ id: '123|24|4|5', count: 1 }],
          },
        ],
      },
    ],
  });
  return {
    local,
    rules: context.RailWatchWatch,
    session,
    urls,
    timeline,
    alarms,
    removedTabs,
    async closeTab(tabId) {
      removedListeners.forEach((fn) => fn(tabId));
      await new Promise((resolve) => setImmediate(resolve));
    },
    async fireAlarms() {
      for (const [name, options] of [...alarms]) {
        if (options.when <= clock) {
          alarms.delete(name);
          alarmListeners.forEach((fn) => fn({ name }));
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    call,
    result,
    clock(value) {
      clock = value;
    },
  };
}
test('multiple tabs finding the same one seat open one booking and retain the armed passenger outside the URL', async () => {
  const h = service();
  const { watch } = await h.call({ type: 'rail-watch-arm', watch: target });
  h.local.railWatchPassenger = { ...passenger, firstName: 'Different' };
  await Promise.all([
    h.call(h.result(watch.id)),
    h.call(h.result(watch.id)),
    h.call(h.result(watch.id)),
  ]);
  assert.equal(h.urls.length, 1);
  assert.deepEqual(h.timeline, ['armed', 'opening', 'tab-create', 'opened']);
  const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
  assert.equal(handoff.trainNo, '170');
  assert.equal(handoff.coachId, '123|24|4|5');
  assert.equal(handoff.autoFill, true);
  assert.equal(h.urls[0].includes('AA123456'), false);
  assert.equal(h.urls[0].includes('Chosen'), false);
  const resolved = await h.call(
    { type: 'rail-watch-passenger', bookingId: handoff.bookingId },
    bookingUrl,
  );
  assert.deepEqual(resolved.passengers, [passenger]);
  h.clock(now + 120001);
  assert.match(
    (await h.call({ type: 'rail-watch-passenger', bookingId: handoff.bookingId }, bookingUrl))
      .error,
    /expired/,
  );
});
test('cached, stale, pre-arm, wrong route, wrong date, wrong train and other coach counts never trigger', async () => {
  const h = service();
  const { watch } = await h.call({ type: 'rail-watch-arm', watch: target });
  const cases = [
    (r) => (r.checks[0].fresh = false),
    (r) => (r.checks[0].at = now - 1),
    (r) => (r.checks[0].rows[0].checkedAt = new Date(now - 1).toISOString()),
    (r) => (r.checks[0].config.origin = '999'),
    (r) => (r.checks[0].rows[0].date = '22/10/2026'),
    (r) => (r.checks[0].rows[0].train = '38'),
    (r) => (r.checks[0].rows[0].coaches[0].id = '123|25|4|5'),
    (r) => (r.checks[0].rows[0].coaches[0].count = 0),
    (r) => (r.checks[0].rows[0].coaches[0].count = NaN),
    (r) =>
      (r.checks[0].rows[0].coaches = [
        { id: 'different', count: 40 },
        { id: outboundChoice.coachId, count: 0 },
      ]),
  ];
  for (const change of cases) {
    const r = h.result(watch.id);
    change(r);
    await h.call(r);
  }
  const stale = h.result(watch.id);
  h.clock(now + 60001);
  await h.call(stale);
  assert.deepEqual(h.urls, []);
  assert.equal(h.local.railWatchBookingWatch.status, 'armed');
});
test('manual bookings and armed watches transfer the chosen lower-berth preference', async () => {
  for (const preferLowerBerths of [undefined, true, false]) {
    const manual = service();
    const params = {
      provinceStartId: target.origin,
      provinceEndId: target.destination,
      dateStart: target.date,
      trainNo: outboundChoice.train,
      coachId: outboundChoice.coachId,
      autoFill: true,
      preferLowerBerths,
    };
    assert.equal(
      (await manual.call({ type: 'rail-watch-booking', params, passengers: [passenger] })).ok,
      true,
    );
    const watched = service();
    const { watch } = await watched.call({
      type: 'rail-watch-arm',
      watch: { ...target, preferLowerBerths },
    });
    await watched.call(watched.result(watch.id));
    for (const h of [manual, watched]) {
      assert.equal(h.urls.length, 1);
      const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
      assert.equal(handoff.preferLowerBerths, preferLowerBerths);
    }
  }
});
test('invalid lower-berth preferences reject manual bookings and watches before opening a tab', async () => {
  for (const preferLowerBerths of ['false', null, 0, {}, []]) {
    const h = service();
    const params = {
      provinceStartId: target.origin,
      provinceEndId: target.destination,
      dateStart: target.date,
      trainNo: outboundChoice.train,
      preferLowerBerths,
    };
    assert.ok(
      (await h.call({ type: 'rail-watch-booking', params, passengers: [passenger] })).error,
    );
    assert.ok(
      (await h.call({ type: 'rail-watch-arm', watch: { ...target, preferLowerBerths } })).error,
    );
    assert.deepEqual(h.urls, []);
    assert.deepEqual(h.session, {});
    assert.equal(h.local.railWatchBookingWatch, undefined);
  }
});
test('cancel prevents delayed results and old watch IDs cannot trigger a newly armed watch', async () => {
  const h = service();
  const first = (await h.call({ type: 'rail-watch-arm', watch: target })).watch;
  await h.call({ type: 'rail-watch-cancel', id: first.id });
  await h.call(h.result(first.id));
  assert.equal(h.urls.length, 0);
  const second = (await h.call({ type: 'rail-watch-arm', watch: target })).watch;
  await h.call(h.result(first.id));
  assert.equal(h.urls.length, 0);
  await h.call(h.result(second.id));
  assert.equal(h.urls.length, 1);
});
test('tab failures and a worker restart during opening leave the watch stopped until explicitly rearmed', async () => {
  const h = service({ failOpen: true });
  const { watch } = await h.call({ type: 'rail-watch-arm', watch: target });
  await h.call(h.result(watch.id));
  await h.call(h.result(watch.id));
  assert.equal(h.local.railWatchBookingWatch.status, 'error');
  assert.match(h.local.railWatchBookingWatch.error, /Cannot open/);
  assert.equal(h.timeline.filter((e) => e === 'tab-create').length, 1);
  const restarted = service({ saved: { railWatchBookingWatch: { ...watch, status: 'opening' } } });
  await restarted.call(restarted.result(watch.id));
  assert.equal(restarted.urls.length, 0);
  await restarted.call({ type: 'rail-watch-cancel', id: watch.id });
  assert.equal(restarted.local.railWatchBookingWatch.status, 'cancelled');
});
test('watch validation rejects incomplete passenger setups, replaces no active watch and rejects external senders', async () => {
  const h = service();
  for (const watch of [
    { ...target, alternatives: [{ ...outboundChoice, coachId: '' }] },
    { ...target, passengers: [{ mode: 'manual' }] },
    { ...target, passengers: [{ ...passenger, firstName: '' }] },
  ])
    assert.ok((await h.call({ type: 'rail-watch-arm', watch })).error);
  assert.ok((await h.call({ type: 'rail-watch-arm', watch: target }, 'https://example.com')).error);
  await h.call({ type: 'rail-watch-arm', watch: target });
  assert.match((await h.call({ type: 'rail-watch-arm', watch: target })).error, /Cancel/);
});
test('modal setup selects sold-out trains and coaches, immediately checks them, cancels and restores the watch', async () => {
  const h = service();
  const responses = {
    getTrip: [{ tripId: 'trip', trainNo: '170' }],
    getTrainCoach: {
      results: [
        {
          coachId: '123',
          coachNo: '24',
          coachLayoutId: '4',
          coachTypeId: '5',
          coachClass: '3',
          availableSeatCount: 0,
          coachSeats: [],
        },
      ],
    },
  };
  const saved = {
    railWatchPassenger: passenger,
    railWatch: {
      schema: 2,
      route: {
        origin: { id: '341', name: 'Hat Yai' },
        destination: { id: '1679', name: 'Bangkok' },
      },
      from: '2026-10-21',
      through: '2026-10-21',
      data: [
        {
          date: '21/10/2026',
          train: '170',
          departure: '18:20',
          arrival: '10:50',
          coaches: [
            { id: outboundChoice.coachId, class: '3', desc: 'Class 3 fan', count: 0, prices: [] },
          ],
        },
      ],
    },
  };
  const app = await dashboard({
    saved,
    responses,
    handleMessage: async (message, storage) => {
      if (message.type === 'rail-watch-alerts') return { ok: true };
      const reply = await h.call(message);
      if (reply.watch) await storage.set({ railWatchBookingWatch: reply.watch });
      return reply;
    },
  });
  app.elements.bookingSetup.click();
  assert.equal(app.elements.bookingSetupDialog.open, true);
  assert.equal(app.elements.armWatch.disabled, true);
  assert.equal(app.elements.bookNow.disabled, true);
  assert.match(app.elements.watchChoices.innerHTML, /Sold out/);
  await selectWatchChoice(app, 'outbound', outboundChoice);
  assert.equal(app.elements.armWatch.disabled, false);
  assert.deepEqual(app.memory.railWatchBookingSetup.choices.outbound, {
    scope: JSON.stringify(['341', '1679', '21/10/2026']),
    alternatives: [outboundChoice],
  });
  await app.elements.armWatch.onclick();
  assert.deepEqual(app.requests, ['getTrip', 'getTrainCoach']);
  assert.deepEqual(h.urls, []);
  assert.equal(app.elements.origin.disabled, true);
  assert.equal(app.elements.passengerMode.disabled, true);
  assert.equal(app.elements.cancelWatch.hidden, false);
  app.elements.bookingSetupDone.click();
  assert.equal(app.elements.bookingSetupDialog.open, false);
  assert.equal(app.elements.watchBannerTitle.textContent, 'Watching for 1 seat');
  assert.match(app.elements.watchBannerMeta.textContent, /1 train · 1 coach/);
  assert.equal(app.elements.watchLockHint.hidden, false);
  const restored = await dashboard({ saved: app.memory });
  assert.match(restored.elements.watchChoices.innerHTML, /data-train="170"[^>]* checked disabled/);
  assert.equal(restored.elements.origin.disabled, true);
  await app.elements.cancelWatch.onclick();
  assert.equal(app.elements.origin.disabled, false);
  assert.equal(app.elements.cancelWatch.hidden, true);
  app.elements.bookingSetup.click();
  await app.elements.armWatch.onclick();
  responses.getTrainCoach.results[0].availableSeatCount = 1;
  await app.elements.refresh.onclick();
  assert.equal(h.urls.length, 1);
  assert.equal(app.elements.armWatch.hidden, false);
  assert.equal(app.elements.watchBannerTitle.textContent, 'Booking opened · watch stopped');
  assert.equal(app.elements.watchLockHint.hidden, true);
  assert.equal(app.elements.bookingSetupHeading.textContent, 'Booking opened');
  assert.equal(app.elements.bookingSetupFields.hidden, true);
  assert.equal(app.elements.watchOutcome.hidden, false);
  assert.equal(app.root.activeElement.id, 'watchOutcome');
  assert.match(app.elements.watchOutcomeMessage.textContent, /Review the passenger details/);
  assert.match(app.elements.watchOutcomeTrips.innerHTML, /Train 170/);
});
test('setup close buttons and Escape preserve the dashboard and validation errors appear inside the modal', async () => {
  const app = await dashboard();
  await app.elements.launcher.onclick();
  app.elements.bookingSetup.click();
  assert.equal(app.elements.armWatch.disabled, true);
  for (const listener of app.root.listeners.keydown)
    listener({ key: 'Escape', target: { closest: () => null } });
  assert.equal(app.elements.shell.hidden, false);
  app.elements.bookingSetupClose.click();
  assert.equal(app.elements.bookingSetupDialog.open, false);
  app.elements.bookingSetup.click();
  await app.elements.armWatch.onclick();
  assert.equal(app.elements.bookingSetupError.hidden, false);
  assert.match(app.elements.bookingSetupError.textContent, /stations|route|date/i);
});

test('multi-train setup checks each train once and opens only a fresh chosen coach with seats for the group', async () => {
  const h = service();
  const secondCoach = { train: '170', coachId: '124|25|4|5', coachLabel: 'Second coach' };
  const fallback = { train: '172', coachId: '456|2|4|5', coachLabel: 'Later train' };
  const profiles = [{ mode: 'account' }, passenger];
  let fallbackSeats = 1;
  const calls = [];
  const app = await dashboard({
    saved: {
      railWatchPassengers: profiles,
      railWatch: {
        schema: 2,
        route: {
          origin: { id: '341', name: 'Hat Yai' },
          destination: { id: '1679', name: 'Bangkok' },
        },
        from: '2026-10-21',
        through: '2026-10-21',
        data: [
          {
            date: target.date,
            train: '172',
            departure: '19:20',
            arrival: '11:50',
            coaches: [{ id: fallback.coachId, class: '3', desc: fallback.coachLabel, count: 2 }],
          },
          {
            date: target.date,
            train: '170',
            departure: '18:20',
            arrival: '10:50',
            coaches: [outboundChoice, secondCoach].map((choice) => ({
              id: choice.coachId,
              class: '3',
              desc: choice.coachLabel,
              count: 2,
            })),
          },
        ],
      },
    },
    responses(endpoint, params) {
      calls.push({ endpoint, params: structuredClone(params) });
      if (endpoint === 'getTrip')
        return [
          { tripId: 'first', trainNo: '170' },
          { tripId: 'later', trainNo: '172' },
        ];
      const choices =
        params.tripId === 'first'
          ? [
              [outboundChoice.coachId, 1],
              [secondCoach.coachId, 1],
              ['999|9|4|5', 5],
            ]
          : [[fallback.coachId, fallbackSeats]];
      return {
        results: choices.map(([id, count]) => {
          const [coachId, coachNo, coachLayoutId, coachTypeId] = id.split('|');
          return {
            coachId,
            coachNo,
            coachLayoutId,
            coachTypeId,
            coachClass: '3',
            coachDesc:
              [outboundChoice, secondCoach, fallback].find((choice) => choice.coachId === id)
                ?.coachLabel || 'Unchosen coach',
            availableSeatCount: count,
            coachSeats: [],
          };
        }),
      };
    },
    handleMessage: async (message, storage) => {
      if (message.type === 'rail-watch-alerts') return { ok: true };
      const reply = await h.call(message);
      if (reply.watch) await storage.set({ railWatchBookingWatch: reply.watch });
      return reply;
    },
  });
  app.elements.bookingSetup.click();
  await selectWatchChoice(app, 'outbound', fallback);
  await selectWatchChoice(app, 'outbound', secondCoach);
  await selectWatchChoice(app, 'outbound', outboundChoice);
  assert.deepEqual(app.memory.railWatchBookingSetup.choices.outbound.alternatives, [
    outboundChoice,
    secondCoach,
    fallback,
  ]);
  await app.elements.bookNow.onclick();
  assert.equal(h.urls.length, 0);
  assert.match(app.elements.bookingSetupError.textContent, /enough fresh seats for everyone/);
  assert.deepEqual(
    calls.filter((call) => call.endpoint === 'getTrainCoach').map((call) => call.params.tripId),
    ['first', 'later'],
  );
  assert.deepEqual(calls, [
    {
      endpoint: 'getTrip',
      params: {
        tripType: '1',
        provinceStartId: '341',
        provinceEndId: '1679',
        dateStart: '21/10/2026',
        dateEnd: '',
      },
    },
    {
      endpoint: 'getTrainCoach',
      params: { tripId: 'first', provinceStartId: '341', provinceEndId: '1679' },
    },
    {
      endpoint: 'getTrainCoach',
      params: { tripId: 'later', provinceStartId: '341', provinceEndId: '1679' },
    },
  ]);
  calls.length = 0;
  await app.elements.armWatch.onclick();
  assert.equal(h.local.railWatchBookingWatch.status, 'armed');
  assert.deepEqual(
    calls.filter((call) => call.endpoint === 'getTrainCoach').map((call) => call.params.tripId),
    ['first', 'later'],
  );
  const initialCheck = app.messages
    .filter((message) => message.type === 'rail-watch-result')
    .at(-1);
  assert.deepEqual(
    initialCheck.checks[0].rows.map((row) => [row.train, row.coaches.map((coach) => coach.count)]),
    [
      ['170', [1, 1, 5]],
      ['172', [1]],
    ],
  );
  assert.deepEqual(initialCheck.checks[0].config, {
    origin: '341',
    destination: '1679',
    dates: ['21/10/2026'],
    filter: 'all',
  });
  fallbackSeats = 2;
  calls.length = 0;
  await app.elements.refresh.onclick();
  assert.equal(h.urls.length, 1);
  assert.deepEqual(h.local.railWatchBookingWatch.selected, fallback);
  assert.deepEqual(
    calls.filter((call) => call.endpoint === 'getTrainCoach').map((call) => call.params.tripId),
    ['first', 'later'],
  );
  const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
  assert.equal(handoff.trainNo, '172');
  assert.equal(handoff.coachId, fallback.coachId);
  assert.equal(handoff.seatCount, 2);
  await app.elements.bookNow.onclick();
  assert.equal(h.urls.length, 2);
  assert.deepEqual(app.messages.filter((message) => message.type === 'rail-watch-booking').at(-1), {
    type: 'rail-watch-booking',
    passengers: profiles,
    params: {
      provinceStartId: '341',
      provinceEndId: '1679',
      dateStart: '21/10/2026',
      trainNo: '172',
      coachId: fallback.coachId,
      autoFill: true,
      preferLowerBerths: true,
      seatCount: 2,
    },
  });
});

test('a group watch waits for seats for everyone, opens once and passes the full passenger snapshot', async () => {
  const h = service();
  const profiles = [
    { mode: 'account' },
    passenger,
    { ...passenger, firstName: 'Third', idCard: 'AA123457' },
  ];
  const { watch } = await h.call({
    type: 'rail-watch-arm',
    watch: { ...target, passengers: profiles },
  });
  const result = h.result(watch.id);
  result.checks[0].rows[0].coaches[0].count = 2;
  await h.call(result);
  assert.equal(h.urls.length, 0);
  assert.equal(h.local.railWatchBookingWatch.status, 'armed');
  result.checks[0].rows[0].coaches[0].count = 3;
  await h.call(result);
  await h.call(result);
  assert.equal(h.urls.length, 1);
  const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
  assert.equal(handoff.seatCount, 3);
  const reply = await h.call(
    { type: 'rail-watch-passenger', bookingId: handoff.bookingId },
    bookingUrl,
  );
  assert.deepEqual(reply.passengers, profiles);
});

const returnChoice = { train: '37', coachId: '456|2|4|5', coachLabel: 'Return sleeper' };
const returnLeg = { date: '25/10/2026', alternatives: [returnChoice] };
function pairedResult(h, id, outbound = 2, inbound = 2) {
  const departure = h.result(id).checks[0];
  departure.rows[0].coaches[0].count = outbound;
  const arrival = {
    fresh: true,
    at: departure.at,
    config: { origin: target.destination, destination: target.origin, dates: [returnLeg.date] },
    rows: [
      {
        date: returnLeg.date,
        train: returnChoice.train,
        checkedAt: departure.rows[0].checkedAt,
        coaches: [{ id: returnChoice.coachId, count: inbound }],
      },
    ],
  };
  return { type: 'rail-watch-result', id, checks: [departure, arrival] };
}
test('round-trip watch needs fresh seats on both exact legs in the same check and opens once', async () => {
  const h = service();
  const { watch } = await h.call({
    type: 'rail-watch-arm',
    watch: { ...target, passengers: [{ mode: 'account' }, passenger], returnLeg },
  });
  await h.call(h.result(watch.id));
  await h.call(pairedResult(h, watch.id, 2, 1));
  await h.call(pairedResult(h, watch.id, 1, 2));
  const stale = pairedResult(h, watch.id);
  stale.checks[1].rows[0].checkedAt = new Date(now - 1).toISOString();
  await h.call(stale);
  const wrong = pairedResult(h, watch.id);
  wrong.checks[1].config.origin = target.origin;
  await h.call(wrong);
  const wrongCoach = pairedResult(h, watch.id);
  wrongCoach.checks[1].rows[0].coaches[0].id = outboundChoice.coachId;
  await h.call(wrongCoach);
  assert.equal(h.urls.length, 0);
  await Promise.all([h.call(pairedResult(h, watch.id)), h.call(pairedResult(h, watch.id))]);
  assert.equal(h.urls.length, 1);
  const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
  assert.deepEqual(handoff.returnLeg, {
    date: returnLeg.date,
    train: returnChoice.train,
    coachId: returnChoice.coachId,
  });
  assert.equal(handoff.seatCount, 2);
  assert.equal(h.urls[0].includes(passenger.idCard), false);
});
test('round-trip setup rejects incomplete return legs and invalid or earlier return dates', async () => {
  for (const changes of [
    { date: '20/10/2026' },
    { date: '31/02/2027' },
    { train: '' },
    { coachId: '' },
  ]) {
    const h = service();
    const result = await h.call({
      type: 'rail-watch-arm',
      watch: {
        ...target,
        returnLeg: {
          date: changes.date || returnLeg.date,
          alternatives: [{ ...returnChoice, ...changes }],
        },
      },
    });
    assert.ok(result.error);
    assert.equal(h.urls.length, 0);
  }
});
test('round-trip modal loads the reverse route and checks both legs before watch or Book now', async () => {
  let inboundSeats = 1;
  const h = service();
  const outboundCoach = {
    id: outboundChoice.coachId,
    class: '3',
    desc: 'Outbound coach',
    count: 2,
    prices: [],
  };
  const saved = {
    railWatchPassengers: [{ mode: 'account' }, passenger],
    railWatchBookingSetup: { tripType: '2', returnDate: '2026-10-25' },
    railWatch: {
      schema: 2,
      route: {
        origin: { id: '341', name: 'Hat Yai' },
        destination: { id: '1679', name: 'Bangkok' },
      },
      from: '2026-10-21',
      through: '2026-10-21',
      data: [
        {
          date: target.date,
          train: outboundChoice.train,
          departure: '18:20',
          arrival: '10:50',
          coaches: [outboundCoach],
        },
      ],
    },
  };
  const responses = (endpoint, params) =>
    endpoint === 'getTrip'
      ? [
          {
            tripId: params.provinceStartId === '341' ? 'out' : 'return',
            trainNo: params.provinceStartId === '341' ? '170' : '37',
          },
        ]
      : {
          results: [
            {
              coachId: params.tripId === 'out' ? '123' : '456',
              coachNo: params.tripId === 'out' ? '24' : '2',
              coachLayoutId: '4',
              coachTypeId: '5',
              coachClass: '3',
              coachDesc: params.tripId === 'out' ? 'Outbound coach' : 'Return sleeper',
              availableSeatCount: params.tripId === 'out' ? 2 : inboundSeats,
              coachSeats: [],
            },
          ],
        };
  const app = await dashboard({
    saved,
    responses,
    handleMessage: async (message, storage) => {
      if (message.type === 'rail-watch-alerts') return { ok: true };
      const reply = await h.call(message);
      if (reply.watch) await storage.set({ railWatchBookingWatch: reply.watch });
      return reply;
    },
  });
  app.elements.bookingSetup.click();
  assert.equal(app.elements.returnLegFields.hidden, false);
  assert.equal(app.elements.bookNow.disabled, true);
  await selectWatchChoice(app, 'outbound', outboundChoice);
  await app.elements.loadReturn.onclick();
  assert.equal(app.elements.bookNow.disabled, true);
  assert.match(app.elements.returnChoices.innerHTML, /data-train="37"/);
  await selectWatchChoice(app, 'return', returnChoice);
  assert.equal(app.elements.bookNow.disabled, false);
  await app.elements.bookNow.onclick();
  assert.equal(h.urls.length, 0);
  assert.match(app.elements.bookingSetupError.textContent, /both legs/);
  await app.elements.armWatch.onclick();
  assert.equal(h.urls.length, 0);
  assert.match(app.elements.watchStatus.textContent, /on each leg/);
  assert.equal(app.elements.bookingTripType.disabled, true);
  assert.equal(app.elements.returnDate.disabled, true);
  const restored = await dashboard({ saved: app.memory });
  assert.match(restored.elements.returnChoices.innerHTML, /data-train="37"[^>]* checked disabled/);
  assert.equal(restored.elements.returnDate.value, '2026-10-25');
  inboundSeats = 2;
  await app.elements.refresh.onclick();
  assert.equal(h.urls.length, 1);
  assert.equal(
    app.messages.filter((message) => message.type === 'rail-watch-result').at(-1).checks.length,
    2,
  );
  const checks = app.messages
    .filter((message) => message.type === 'rail-watch-result')
    .at(-1).checks;
  assert.equal(checks[0].config.origin, '341');
  assert.equal(checks[1].config.origin, '1679');
  assert.deepEqual(h.local.railWatchBookingWatch.selected, {
    train: '170',
    coachId: outboundChoice.coachId,
    coachLabel: 'Outbound coach',
    returnLeg: { date: '25/10/2026', ...returnChoice },
  });
  await app.elements.bookNow.onclick();
  assert.equal(h.urls.length, 2);
  assert.deepEqual(app.messages.filter((message) => message.type === 'rail-watch-booking').at(-1), {
    type: 'rail-watch-booking',
    passengers: [{ mode: 'account' }, passenger],
    params: {
      provinceStartId: '341',
      provinceEndId: '1679',
      dateStart: '21/10/2026',
      trainNo: '170',
      coachId: outboundChoice.coachId,
      returnLeg: { date: '25/10/2026', ...returnChoice },
      autoFill: true,
      preferLowerBerths: true,
      seatCount: 2,
    },
  });
});

test('passenger handoffs are restricted to the created booking tab and real booking page', async () => {
  const h = service();
  const params = {
    provinceStartId: target.origin,
    provinceEndId: target.destination,
    dateStart: target.date,
    trainNo: outboundChoice.train,
    coachId: outboundChoice.coachId,
  };
  assert.equal(
    (await h.call({ type: 'rail-watch-booking', params, passengers: [passenger] })).ok,
    true,
  );
  const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
  const message = { type: 'rail-watch-passenger', bookingId: handoff.bookingId };
  assert.match((await h.call(message)).error, /sender/);
  assert.match((await h.call(message, bookingUrl, 2)).error, /sender/);
  assert.match((await h.call(message, bookingUrl, null)).error, /sender/);
  assert.deepEqual((await h.call(message, bookingUrl)).passengers, [passenger]);
  assert.equal(h.session['railWatchBookingPassenger_' + handoff.bookingId].tabId, 1);
});

test('passenger records disappear when the booking tab closes or their expiry alarm fires', async () => {
  const h = service();
  for (let i = 0; i < 2; i++) {
    const { watch } = await h.call({ type: 'rail-watch-arm', watch: target });
    await h.call(h.result(watch.id));
  }
  assert.equal(Object.keys(h.session).length, 2);
  await h.closeTab(1);
  assert.equal(Object.keys(h.session).length, 1);
  assert.equal(h.alarms.size, 1);
  h.clock(now + 120000);
  await h.fireAlarms();
  assert.deepEqual(h.session, {});
  assert.equal(h.alarms.size, 0);
});

test('failed tab creation rolls back passenger data and schedules no alarm', async () => {
  const h = service({ failOpen: true });
  const { watch } = await h.call({ type: 'rail-watch-arm', watch: target });
  await h.call(h.result(watch.id));
  assert.deepEqual(h.session, {});
  assert.equal(h.alarms.size, 0);
});

test('worker startup drops expired or unbound passenger records and restores expiry alarms', async () => {
  const h = service({
    savedSession: {
      railWatchBookingPassenger_expired: { passengers: [passenger], expires: now, tabId: 1 },
      railWatchBookingPassenger_unbound: { passengers: [passenger], expires: now + 1000 },
      railWatchBookingPassenger_invalid: { passengers: [], expires: now + 1000, tabId: 1 },
      railWatchBookingPassenger_valid: { passengers: [passenger], expires: now + 1000, tabId: 1 },
      unrelated: { retain: true },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(Object.keys(h.session).sort(), ['railWatchBookingPassenger_valid', 'unrelated']);
  assert.equal(h.alarms.get('rail-watch-passenger-valid').when, now + 1000);
  h.clock(now + 1000);
  await h.fireAlarms();
  assert.deepEqual(h.session, { unrelated: { retain: true } });
});

test('background rejects impossible booking dates and malformed messages without opening a tab', async () => {
  const h = service();
  const params = {
    provinceStartId: target.origin,
    provinceEndId: target.destination,
    dateStart: '31/02/2027',
    trainNo: outboundChoice.train,
  };
  assert.match((await h.call({ type: 'rail-watch-booking', params })).error, /Invalid/);
  assert.match(
    (
      await h.call({
        type: 'rail-watch-booking',
        params: { ...params, dateStart: target.date, autoFill: 'false' },
      })
    ).error,
    /Invalid/,
  );
  assert.equal(await h.call(null), undefined);
  assert.deepEqual(h.urls, []);
});

test('early passenger requests wait until the newly created tab is bound', async () => {
  let request;
  const h = service({
    onCreate(url) {
      const handoff = JSON.parse(decodeURIComponent(url.split('#rail-watch-search=')[1]));
      request = h.call({ type: 'rail-watch-passenger', bookingId: handoff.bookingId }, bookingUrl);
    },
  });
  const { watch } = await h.call({ type: 'rail-watch-arm', watch: target });
  await h.call(h.result(watch.id));
  assert.deepEqual((await request).passengers, [passenger]);
});

test('a tab closed while opening leaves no handoff and failed binding closes the created tab', async () => {
  let closure;
  const h = service({
    onCreate() {
      closure = h.closeTab(1);
    },
  });
  const { watch } = await h.call({ type: 'rail-watch-arm', watch: target });
  await h.call(h.result(watch.id));
  await closure;
  assert.deepEqual(h.session, {});
  assert.equal(h.alarms.size, 0);
  const failed = service({ failBinding: true });
  const arm = await failed.call({ type: 'rail-watch-arm', watch: target });
  await failed.call(failed.result(arm.watch.id));
  assert.equal(failed.local.railWatchBookingWatch.status, 'error');
  assert.match(failed.local.railWatchBookingWatch.error, /Cannot bind/);
  assert.deepEqual(failed.session, {});
  assert.equal(failed.alarms.size, 0);
  assert.deepEqual(failed.removedTabs, [1]);
});

test('stopped watches retain their journey and passenger count without private profile snapshots', async () => {
  for (const finalStatus of ['cancelled', 'opened', 'error']) {
    const h = service({ failOpen: finalStatus === 'error' });
    const { watch } = await h.call({ type: 'rail-watch-arm', watch: target });
    if (finalStatus === 'cancelled') await h.call({ type: 'rail-watch-cancel', id: watch.id });
    else await h.call(h.result(watch.id));
    assert.equal(h.local.railWatchBookingWatch.status, finalStatus);
    assert.equal(h.local.railWatchBookingWatch.date, target.date);
    assert.equal(h.local.railWatchBookingWatch.seatCount, 1);
    assert.equal(h.local.railWatchBookingWatch.passengers, undefined);
    assert.equal(h.local.railWatchBookingWatch.passenger, undefined);
    if (finalStatus === 'opened') {
      const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
      assert.deepEqual(
        (await h.call({ type: 'rail-watch-passenger', bookingId: handoff.bookingId }, bookingUrl))
          .passengers,
        [passenger],
      );
    }
  }
});

test('startup removes historical private snapshots from terminal watches and preserves saved profiles', async () => {
  for (const status of ['cancelled', 'opened', 'error']) {
    const h = service({
      saved: {
        railWatchBookingWatch: { ...target, status },
        railWatchPassengers: [passenger],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.local.railWatchBookingWatch.status, status);
    assert.equal(h.local.railWatchBookingWatch.passengers, undefined);
    assert.equal(h.local.railWatchBookingWatch.seatCount, 1);
    assert.deepEqual(h.local.railWatchPassengers, [passenger]);
  }
});

test('watch setup rejects impossible outbound dates', async () => {
  const h = service();
  assert.match(
    (await h.call({ type: 'rail-watch-arm', watch: { ...target, date: '31/02/2027' } })).error,
    /date/,
  );
  assert.equal(h.local.railWatchBookingWatch, undefined);
});

test('watch picks the first feasible chosen alternative and persists its concrete selection before opening', async () => {
  const fallback = { train: '38', coachId: '456|2|4|5', coachLabel: 'Fallback sleeper' };
  let opening;
  const h = service({
    onCreate() {
      opening = structuredClone(h.local.railWatchBookingWatch);
    },
  });
  const { watch } = await h.call({
    type: 'rail-watch-arm',
    watch: { ...target, alternatives: [outboundChoice, fallback] },
  });
  const result = h.result(watch.id);
  result.checks[0].rows[0].coaches[0].count = 0;
  result.checks[0].rows.push({
    date: target.date,
    train: fallback.train,
    checkedAt: new Date(now).toISOString(),
    coaches: [{ id: fallback.coachId, count: 1 }],
  });
  await h.call(result);
  assert.equal(opening.status, 'opening');
  assert.deepEqual(opening.selected, fallback);
  assert.deepEqual(h.local.railWatchBookingWatch.selected, fallback);
  assert.equal(h.local.railWatchBookingWatch.passengers, undefined);
  const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
  assert.equal(handoff.trainNo, '38');
  assert.equal(handoff.coachId, '456|2|4|5');
  assert.equal(handoff.alternatives, undefined);
  assert.equal(h.urls[0].includes('Fallback sleeper'), false);
  const record = h.session['railWatchBookingPassenger_' + handoff.bookingId];
  assert.deepEqual(record, { passengers: [passenger], expires: now + 120000, tabId: 1 });
});

test('watch preference order wins over result order and excludes unchosen coaches and split group counts', async () => {
  const second = { train: '38', coachId: '456|2|4|5', coachLabel: 'Second choice' };
  const h = service();
  const { watch } = await h.call({
    type: 'rail-watch-arm',
    watch: {
      ...target,
      alternatives: [outboundChoice, second],
      passengers: [{ mode: 'account' }, passenger],
    },
  });
  const result = h.result(watch.id);
  result.checks[0].rows[0].coaches = [
    { id: outboundChoice.coachId, count: 1 },
    { id: '999|1|4|5', count: 20 },
  ];
  result.checks[0].rows.unshift({
    date: target.date,
    train: second.train,
    checkedAt: new Date(now).toISOString(),
    coaches: [{ id: second.coachId, count: 1 }],
  });
  await h.call(result);
  assert.equal(h.local.railWatchBookingWatch.status, 'armed');
  assert.equal(h.urls.length, 0);
  result.checks[0].rows[0].coaches[0].count = 2;
  result.checks[0].rows[1].coaches[0].count = 2;
  await h.call(result);
  assert.deepEqual(h.local.railWatchBookingWatch.selected, outboundChoice);
  assert.equal(h.urls.length, 1);
});

test('round-trip alternatives choose the first feasible pair and never reuse an earlier leg bundle', async () => {
  const fallbackOut = { train: '38', coachId: '333|1|4|5', coachLabel: 'Fallback outbound' };
  const fallbackReturn = { train: '39', coachId: '444|1|4|5', coachLabel: 'Fallback return' };
  const h = service();
  const { watch } = await h.call({
    type: 'rail-watch-arm',
    watch: {
      ...target,
      alternatives: [outboundChoice, fallbackOut],
      returnLeg: { ...returnLeg, alternatives: [returnChoice, fallbackReturn] },
    },
  });
  await h.call(pairedResult(h, watch.id, 1, 0));
  await h.call(pairedResult(h, watch.id, 0, 1));
  const result = pairedResult(h, watch.id, 0, 0);
  for (const [index, choice] of [fallbackOut, fallbackReturn].entries())
    result.checks[index].rows.unshift({
      date: index === 0 ? target.date : returnLeg.date,
      train: choice.train,
      checkedAt: new Date(now).toISOString(),
      coaches: [{ id: choice.coachId, count: 1 }],
    });
  const stale = structuredClone(result);
  stale.checks[1].at = now - 1;
  await h.call(stale);
  assert.equal(h.local.railWatchBookingWatch.status, 'armed');
  assert.equal(h.urls.length, 0);
  result.checks[1].rows[1].coaches[0].count = 1;
  await h.call(result);
  assert.deepEqual(h.local.railWatchBookingWatch.selected, {
    ...fallbackOut,
    returnLeg: { date: returnLeg.date, ...returnChoice },
  });
  assert.equal(h.urls.length, 1);
});

test('watch choices reject duplicates, empty choices and legacy arm requests but allow one hundred exact unique choices', async () => {
  const h = service();
  const { alternatives, ...scope } = target;
  const invalidTargets = [
    { ...target, alternatives: [] },
    { ...target, alternatives: [outboundChoice, { ...outboundChoice, coachLabel: 'Same coach' }] },
    { ...scope, ...outboundChoice },
    { ...target, returnLeg: { ...returnLeg, alternatives: [returnChoice, returnChoice] } },
    {
      ...target,
      alternatives: Array.from({ length: 101 }, (_, i) => ({
        ...outboundChoice,
        train: String(i),
      })),
    },
  ];
  for (const watch of invalidTargets)
    assert.match((await h.call({ type: 'rail-watch-arm', watch })).error, /train and coach/);
  const choices = Array.from({ length: 100 }, (_, i) => ({ ...outboundChoice, train: String(i) }));
  const reply = await h.call({
    type: 'rail-watch-arm',
    watch: { ...target, alternatives: choices },
  });
  assert.equal(reply.watch.status, 'armed');
  assert.equal(reply.watch.alternatives.length, 100);
  assert.equal(alternatives.length, 1);
});

test('legacy persisted watches upgrade every leg without losing identity and terminal watches strip private passengers', async () => {
  for (const status of ['armed', 'opening', 'opened', 'cancelled', 'error']) {
    const legacy = {
      origin: target.origin,
      destination: target.destination,
      date: target.date,
      ...outboundChoice,
      returnLeg: { date: returnLeg.date, ...returnChoice },
      passenger,
      id: 'legacy-id',
      armedAt: now,
      status,
    };
    const h = service({ saved: { railWatchBookingWatch: legacy } });
    await new Promise((resolve) => setImmediate(resolve));
    const upgraded = h.local.railWatchBookingWatch;
    assert.equal(upgraded.id, 'legacy-id');
    assert.equal(upgraded.armedAt, now);
    assert.equal(upgraded.status, status);
    assert.deepEqual(upgraded.alternatives, [outboundChoice]);
    assert.deepEqual(upgraded.returnLeg, returnLeg);
    assert.equal(upgraded.train, undefined);
    assert.equal(upgraded.coachId, undefined);
    assert.equal(upgraded.coachLabel, undefined);
    if (['armed', 'opening'].includes(status)) assert.deepEqual(upgraded.passengers, [passenger]);
    else {
      assert.equal(upgraded.seatCount, 1);
      assert.equal(upgraded.passengers, undefined);
      assert.equal(upgraded.passenger, undefined);
    }
  }
});

test('manual Book now resolves fresh exact choices while watched booking requires automatic passengers', () => {
  const h = service();
  const manual = { ...target, passengers: [{ mode: 'manual' }] };
  assert.match(h.rules.validate(manual), /automatic/);
  assert.equal(h.rules.validate(manual, false), '');
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.rules.resolve(manual, h.result('manual').checks, 0, now))),
    outboundChoice,
  );
  const future = h.result('future').checks;
  future[0].rows[0].checkedAt = new Date(now + 1).toISOString();
  assert.equal(h.rules.resolve(manual, future, 0, now), null);
  assert.equal(h.rules.resolve(manual, h.result('malformed'), 0, now), null);
});

test('a disappeared train does not stop a watch from checking another selected train', async () => {
  const h = service();
  const fallback = { train: '172', coachId: '456|2|4|5', coachLabel: 'Later train' };
  const calls = [];
  const app = await dashboard({
    saved: {
      railWatch: {
        schema: 2,
        route: {
          origin: { id: '341', name: 'Hat Yai' },
          destination: { id: '1679', name: 'Bangkok' },
        },
        from: '2026-10-21',
        through: '2026-10-21',
        data: [outboundChoice, fallback].map((choice, index) => ({
          date: target.date,
          train: choice.train,
          departure: index ? '19:00' : '18:00',
          arrival: '10:00',
          coaches: [
            { id: choice.coachId, desc: choice.coachLabel, class: '3', count: 1, prices: [] },
          ],
        })),
      },
    },
    responses(endpoint, params) {
      calls.push({ endpoint, params });
      if (endpoint === 'getTrip') return [{ tripId: 'later', trainNo: '172' }];
      return {
        results: [
          {
            coachId: '456',
            coachNo: '2',
            coachLayoutId: '4',
            coachTypeId: '5',
            coachDesc: 'Later train',
            coachClass: '3',
            availableSeatCount: 1,
            coachSeats: [],
          },
        ],
      };
    },
    handleMessage: async (message, storage) => {
      const reply = await h.call(message);
      if (reply.watch) await storage.set({ railWatchBookingWatch: reply.watch });
      return reply;
    },
  });
  await selectWatchChoice(app, 'outbound', outboundChoice);
  await selectWatchChoice(app, 'outbound', fallback);
  await app.elements.armWatch.onclick();
  assert.equal(h.urls.length, 1);
  const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
  assert.equal(handoff.trainNo, '172');
  assert.equal(handoff.coachId, '456|2|4|5');
  assert.deepEqual(
    calls.filter((call) => call.endpoint === 'getTrainCoach').map((call) => call.params.tripId),
    ['later'],
  );
  assert.equal(app.memory.railWatchBookingWatch.status, 'opened');
});

test('one-way watch matches a later departure date, opens once and uses that date in the booking', async () => {
  const h = service();
  const { watch } = await h.call({
    type: 'rail-watch-arm',
    watch: { ...target, dates: [target.date, '22/10/2026'] },
  });
  const result = h.result(watch.id);
  result.checks[0].config.dates.push('22/10/2026');
  result.checks[0].rows[0].coaches[0].count = 0;
  await h.call(result);
  assert.equal(h.urls.length, 0);
  result.checks[0].rows.push({
    ...result.checks[0].rows[0],
    date: '22/10/2026',
    coaches: [{ id: outboundChoice.coachId, count: 1 }],
  });
  await h.call(result);
  await h.call(result);
  assert.equal(h.urls.length, 1);
  const handoff = JSON.parse(decodeURIComponent(h.urls[0].split('#rail-watch-search=')[1]));
  assert.equal(handoff.dateStart, '22/10/2026');
  assert.equal(h.local.railWatchBookingWatch.selected.date, '22/10/2026');
  assert.equal(h.local.railWatchBookingWatch.passengers, undefined);
});

test('multiple departure dates prefer earliest fresh match and reject malformed date selections', () => {
  const h = service();
  const watched = { ...target, dates: [target.date, '22/10/2026'] };
  const check = h.result('test').checks[0];
  check.config.dates = watched.dates;
  check.rows.push({ ...check.rows[0], date: '22/10/2026' });
  check.rows.reverse();
  assert.equal(h.rules.resolve(watched, [check], now, now).date, target.date);
  check.rows[1].checkedAt = new Date(now - 61000).toISOString();
  assert.equal(h.rules.resolve(watched, [check], now - 100000, now).date, '22/10/2026');
  check.config.dates = ['22/10/2026'];
  assert.equal(h.rules.resolve(watched, [check], now, now), null);
  for (const dates of [
    [],
    [target.date, target.date],
    ['22/10/2026', target.date],
    [target.date, '32/10/2026'],
    Array(32).fill(target.date),
  ])
    assert.ok(h.rules.validate({ ...target, dates }));
  assert.ok(
    h.rules.validate({
      ...watched,
      returnLeg: { date: '23/10/2026', alternatives: target.alternatives },
    }),
  );
});

test('round-trip watches reject multiple return dates before opening a booking', async () => {
  const h = service();
  const result = await h.call({
    type: 'rail-watch-arm',
    watch: {
      ...target,
      returnLeg: {
        date: '22/10/2026',
        dates: ['22/10/2026', '23/10/2026'],
        alternatives: target.alternatives,
      },
    },
  });
  assert.match(result.error, /single return date/);
  assert.equal(h.urls.length, 0);
});
