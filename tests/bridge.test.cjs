const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(response, hash = '', baseURI = 'https://dticket.railway.co.th/DTicketPublicWeb/') {
  const listeners = {},
    replies = [],
    forms = [],
    tabs = [];
  const document = {
    baseURI,
    body: { append: () => {} },
    addEventListener: (name, fn) => (listeners[name] = fn),
    dispatchEvent: (event) => replies.push(JSON.parse(event.detail)),
    createElement: (tag) =>
      tag === 'form'
        ? {
            append(input) {
              (this.inputs ||= []).push(input);
            },
            submit() {
              forms.push(this);
            },
            remove() {},
          }
        : {},
  };
  const window = {
    SmartUtil: { hiddenParams: { viewStateHolder: 'private-state' } },
    jQuery: () => ({ serializeArray: () => [] }),
    open: () => {
      const tab = {
        document: { body: {} },
        closed: false,
        close() {
          this.closed = true;
        },
      };
      tabs.push(tab);
      return tab;
    },
  };
  let fetchOptions, fetchURL;
  const context = {
    window,
    document,
    location: { hash, pathname: '/', search: '' },
    history: { replaceState() {} },
    crypto: { randomUUID: () => 'test-id' },
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    URL,
    URLSearchParams,
    AbortController,
    fetch: async (url, options) => {
      fetchURL = String(url);
      fetchOptions = options;
      return response;
    },
    Date,
  };
  vm.runInNewContext(fs.readFileSync('extension/booking.js', 'utf8'), context);
  vm.runInNewContext(fs.readFileSync('extension/bridge.js', 'utf8'), context);
  const send = async (endpoint, params = {}) => {
    listeners['rail-watch-request']({
      detail: JSON.stringify({ id: 'request', endpoint, params }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    return replies.at(-1);
  };
  return {
    send,
    forms,
    tabs,
    window,
    options: () => fetchOptions,
    url: () => fetchURL,
    async sendRaw(detail) {
      listeners['rail-watch-request']({ detail });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
test('bridge preserves HTTP 429 and Retry-After without exposing private state', async () => {
  const h = setup({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '900' }) });
  const before = Date.now();
  const reply = await h.send('getStation', { LineId: '' });
  assert.equal(reply.httpStatus, 429);
  assert.ok(reply.retryAt >= before + 900000);
  assert.equal(JSON.stringify(reply).includes('private-state'), false);
  assert.equal(h.options().body.get('viewStateHolder'), 'private-state');
});
test('successful response refreshes page view state but sends only availability to extension', async () => {
  const h = setup({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ errorCode: 'S_SUCCESS', data: [], viewStateHolder: 'new-private-state' }),
  });
  const reply = await h.send('getStation', { LineId: '' });
  assert.equal(h.window.SmartUtil.hiddenParams.viewStateHolder, 'new-private-state');
  assert.equal(JSON.stringify(reply).includes('new-private-state'), false);
});
test('new-tab handoff submits a native route/date POST without reserving seats', () => {
  const search = {
    provinceStartId: '341',
    provinceEndId: '1679',
    dateStart: '20/10/2026',
    trainNo: '38',
    expires: Date.now() + 120000,
  };
  const h = setup(null, '#rail-watch-search=' + encodeURIComponent(JSON.stringify(search)));
  assert.equal(h.forms.length, 1);
  assert.equal(h.forms[0].method, 'POST');
  assert.equal(h.forms[0].inputs.find((input) => input.name === 'date-start').value, '20/10/2026');
  const target = JSON.parse(decodeURIComponent(h.forms[0].action.split('#rail-watch=')[1]));
  assert.equal(target.trainNo, '38');
  const expired = setup(
    null,
    '#rail-watch-search=' + encodeURIComponent(JSON.stringify({ ...search, expires: 0 })),
  );
  assert.equal(expired.forms.length, 0);
});
test('background opens a new booking tab after verification without popup APIs', async () => {
  let listener, destination, reply;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: {
      onMessage: {
        addListener: (fn) => {
          if (!listener) listener = fn;
        },
      },
    },
    notifications: { onClicked: { addListener() {} } },
    storage: {
      session: {
        async get() {
          return {};
        },
      },
    },
    alarms: { onAlarm: { addListener() {} } },
    tabs: {
      onRemoved: { addListener() {} },
      create: async (options) => (destination = options.url),
    },
  };
  vm.runInNewContext(fs.readFileSync('extension/background.js', 'utf8'), {
    chrome,
    Date,
    importScripts() {},
    RailWatchBooking: { day: (date) => /^\d{2}\/\d{2}\/\d{4}$/.test(date) },
  });
  const params = {
    provinceStartId: '341',
    provinceEndId: '1679',
    dateStart: '20/10/2026',
    trainNo: '38',
  };
  const keepAlive = listener(
    { type: 'rail-watch-booking', params },
    { url: 'https://dticket.railway.co.th/DTicketPublicWeb/home/Home', tab: { id: 1 } },
    (result) => (reply = result),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keepAlive, true);
  assert.equal(reply.ok, true);
  assert.ok(
    destination.startsWith(
      'https://dticket.railway.co.th/DTicketPublicWeb/home/Home#rail-watch-search=',
    ),
  );
  const handoff = JSON.parse(decodeURIComponent(destination.split('#rail-watch-search=')[1]));
  assert.equal(handoff.trainNo, '38');
});
function bookingHandoff({
  count = 1,
  disabled = false,
  blocked = false,
  buttonPresent = true,
  delayed = false,
  targetChanges = {},
  sessionChanges = {},
} = {}) {
  const target = {
    provinceStartId: '341',
    provinceEndId: '1679',
    dateStart: '18/10/2026',
    trainNo: '38',
    coachId: '117|3|4|5',
    expires: Date.now() + 120000,
  };
  Object.assign(target, targetChanges);
  const clicks = [],
    chosen = [],
    timers = [],
    started = [];
  const cards = Array.from({ length: 4 }, (_, index) => ({
    style: {},
    setAttribute(name, value) {
      this[name] = value;
    },
    scrollIntoView() {
      this.scrolled = true;
    },
    querySelector(selector) {
      assert.equal(selector, '.choose-bt[onclick^="chooseTrainCoach("]');
      return buttonPresent
        ? {
            disabled,
            closest: () => (blocked ? {} : null),
            click() {
              clicks.push(index);
            },
          }
        : null;
    },
  }));
  const coaches = [
    { coachId: 117, coachNo: 2, coachLayoutId: 4, coachTypeId: 5, availableSeatCount: 8 },
    { coachId: 120 },
    { coachId: 123, coachClass: '3', availableSeatCount: 10 },
    { coachId: 117, coachNo: 3, coachLayoutId: 4, coachTypeId: 5, availableSeatCount: count },
  ];
  const context = {
    location: {
      hash: '#rail-watch=' + encodeURIComponent(JSON.stringify(target)),
      pathname: '/DTicketPublicWeb/booking/booking',
      search: '',
    },
    history: { replaceState() {} },
    Date,
    sessionDataBooking: { ...target, ...sessionChanges },
    departureTrips: [{ trainNo: '32' }, { trainNo: '38' }],
    departureTrainCoachs: delayed ? [] : coaches,
    divTrainCoach: '#departureTrainCoachList',
    chooseTrip(index, departure) {
      chosen.push([index, departure]);
    },
    RailWatchBooking: { start: (target) => started.push(target) },
    document: {
      querySelector: () => ({ children: context.departureTrainCoachs.length ? cards : [] }),
      addEventListener() {},
    },
    setTimeout(fn) {
      timers.push(fn);
    },
  };
  vm.runInNewContext(fs.readFileSync('extension/bridge.js', 'utf8'), context);
  return { target, cards, clicks, chosen, timers, context, coaches, started };
}
test('booking handoff clicks the native button for the exact sleeper coach once', () => {
  const h = bookingHandoff();
  assert.deepEqual(h.chosen, [[1, true]]);
  assert.deepEqual(h.clicks, [3]);
  assert.equal(h.cards[3].scrolled, true);
  assert.equal(h.cards[3]['data-rail-watch-coach'], h.target.coachId);
  assert.equal(h.cards[0].scrolled, undefined);
  assert.equal(h.timers.length, 0);
});
test('autofill starts only after the exact available coach is selected', () => {
  const h = bookingHandoff({ targetChanges: { autoFill: true } });
  assert.deepEqual(h.clicks, [3]);
  assert.equal(h.started.length, 1);
  for (const options of [{ count: 0 }, { disabled: true }, { blocked: true }]) {
    const unavailable = bookingHandoff({ ...options, targetChanges: { autoFill: true } });
    assert.equal(unavailable.started.length, 0);
  }
  assert.equal(bookingHandoff().started.length, 0);
});
test('lower-berth preference survives native POST and booking autofill handoffs', () => {
  for (const preferLowerBerths of [undefined, true, false]) {
    const search = {
      provinceStartId: '341',
      provinceEndId: '1679',
      dateStart: '20/10/2026',
      trainNo: '38',
      preferLowerBerths,
      expires: Date.now() + 120000,
    };
    const posted = setup(null, '#rail-watch-search=' + encodeURIComponent(JSON.stringify(search)));
    assert.equal(posted.forms.length, 1);
    const target = JSON.parse(decodeURIComponent(posted.forms[0].action.split('#rail-watch=')[1]));
    assert.equal(target.preferLowerBerths, preferLowerBerths);
    const booked = bookingHandoff({ targetChanges: { autoFill: true, preferLowerBerths } });
    assert.equal(booked.started.length, 1);
    assert.equal(booked.started[0].preferLowerBerths, preferLowerBerths);
  }
});
test('invalid lower-berth preferences prevent native POST and automatic booking selection', () => {
  for (const preferLowerBerths of ['false', null, 0, {}, []]) {
    const search = {
      provinceStartId: '341',
      provinceEndId: '1679',
      dateStart: '20/10/2026',
      trainNo: '38',
      preferLowerBerths,
      expires: Date.now() + 120000,
    };
    const posted = setup(null, '#rail-watch-search=' + encodeURIComponent(JSON.stringify(search)));
    assert.equal(posted.forms.length, 0);
    const booked = bookingHandoff({ targetChanges: { autoFill: true, preferLowerBerths } });
    assert.deepEqual(booked.chosen, []);
    assert.deepEqual(booked.clicks, []);
    assert.deepEqual(booked.started, []);
  }
});
test('handoff waits for asynchronous coach loading before selecting', () => {
  const h = bookingHandoff({ delayed: true });
  assert.deepEqual(h.clicks, []);
  assert.equal(h.timers.length, 1);
  h.context.departureTrainCoachs = h.coaches;
  h.timers.shift()();
  assert.deepEqual(h.clicks, [3]);
  assert.equal(h.timers.length, 0);
});
test('handoff leaves unavailable or disabled coaches for manual selection', () => {
  for (const options of [
    { count: 0 },
    { disabled: true },
    { blocked: true },
    { buttonPresent: false },
  ]) {
    const h = bookingHandoff(options);
    assert.equal(h.cards[3].scrolled, true);
    assert.deepEqual(h.clicks, []);
  }
});
test('handoff never substitutes another coach and stops waiting at its deadline', () => {
  let now = Date.now();
  const h = bookingHandoff({ targetChanges: { coachId: '999|3|4|5', expires: now + 1000 } });
  assert.deepEqual(h.clicks, []);
  assert.equal(h.timers.length, 1);
  h.context.Date = { now: () => now + 2000 };
  h.timers.shift()();
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.clicks, []);
});
test('handoff ignores expired links and mismatched routes or trains', () => {
  for (const options of [
    { targetChanges: { expires: 0 } },
    { targetChanges: { expires: 'invalid' } },
    { targetChanges: { trainNo: '99' } },
    { sessionChanges: { provinceStartId: '999' } },
    { sessionChanges: { dateStart: '19/10/2026' } },
  ]) {
    const h = bookingHandoff(options);
    assert.deepEqual(h.chosen, []);
    assert.deepEqual(h.clicks, []);
    assert.equal(h.timers.length, 0);
  }
});

