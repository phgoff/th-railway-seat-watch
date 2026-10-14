const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { dashboard } = require('./dashboard-harness.cjs');
const source = fs.readFileSync('extension/booking.js', 'utf8');
const passenger = {
  mode: 'custom',
  firstName: 'Test',
  lastName: 'Passenger',
  gender: 'F',
  foreignerFlag: 'Y',
  idCard: 'AA123456',
  mobileNo: '0812345678',
  email: '',
};
function flow({
  profile = { mode: 'account' },
  captcha = false,
  count = '1',
  seatCount = 1,
  profiles,
  changes = {},
  targetChanges = {},
  roundTrip = false,
} = {}) {
  profiles ||= [profile];
  let now = 1000,
    page = 'gender',
    requests = 0;
  const listeners = {},
    timers = [],
    clicks = [],
    fills = [];
  const target = {
    provinceStartId: '341',
    provinceEndId: '1679',
    dateStart: '21/10/2026',
    trainNo: '170',
    coachId: '123|24|4|5',
    seatCount,
    expires: 121000,
    ...targetChanges,
  };
  if (roundTrip) target.returnLeg = { date: '25/10/2026', train: '37', coachId: '456|2|4|5' };
  const account = { ...passenger, firstName: 'Account', gender: 'M', memberId: 'member' };
  const state = {
    ...target,
    tripType: '1',
    seatPerson: count,
    memberInfo: account,
    personal: [account],
    train: {
      trip: [
        { trainNo: '170', coachId: '123', coachNo: '24', coachLayoutId: '4', coachTypeId: '5' },
      ],
    },
    ...changes,
  };
  if (roundTrip) {
    state.tripType = '2';
    state.dateEnd = target.returnLeg.date;
    state.train.trip.push({
      trainNo: '37',
      coachId: '456',
      coachNo: '2',
      coachLayoutId: '4',
      coachTypeId: '5',
    });
  }
  const context = {
    step: '40',
    sessionDataBooking: state,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    window: { jQuery: { active: 0 } },
    setTimeout: (fn) => timers.push(fn),
    CustomEvent: class {
      constructor(type, { detail }) {
        this.type = type;
        this.detail = detail;
      }
    },
    document: {
      addEventListener: (name, fn) => (listeners[name] = fn),
      removeEventListener: (name) => delete listeners[name],
      dispatchEvent(event) {
        if (event.type === 'rail-watch-passenger-request') {
          requests++;
          listeners['rail-watch-passenger-response']?.({
            detail: JSON.stringify({ id: target.expires, passengers: profiles }),
          });
        }
      },
      querySelector(selector) {
        return elements[selector] || null;
      },
    },
    RecaptchaHelper: { isAutoSeatEnabled: () => captcha, getResponse: () => context.solved },
    handleNextButtonClicked() {},
    clearDataMember: () => fills.push('clear'),
    setDataMember: (person) => fills.push(JSON.parse(JSON.stringify(person))),
  };
  function section(name, onclick) {
    return {
      getClientRects: () => (page === name ? [{}] : []),
      querySelector: () => ({
        disabled: false,
        classList: { contains: () => false },
        click() {
          clicks.push(onclick);
          if (name === 'gender') {
            page = 'seat';
            context.window.jQuery.active = 1;
          } else if (roundTrip && context.step === '40') {
            context.step = '41';
            context.window.jQuery.active = 1;
          } else {
            page = 'info';
            context.window.jQuery.active = 1;
          }
        },
      }),
    };
  }
  const elements = {
    '#step-person-booking-gender': section('gender', 'gender-next'),
    '#step-seat-departure': section('seat', 'seat-next'),
    '#step-infomation': section('info'),
    '#pdg_chkReservationId': {
      checked: true,
      click() {
        this.checked = !this.checked;
      },
    },
    '#pdg_fGenderM1': {},
    '#pdg_fGenderF1': {},
    'input[name="pdg_Gender1"]': {},
    'input[name="data-seat-user-1"]': { value: '21' },
  };
  for (let index = 2; index <= Number(count); index++) {
    elements['#pdg_fGenderM' + index] = {};
    elements['#pdg_fGenderF' + index] = {};
    elements['input[name="pdg_Gender' + index + '"]'] = {};
    elements['input[name="data-seat-user-' + index + '"]'] = { value: String(20 + index) };
  }
  vm.runInNewContext(source, context);
  context.RailWatchBooking.start(target);
  return {
    context,
    elements,
    clicks,
    fills,
    state,
    timers,
    requests: () => requests,
    tick() {
      assert.ok(timers.length);
      timers.shift()();
    },
    page(name) {
      page = name;
    },
    expire() {
      now = 122000;
    },
    stopped: () => !listeners['rail-watch-passenger-response'],
  };
}
test('account handoff clicks each Next once, waits for loading, fills the native form and stops', () => {
  const h = flow();
  h.tick();
  assert.deepEqual(h.clicks, ['gender-next']);
  h.tick();
  assert.deepEqual(h.clicks, ['gender-next']);
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.deepEqual(h.clicks, ['gender-next', 'seat-next']);
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.equal(h.fills[1].firstName, 'Account');
  assert.equal(h.fills[1].memberId, 'member');
  assert.equal(h.stopped(), true);
  assert.equal(h.timers.length, 0);
});
test('another passenger uses their gender before assignment and their own details in the form', () => {
  const h = flow({ profile: passenger });
  h.tick();
  assert.equal(h.elements['#pdg_chkReservationId'].checked, false);
  assert.equal(h.elements['input[name="pdg_Gender1"]'].value, 'F');
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.equal(h.state.personal[0].firstName, 'Test');
  assert.equal(h.state.personal[0].memberId, undefined);
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.equal(h.fills[1].idCard, 'AA123456');
  assert.equal(h.fills[1].foreignerFlag, 'Y');
  assert.equal(h.stopped(), true);
});
test('CAPTCHA waits for a real response and no assigned seat means no Next click', () => {
  const h = flow({ captcha: true });
  h.tick();
  assert.deepEqual(h.clicks, []);
  h.context.solved = 'human-completed';
  h.tick();
  assert.deepEqual(h.clicks, ['gender-next']);
  h.context.window.jQuery.active = 0;
  h.elements['input[name="data-seat-user-1"]'].value = '';
  h.tick();
  assert.deepEqual(h.clicks, ['gender-next']);
  h.expire();
  h.tick();
  assert.equal(h.stopped(), true);
});
test('manual mode, multiple passengers and changed train or route never advance', () => {
  for (const options of [
    { profile: { mode: 'manual' } },
    { count: '2' },
    { changes: { provinceStartId: '999' } },
    { changes: { train: { trip: [{ trainNo: '99' }] } } },
  ]) {
    const h = flow(options);
    if (h.timers.length) h.tick();
    assert.deepEqual(h.clicks, []);
    assert.deepEqual(h.fills, []);
    assert.equal(h.stopped(), true);
  }
});
test('passenger validation rejects missing details, malformed IDs, phone and email', () => {
  const context = {};
  vm.runInNewContext(source, context);
  const validate = context.RailWatchBooking.validate;
  assert.equal(validate(passenger), '');
  assert.equal(validate({ mode: 'account' }), '');
  assert.equal(validate({ ...passenger, foreignerFlag: 'N', idCard: '1101700203450' }), '');
  for (const changes of [
    { firstName: '' },
    { gender: 'X' },
    { foreignerFlag: 'X' },
    { idCard: '123' },
    { foreignerFlag: 'N', idCard: '1101700203451' },
    { mobileNo: '123' },
    { email: 'invalid' },
  ])
    assert.ok(validate({ ...passenger, ...changes }));
});
test('passenger picker saves and restores a custom passenger and manual mode', async () => {
  const h = await dashboard({ saved: { railWatchPassenger: passenger } });
  assert.equal(h.elements.passengerMode.value, 'custom');
  assert.equal(h.elements.passengerFields.hidden, false);
  assert.equal(h.elements.passengerFirstName.value, 'Test');
  h.elements.passengerFirstName.value = 'Changed';
  h.elements.passengerFirstName.emit('change');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.memory.railWatchPassengers[0].firstName, 'Changed');
  h.elements.passengerMode.value = 'manual';
  h.elements.passengerMode.emit('change');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.elements.passengerFields.hidden, true);
  assert.deepEqual(h.memory.railWatchPassengers, [{ mode: 'manual' }]);
  const reloaded = await dashboard({ saved: h.memory });
  assert.equal(reloaded.elements.passengerMode.value, 'manual');
});
test('coach click rechecks the one seat and sends the chosen passenger separately from the destination', async () => {
  for (const [mode, count] of [
    ['custom', 1],
    ['manual', 1],
    ['account', 0],
  ]) {
    const profile = mode === 'custom' ? passenger : { mode };
    const app = await dashboard({
      saved: {
        railWatchPassenger: profile,
        railWatch: {
          schema: 2,
          route: {
            origin: { id: '341', name: 'Hat Yai' },
            destination: { id: '1679', name: 'Bangkok' },
          },
          from: '2026-10-21',
          through: '2026-10-21',
          data: [],
        },
      },
      responses: {
        getTrip: [{ tripId: 'trip', trainNo: '170' }],
        getTrainCoach: {
          results: [
            {
              coachId: '123',
              coachNo: '24',
              coachLayoutId: '4',
              coachTypeId: '5',
              coachClass: '3',
              availableSeatCount: count,
              coachSeats: [],
            },
          ],
        },
      },
    });
    app.elements.preferLowerBerths.checked = mode !== 'custom';
    const button = {
      disabled: false,
      dataset: {
        bookDate: '21/10/2026',
        bookTrain: '170',
        bookCoach: '123|24|4|5',
        bookClass: '3',
      },
      closest: (selector) => (selector === '[data-book-train]' ? button : null),
    };
    for (const fn of app.root.listeners.click) fn({ target: button });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(app.requests, ['getTrip', 'getTrainCoach']);
    if (count) {
      assert.deepEqual(JSON.parse(JSON.stringify(app.messages)), [
        {
          type: 'rail-watch-booking',
          passengers: [profile],
          params: {
            provinceStartId: '341',
            provinceEndId: '1679',
            dateStart: '21/10/2026',
            trainNo: '170',
            coachId: '123|24|4|5',
            autoFill: mode !== 'manual',
            seatCount: 1,
            preferLowerBerths: mode !== 'custom',
          },
        },
      ]);
      assert.equal(JSON.stringify(app.messages[0].params).includes('AA123456'), false);
    } else assert.deepEqual(app.messages, []);
  }
});
test('coach click refreshes the matrix and selected detail when another coach still has seats', async () => {
  for (const otherCount of [0, 3]) {
    const rows = [
      {
        date: '21/10/2026',
        train: '170',
        departure: '18:00',
        arrival: '06:00',
        coaches: [
          {
            id: '123|24|4|5',
            class: '3',
            type: 'Seating Coach',
            air: 'Air Coach',
            count: 8,
            prices: [],
          },
          {
            id: '456|25|4|5',
            class: '3',
            type: 'Seating Coach',
            air: 'Air Coach',
            count: otherCount,
            prices: [],
          },
        ],
      },
    ];
    const app = await dashboard({
      saved: {
        railWatchPassengers: [{ mode: 'account' }, passenger],
        railWatch: {
          schema: 2,
          route: {
            origin: { id: '341', name: 'Hat Yai' },
            destination: { id: '1679', name: 'Bangkok' },
          },
          from: '2026-10-21',
          through: '2026-10-21',
          filter: '3',
          data: rows,
          selected: ['21/10/2026', '170'],
        },
        railWatchShared: {
          key: JSON.stringify([2, '341', '1679', ['21/10/2026'], 'all']),
          at: Date.parse('2026-10-13T05:00:00Z'),
          rows,
        },
      },
      responses: {
        getTrip: [{ tripId: 'trip', trainNo: '170' }],
        getTrainCoach: {
          results: [
            {
              coachId: '123',
              coachNo: '24',
              coachLayoutId: '4',
              coachTypeId: '5',
              coachClass: '3',
              coachSeatTypeEn: 'Seating Coach',
              coachAirTypeEn: 'Air Coach',
              availableSeatCount: 0,
              coachSeats: [],
            },
            {
              coachId: '456',
              coachNo: '25',
              coachLayoutId: '4',
              coachTypeId: '5',
              coachClass: '3',
              coachSeatTypeEn: 'Seating Coach',
              coachAirTypeEn: 'Air Coach',
              availableSeatCount: otherCount,
              coachSeats: [],
            },
          ],
        },
      },
    });
    assert.equal(
      app.elements.matrix.innerHTML.includes(
        otherCount ? 'train 170 11 seats available' : 'train 170 8 seats available',
      ),
      true,
    );
    const button = {
      disabled: false,
      dataset: {
        bookDate: '21/10/2026',
        bookTrain: '170',
        bookCoach: '123|24|4|5',
        bookClass: '3',
      },
      closest: (selector) => (selector === '[data-book-train]' ? button : null),
    };
    for (const fn of app.root.listeners.click) fn({ target: button });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(app.requests, ['getTrip', 'getTrainCoach']);
    assert.deepEqual(app.messages, []);
    assert.equal(
      app.elements.statusText.textContent,
      'This coach has 0 seats. You need 2 for everyone.',
    );
    const matrixLabel = otherCount ? 'train 170 3 seats available' : 'train 170 fully booked';
    assert.equal(app.elements.matrix.innerHTML.includes(matrixLabel), true);
    assert.deepEqual(
      [...app.elements.detail.innerHTML.matchAll(/class="cnt mono [^"]*">(\d+)</g)].map((match) =>
        Number(match[1]),
      ),
      otherCount ? [3, 0] : [0, 0],
    );
    assert.equal(app.elements.detail.innerHTML.includes('data-book-coach="123|24|4|5"'), false);
    assert.deepEqual(
      app.memory.railWatch.data[0].coaches.map((coach) => coach.count),
      [0, otherCount],
    );
    const reloaded = await dashboard({ saved: app.memory });
    assert.equal(reloaded.elements.matrix.innerHTML.includes(matrixLabel), true);
    assert.deepEqual(
      [...reloaded.elements.detail.innerHTML.matchAll(/class="cnt mono [^"]*">(\d+)</g)].map(
        (match) => Number(match[1]),
      ),
      otherCount ? [3, 0] : [0, 0],
    );
  }
});
function berthMap({
  assignedSeat = '2',
  gender = 'M',
  candidates = [],
  refuse = false,
  charter = false,
  sameNumbers = false,
} = {}) {
  const clicks = [],
    assigned = { value: charter ? '1,2' : assignedSeat };
  let currentCar = 1;
  const buttons = [1, 2].map((car) => ({
    dataset: { slideTo: String(car - 1) },
    classList: { contains: (name) => name === 'active' && currentCar === car },
    click() {
      clicks.push('car-' + car);
      currentCar = car;
    },
  }));
  const make = ({ id, lower = false, car = 1, reserved = false, room = '-' }) => ({
    dataset: {
      seatId: id,
      bogeyNo: String(car),
      status: reserved ? 'reserved' : '',
      roomNo: room,
      seatTypeImg: 'assets/img/' + (lower ? 'icon-lowerbunk-black.png' : 'icon-upperbed-black.png'),
    },
    classList: { contains: (name) => name === 'empty' && !reserved },
    click() {
      clicks.push('seat-' + car + '-' + id);
      if (!reserved && currentCar === car && (!refuse || id === assignedSeat)) assigned.value = id;
    },
  });
  const original = make({ id: assignedSeat, lower: assignedSeat === '1' });
  const nodes = [original, ...candidates.map(make)];
  if (sameNumbers) nodes.push(make({ id: assignedSeat, car: 2 }));
  const seat = { querySelectorAll: () => nodes };
  const context = {
    document: {
      querySelectorAll: (selector) => (selector.includes('trainCoach') ? buttons : [assigned]),
    },
    removeDataByUserId() {
      clicks.push('remove');
      assigned.value = '';
    },
    IsGenderRoomSeat: () => gender,
    ladyRoomItems: [[], []],
    menRoomItems: [[], []],
    monkRoomItems: [[], []],
    bothMenAndLadyItems: [[], []],
  };
  vm.runInNewContext(source, context);
  return {
    assigned,
    seat,
    context,
    nodes,
    clicks,
    selectedCar: () => currentCar,
    prefer() {
      context.RailWatchBooking.preferLowerBerth(seat, assigned);
    },
  };
}
test('seat selection prefers a free lower berth over an assigned upper berth, using native seat controls', () => {
  const h = berthMap({
    candidates: [{ id: '3', lower: true }, { id: '4' }, { id: '5', lower: true }],
  });
  h.prefer();
  assert.equal(h.assigned.value, '3');
  assert.deepEqual(h.clicks, ['remove', 'seat-1-3']);
  h.prefer();
  assert.deepEqual(h.clicks, ['remove', 'seat-1-3']);
});
test('lower preference keeps an assigned lower berth, a lone upper berth and a whole-room selection', () => {
  for (const options of [
    { assignedSeat: '1', candidates: [{ id: '3', lower: true }] },
    {},
    { candidates: [{ id: '1', lower: true, reserved: true }] },
    { charter: true, candidates: [{ id: '3', lower: true }] },
  ]) {
    const h = berthMap(options);
    const before = h.assigned.value;
    h.prefer();
    assert.equal(h.assigned.value, before);
    assert.deepEqual(h.clicks, []);
  }
});
test('lower preference excludes reserved berths and cabins blocked for the selected passenger gender', () => {
  const h = berthMap({
    candidates: [
      { id: '1', lower: true, reserved: true },
      { id: '3', lower: true, room: 'female-room' },
      { id: '5', lower: true, room: 'mixed-room' },
      { id: '7', lower: true, room: 'open-room' },
    ],
  });
  h.context.ladyRoomItems[0] = ['female-room'];
  h.context.bothMenAndLadyItems[0] = ['mixed-room'];
  h.prefer();
  assert.equal(h.assigned.value, '7');
  const female = berthMap({
    gender: 'F',
    candidates: [
      { id: '3', lower: true, room: 'male-room' },
      { id: '5', lower: true, room: 'monk-room' },
      { id: '7', lower: true },
    ],
  });
  female.context.menRoomItems[0] = ['male-room'];
  female.context.monkRoomItems[0] = ['monk-room'];
  female.prefer();
  assert.equal(female.assigned.value, '7');
});
test('lower preference uses the current car first and switches cars only when a lower berth is there', () => {
  const h = berthMap({
    candidates: [
      { id: '3', lower: true, car: 2 },
      { id: '5', lower: true },
    ],
  });
  h.prefer();
  assert.equal(h.assigned.value, '5');
  assert.equal(h.selectedCar(), 1);
  const other = berthMap({ sameNumbers: true, candidates: [{ id: '3', lower: true, car: 2 }] });
  other.prefer();
  assert.equal(other.assigned.value, '3');
  assert.equal(other.selectedCar(), 2);
  assert.deepEqual(other.clicks, ['remove', 'car-2', 'seat-2-3']);
});
test('a rejected lower-berth selection restores the original assigned upper berth and car', () => {
  const h = berthMap({ refuse: true, candidates: [{ id: '3', lower: true, car: 2 }] });
  h.prefer();
  assert.equal(h.assigned.value, '2');
  assert.equal(h.selectedCar(), 1);
  assert.deepEqual(h.clicks, ['remove', 'car-2', 'seat-2-3', 'car-1', 'seat-1-2']);
});
test('automatic Next honors the lower-berth preference on one-way and both round-trip seat pages', () => {
  for (const roundTrip of [false, true]) {
    for (const preferLowerBerths of [undefined, true, false]) {
      const h = flow({ roundTrip, targetChanges: { preferLowerBerths } });
      const maps = [];
      const showSeats = () => {
        const map = berthMap({ candidates: [{ id: '3', lower: true }] });
        maps.push(map);
        h.context.document.querySelectorAll = map.context.document.querySelectorAll;
        h.context.removeDataByUserId = map.context.removeDataByUserId;
        h.context.IsGenderRoomSeat = map.context.IsGenderRoomSeat;
        h.elements['input[name="data-seat-user-1"]'] = map.assigned;
        h.elements['#step-seat-departure'].querySelectorAll = map.seat.querySelectorAll;
      };
      showSeats();
      h.tick();
      h.context.window.jQuery.active = 0;
      h.tick();
      assert.deepEqual(h.clicks, ['gender-next', 'seat-next']);
      if (roundTrip) {
        showSeats();
        h.context.window.jQuery.active = 0;
        h.tick();
        assert.deepEqual(h.clicks, ['gender-next', 'seat-next', 'seat-next']);
      }
      for (const map of maps) {
        assert.equal(map.assigned.value, preferLowerBerths === false ? '2' : '3');
        assert.deepEqual(map.clicks, preferLowerBerths === false ? [] : ['remove', 'seat-1-3']);
      }
      h.context.window.jQuery.active = 0;
      h.tick();
      assert.equal(h.fills[1].firstName, 'Account');
      assert.equal(h.stopped(), true);
    }
  }
});

test('group autofill fills the account holder and each companion in their own passenger form', () => {
  const companion = { ...passenger, firstName: 'Companion' };
  const h = flow({ count: '2', seatCount: 2, profiles: [{ mode: 'account' }, companion] });
  h.tick();
  assert.equal(h.elements['input[name="pdg_Gender1"]'].value, 'M');
  assert.equal(h.elements['input[name="pdg_Gender2"]'].value, 'F');
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.equal(h.state.personal[1].firstName, 'Companion');
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.deepEqual(
    h.fills.filter((value) => typeof value === 'object').map((value) => value.firstName),
    ['Account', 'Companion'],
  );
  assert.deepEqual(h.clicks, ['gender-next', 'seat-next']);
  assert.equal(h.stopped(), true);
});
test('four passengers all fill, and a missing group seat prevents automatic Next', () => {
  const profiles = [
    { mode: 'account' },
    ...[2, 3, 4].map((n) => ({ ...passenger, firstName: 'Guest' + n, idCard: 'AA12345' + n })),
  ];
  const h = flow({ count: '4', seatCount: 4, profiles });
  h.tick();
  h.context.window.jQuery.active = 0;
  h.tick();
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.deepEqual(
    h.fills.filter((value) => typeof value === 'object').map((value) => value.firstName),
    ['Account', 'Guest2', 'Guest3', 'Guest4'],
  );
  const missing = flow({ count: '2', seatCount: 2, profiles: profiles.slice(0, 2) });
  missing.tick();
  missing.context.window.jQuery.active = 0;
  missing.elements['input[name="data-seat-user-2"]'].value = '';
  missing.tick();
  assert.deepEqual(missing.clicks, ['gender-next']);
});
test('group validation enforces the native limit, unique passenger IDs and one account holder', () => {
  const context = {};
  vm.runInNewContext(source, context);
  const validate = (profiles) => context.RailWatchBooking.validatePassengers(profiles);
  assert.equal(validate([{ mode: 'account' }, passenger]), '');
  for (const profiles of [
    [],
    Array(5).fill(passenger),
    [passenger, passenger],
    [passenger, { mode: 'account' }],
  ])
    assert.ok(validate(profiles));
});
test('passenger editor adds companions, preserves each person, removes one and restores the group', async () => {
  const app = await dashboard();
  await app.elements.addPassenger.onclick();
  assert.equal(app.elements.passengerSelect.value, '1');
  assert.equal(app.elements.passengerMode.value, 'custom');
  app.elements.passengerFirstName.value = 'Companion';
  app.elements.passengerFirstName.emit('change');
  await new Promise((resolve) => setImmediate(resolve));
  app.elements.passengerSelect.value = '0';
  app.elements.passengerSelect.emit('change');
  assert.equal(app.elements.passengerMode.value, 'account');
  app.elements.passengerSelect.value = '1';
  app.elements.passengerSelect.emit('change');
  assert.equal(app.elements.passengerFirstName.value, 'Companion');
  assert.equal(app.elements.passengerCount.textContent, '2 passengers');
  const restored = await dashboard({ saved: app.memory });
  assert.match(restored.elements.passengerSelect.innerHTML, /Companion/);
  await restored.elements.removePassenger.onclick();
  assert.equal(restored.memory.railWatchPassengers.length, 1);
  await app.elements.addPassenger.onclick();
  await app.elements.addPassenger.onclick();
  assert.equal(app.elements.addPassenger.disabled, true);
  await app.elements.addPassenger.onclick();
  assert.equal(app.memory.railWatchPassengers.length, 4);
});
test('group lower-berth preference keeps seats assigned to companions and stays in their carriage', () => {
  const companion = { value: '3' };
  const second = berthMap({
    candidates: [
      { id: '3', lower: true },
      { id: '5', lower: true },
      { id: '7', lower: true, car: 2 },
    ],
  });
  const original = second.context.document.querySelectorAll;
  second.context.document.querySelectorAll = (selector) =>
    selector.includes('trainCoach') ? original(selector) : [second.assigned, companion];
  second.prefer();
  assert.equal(second.assigned.value, '5');
  assert.equal(companion.value, '3');
  assert.equal(second.selectedCar(), 1);
  const otherCar = berthMap({ candidates: [{ id: '7', lower: true, car: 2 }] });
  const selectors = otherCar.context.document.querySelectorAll;
  otherCar.context.document.querySelectorAll = (selector) =>
    selector.includes('trainCoach') ? selectors(selector) : [otherCar.assigned, companion];
  otherCar.prefer();
  assert.equal(otherCar.assigned.value, '2');
  assert.deepEqual(otherCar.clicks, []);
});
test('group coach clicks require seats for everyone before opening any booking', async () => {
  const profiles = [{ mode: 'account' }, passenger];
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
          availableSeatCount: 1,
          coachSeats: [],
        },
      ],
    },
  };
  const app = await dashboard({
    responses,
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
        data: [],
      },
    },
  });
  const button = {
    disabled: false,
    dataset: { bookDate: '21/10/2026', bookTrain: '170', bookCoach: '123|24|4|5', bookClass: '3' },
    closest: (selector) => (selector === '[data-book-train]' ? button : null),
  };
  for (const fn of app.root.listeners.click) fn({ target: button });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.messages, []);
  assert.equal(
    app.elements.statusText.textContent,
    'This coach has 1 seat. You need 2 for everyone.',
  );
  responses.getTrainCoach.results[0].availableSeatCount = 2;
  for (const fn of app.root.listeners.click) fn({ target: button });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.messages[0].params.seatCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(app.messages[0].passengers)), profiles);
  assert.deepEqual(app.requests, ['getTrip', 'getTrainCoach', 'getTrainCoach']);
});