test('group handoff submits the native passenger count and never chooses a coach with too few seats', () => {
  const search = {
    provinceStartId: '341',
    provinceEndId: '1679',
    dateStart: '20/10/2026',
    trainNo: '38',
    seatCount: 3,
    expires: Date.now() + 120000,
  };
  const posted = setup(null, '#rail-watch-search=' + encodeURIComponent(JSON.stringify(search)));
  assert.equal(posted.forms[0].inputs.find((input) => input.name === 'seatperson').value, '3');
  const insufficient = bookingHandoff({
    count: 2,
    targetChanges: { seatCount: 3, autoFill: true },
  });
  assert.deepEqual(insufficient.clicks, []);
  const sufficient = bookingHandoff({ count: 3, targetChanges: { seatCount: 3, autoFill: true } });
  assert.deepEqual(sufficient.clicks, [3]);
  const invalid = setup(
    null,
    '#rail-watch-search=' + encodeURIComponent(JSON.stringify({ ...search, seatCount: 5 })),
  );
  assert.equal(invalid.forms.length, 0);
});

function roundTripHandoff({ returnCount = 2, returnTrain = '37', dateEnd = '25/10/2026' } = {}) {
  const actions = [],
    timers = [];
  const target = {
    provinceStartId: '341',
    provinceEndId: '1679',
    dateStart: '21/10/2026',
    trainNo: '38',
    coachId: '117|3|4|5',
    returnLeg: { date: '25/10/2026', train: '37', coachId: '456|2|4|5' },
    seatCount: 2,
    autoFill: true,
    expires: Date.now() + 120000,
  };
  const context = {
    Date,
    window: { jQuery: { active: 0 } },
    step: '10',
    location: {
      hash: '#rail-watch=' + encodeURIComponent(JSON.stringify(target)),
      pathname: '/DTicketPublicWeb/booking/booking',
      search: '',
    },
    history: { replaceState() {} },
    sessionDataBooking: { ...target, tripType: '2', dateEnd },
    departureTrips: [{ trainNo: '38' }],
    arrivalTrips: [],
    departureTrainCoachs: [],
    arrivalTrainCoachs: [],
    divTrainCoach: '#departureTrainCoachList',
    chooseTrip(index, departure) {
      actions.push(['train', departure, index]);
      if (departure) {
        context.step = '11';
        context.arrivalTrips = [{ trainNo: returnTrain }];
      } else {
        context.step = '20';
        context.departureTrainCoachs = [
          { coachId: 117, coachNo: 3, coachLayoutId: 4, coachTypeId: 5, availableSeatCount: 2 },
        ];
      }
    },
    setTimeout: (fn) => timers.push(fn),
    document: {
      addEventListener() {},
      querySelector(selector) {
        const departure = selector === '#departureTrainCoachList';
        return {
          children: [
            {
              style: {},
              setAttribute() {},
              scrollIntoView() {},
              querySelector() {
                return {
                  disabled: false,
                  closest: () => null,
                  click() {
                    actions.push(['coach', departure]);
                    if (departure) {
                      context.step = '21';
                      context.divTrainCoach = '#arrivalTrainCoachList';
                      context.arrivalTrainCoachs = [
                        {
                          coachId: 456,
                          coachNo: 2,
                          coachLayoutId: 4,
                          coachTypeId: 5,
                          availableSeatCount: returnCount,
                        },
                      ];
                    }
                  },
                };
              },
            },
          ],
        };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync('extension/booking.js', 'utf8'), context);
  context.RailWatchBooking.start = () => actions.push(['autofill']);
  vm.runInNewContext(fs.readFileSync('extension/bridge.js', 'utf8'), context);
  return { actions, timers, context };
}
test('round-trip POST includes both dates and native handoff selects both trains before both coaches', () => {
  const search = {
    provinceStartId: '341',
    provinceEndId: '1679',
    dateStart: '21/10/2026',
    trainNo: '38',
    returnLeg: { date: '25/10/2026', train: '37', coachId: '456|2|4|5' },
    seatCount: 2,
    expires: Date.now() + 120000,
  };
  const h = setup(null, '#rail-watch-search=' + encodeURIComponent(JSON.stringify(search)));
  const fields = Object.fromEntries(h.forms[0].inputs.map((input) => [input.name, input.value]));
  assert.equal(fields.tripType, '2');
  assert.equal(fields['date-end'], '25/10/2026');
  assert.equal(fields.seatperson, '2');
  assert.deepEqual(roundTripHandoff().actions, [
    ['train', true, 0],
    ['train', false, 0],
    ['coach', true],
    ['coach', false],
    ['autofill'],
  ]);
  assert.deepEqual(roundTripHandoff({ returnCount: 1 }).actions, [
    ['train', true, 0],
    ['train', false, 0],
    ['coach', true],
  ]);
  assert.deepEqual(roundTripHandoff({ returnTrain: '45' }).actions, [['train', true, 0]]);
  assert.deepEqual(roundTripHandoff({ dateEnd: '26/10/2026' }).actions, []);
  const invalid = setup(
    null,
    '#rail-watch-search=' +
      encodeURIComponent(
        JSON.stringify({ ...search, returnLeg: { ...search.returnLeg, date: '20/10/2026' } }),
      ),
  );
  assert.equal(invalid.forms.length, 0);
});

test('bridge ignores malformed and inherited endpoints but still serves approved station requests', async () => {
  const h = setup({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ errorCode: 'S_SUCCESS', data: [] }),
  });
  for (const detail of [
    'null',
    '[]',
    '{',
    JSON.stringify({ id: 'request', endpoint: 'constructor' }),
    JSON.stringify({ id: 'request', endpoint: '__proto__' }),
  ]) {
    await h.sendRaw(detail);
  }
  assert.equal(h.options(), undefined);
  assert.deepEqual((await h.send('getStation', { LineId: '' })).result, {
    errorCode: 'S_SUCCESS',
    data: [],
  });
});

test('bridge sends private form state only to the railway origin even with a foreign page base', async () => {
  const h = setup(
    {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ errorCode: 'S_SUCCESS', data: [] }),
    },
    '',
    'https://example.invalid/',
  );
  await h.send('getStation', { LineId: '' });
  assert.equal(h.url(), 'https://dticket.railway.co.th/DTicketPublicWeb/home/Home/getStation');
  assert.equal(h.options().body.get('viewStateHolder'), 'private-state');
});