test('round-trip group automation confirms both seat pages once, waits for rebuilt return inputs, then fills once', () => {
  const h = flow({
    roundTrip: true,
    count: '2',
    seatCount: 2,
    profiles: [{ mode: 'account' }, passenger],
  });
  const preferred = [];
  h.context.RailWatchBooking.preferLowerBerth = (_seat, assigned, index) =>
    preferred.push([h.context.step, assigned.value, index]);
  h.tick();
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.deepEqual(h.clicks, ['gender-next', 'seat-next']);
  assert.equal(h.context.step, '41');
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.equal(h.clicks.length, 2);
  h.elements['input[name="data-seat-user-1"]'] = { value: '31' };
  h.elements['input[name="data-seat-user-2"]'] = { value: '' };
  h.tick();
  assert.equal(h.clicks.length, 2);
  h.elements['input[name="data-seat-user-2"]'].value = '32';
  h.tick();
  assert.deepEqual(h.clicks, ['gender-next', 'seat-next', 'seat-next']);
  assert.deepEqual(preferred, [
    ['40', '21', 1],
    ['40', '22', 2],
    ['41', '31', 1],
    ['41', '32', 2],
  ]);
  h.context.window.jQuery.active = 0;
  h.tick();
  assert.equal(h.fills.filter((item) => typeof item === 'object').length, 2);
  assert.equal(h.fills[1].firstName, 'Account');
  assert.equal(h.fills[3].idCard, passenger.idCard);
  assert.equal(h.stopped(), true);
  assert.equal(h.timers.length, 0);
});
test('round-trip autofill stops if the return selection or date changes', () => {
  for (const mutation of [
    (h) => (h.state.dateEnd = '26/10/2026'),
    (h) => (h.state.train.trip[1].trainNo = '45'),
    (h) => (h.state.train.trip[1].coachNo = '3'),
  ]) {
    const h = flow({ roundTrip: true });
    mutation(h);
    h.tick();
    assert.deepEqual(h.clicks, []);
    assert.equal(h.stopped(), true);
  }
});
