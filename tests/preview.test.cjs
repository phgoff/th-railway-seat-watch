const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const scanner = require('../extension/scanner.js');
const fixture = JSON.parse(fs.readFileSync('fixtures/demo-availability.json', 'utf8'));

function preview(search = '') {
  const context = vm.createContext({
    RailWatchPreviewData: fixture,
    RailWatchScanner: scanner,
    URLSearchParams,
    Date,
    crypto: { randomUUID: () => 'preview-id' },
    structuredClone,
    location: { search },
    localStorage: { getItem: () => null, setItem() {} },
    window: { addEventListener() {} },
    setTimeout: (fn) => fn(),
  });
  for (const file of ['booking.js', 'watch.js', 'preview-runtime.js'])
    vm.runInContext(fs.readFileSync('extension/' + file, 'utf8'), context);
  return context.RailWatchRuntime;
}

test('demo preview seeds fictional trips with Thai descriptions, coach IDs and fares', async () => {
  const runtime = preview('?sample=1');
  const { railWatch: seed } = await runtime.storage.local.get(['railWatch']);
  const capture = fixture.captures[0];
  assert.equal(seed.route.origin.id, capture.originId);
  assert.equal(seed.lastCheck, fixture.capturedAt);
  assert.equal(seed.data.length, capture.coaches.length);
  assert.equal(fixture.synthetic, true);
  assert.equal(seed.from, '2027-01-01');
  const row = seed.data[0];
  const raw = capture.coaches.find((item) => item.tripId === row.tripId && item.date === row.date);
  assert.deepEqual(row.coaches, raw.results.map(scanner.normalize));
  assert.match(row.coaches[0].desc, /[ก-๙]/);
  assert.equal(row.coaches[0].id, raw.results.map(scanner.normalize)[0].id);
});

test('demo responses go through the production scanner without losing any detail', async () => {
  const runtime = preview('?sample=1');
  const network = scanner.create({
    storage: runtime.storage.local,
    locks: { request: async (_name, fn) => fn() },
    request: runtime.request,
  });
  const date = fixture.captures[0].trips[0].date;
  const result = await network.scan({
    origin: fixture.captures[0].originId,
    destination: fixture.captures[0].destinationId,
    dates: [date],
    filter: 'all',
    interval: 900000,
  });
  assert.equal(result.rows.length, 3);
  assert.deepEqual([...result.rows.map((row) => row.train)], ['101', '103', '105']);
  for (const row of result.rows) {
    const raw = fixture.captures[0].coaches.find((item) => item.tripId === row.tripId);
    assert.deepEqual(row.coaches, raw.results.map(scanner.normalize));
  }
});

test('reverse route uses its own demo trains and the public station list', async () => {
  const runtime = preview('?route=reverse');
  const { railWatch: seed } = await runtime.storage.local.get(['railWatch']);
  assert.equal(seed.route.origin.id, fixture.captures[1].originId);
  const stations = await runtime.request('getStation', { LineId: '' });
  assert.deepEqual(stations.data, fixture.stations);
  assert.ok(stations.data.length > 100);
  const trips = await runtime.request('getTrip', {
    provinceStartId: fixture.captures[1].originId,
    provinceEndId: fixture.captures[1].destinationId,
    dateStart: fixture.captures[1].trips[0].date,
  });
  assert.deepEqual(trips.data, fixture.captures[1].trips[0].data);
});

test('demo dates remain stable after their calendar dates pass and fixture excludes session data', async () => {
  const runtime = preview('?sample=1');
  const { railWatch: seed } = await runtime.storage.local.get(['railWatch']);
  assert.equal(seed.data.length, 23);
  assert.equal(seed.selected[1], '101');
  assert.equal(runtime.minimumDate, '2027-01-01');
  assert.doesNotMatch(
    JSON.stringify(fixture),
    /viewStateHolder|JSESSIONID|password|userName|sessionDataBooking/i,
  );
});

test('public demo fixture contains only approved public fields and fictional trips', () => {
  const fields = (value, allowed) => {
    for (const key of Object.keys(value))
      assert.ok(allowed.includes(key), 'Unexpected fixture field: ' + key);
  };
  assert.equal(fixture.synthetic, true);
  fields(fixture, ['schema', 'synthetic', 'source', 'capturedAt', 'stations', 'captures']);
  for (const station of fixture.stations)
    fields(station, ['stationId', 'stationNameEn', 'stationNameTh']);
  for (const capture of fixture.captures) {
    fields(capture, ['originId', 'destinationId', 'trips', 'coaches']);
    for (const day of capture.trips) {
      fields(day, ['date', 'data']);
      for (const trip of day.data) {
        fields(trip, [
          'tripId',
          'trainNo',
          'departureTime',
          'arrivalTime',
          'trainNameEn',
          'trainNameTh',
        ]);
        assert.equal(trip.trainNameEn, 'Demo train');
      }
    }
    for (const row of capture.coaches) {
      fields(row, ['tripId', 'date', 'results']);
      for (const coach of row.results) {
        fields(coach, [
          'coachId',
          'coachNo',
          'coachLayoutId',
          'coachTypeId',
          'coachClass',
          'coachDesc',
          'coachSeatTypeEn',
          'coachSeatTypeTh',
          'coachAirTypeEn',
          'coachAirTypeTh',
          'availableSeatCount',
          'coachSeats',
        ]);
        for (const seat of coach.coachSeats)
          fields(seat, ['seatFeeAmt', 'seatTypNameEn', 'seatTypNameTh']);
      }
    }
  }
});

test('the default demo has no preset route, dates, results or history', async () => {
  const runtime = preview();
  const stored = await runtime.storage.local.get(['railWatch', 'railWatchAvailabilityLog']);
  assert.deepEqual(JSON.parse(JSON.stringify(stored.railWatch.route)), {
    origin: null,
    destination: null,
  });
  assert.equal(stored.railWatch.from, '');
  assert.equal(stored.railWatch.through, '');
  assert.equal(stored.railWatch.filter, 'all');
  assert.equal(stored.railWatch.data.length, 0);
  assert.equal(stored.railWatchAvailabilityLog.entries.length, 0);
  const stations = await runtime.request('getStation', { LineId: '' });
  assert.equal(stations.data[0].stationNameEn, fixture.stations[0].stationNameEn);
});

test('demo watch resolves the first feasible alternative without opening a real booking and strips passenger snapshots', async () => {
  const runtime = preview('?sample=1');
  const first = { train: '101', coachId: '100|1|4|5', coachLabel: 'Preferred' };
  const fallback = { train: '103', coachId: '100|2|4|5', coachLabel: 'Fallback' };
  const target = {
    origin: '341',
    destination: '1679',
    date: '01/01/2027',
    alternatives: [first, fallback],
    passengers: [{ mode: 'account' }],
  };
  const { watch } = await runtime.runtime.sendMessage({ type: 'rail-watch-arm', watch: target });
  const check = {
    config: { origin: target.origin, destination: target.destination, dates: [target.date] },
    fresh: true,
    at: Date.now(),
    rows: [
      {
        date: target.date,
        train: first.train,
        checkedAt: new Date().toISOString(),
        coaches: [{ id: first.coachId, count: 0 }],
      },
      {
        date: target.date,
        train: fallback.train,
        checkedAt: new Date().toISOString(),
        coaches: [{ id: fallback.coachId, count: 1 }],
      },
    ],
  };
  const result = await runtime.runtime.sendMessage({
    type: 'rail-watch-result',
    id: watch.id,
    checks: [check],
  });
  assert.equal(result.watch.status, 'opened');
  assert.deepEqual(JSON.parse(JSON.stringify(result.watch.selected)), fallback);
  const stored = await runtime.storage.local.get(['railWatchBookingWatch']);
  assert.equal(stored.railWatchBookingWatch.seatCount, 1);
  assert.equal(stored.railWatchBookingWatch.passengers, undefined);
  assert.equal(result.watch.tabId, undefined);
  assert.equal(
    (await runtime.runtime.sendMessage({ type: 'rail-watch-booking' })).message,
    'These are demo seats. Open the extension on D-Ticket to book a real coach.',
  );
});

test('demo watches validate arming, reject concurrent replacement and cancellation prevents a delayed result', async () => {
  const runtime = preview('?sample=1');
  const choice = { train: '101', coachId: '100|1|4|5', coachLabel: 'Preferred' };
  const target = {
    origin: '341',
    destination: '1679',
    date: '01/01/2027',
    alternatives: [choice],
    passengers: [{ mode: 'account' }],
  };
  assert.match(
    (
      await runtime.runtime.sendMessage({
        type: 'rail-watch-arm',
        watch: { ...target, passengers: [{ mode: 'manual' }] },
      })
    ).error,
    /automatic/,
  );
  const replies = await Promise.all([
    runtime.runtime.sendMessage({ type: 'rail-watch-arm', watch: target }),
    runtime.runtime.sendMessage({ type: 'rail-watch-arm', watch: target }),
  ]);
  assert.equal(replies[0].watch.status, 'armed');
  assert.match(replies[1].error, /Cancel/);
  const id = replies[0].watch.id;
  await runtime.runtime.sendMessage({ type: 'rail-watch-cancel', id });
  const response = await runtime.runtime.sendMessage({
    type: 'rail-watch-result',
    id,
    checks: [
      {
        config: { origin: target.origin, destination: target.destination, dates: [target.date] },
        fresh: true,
        at: Date.now(),
        rows: [
          {
            date: target.date,
            train: choice.train,
            checkedAt: new Date().toISOString(),
            coaches: [{ id: choice.coachId, count: 1 }],
          },
        ],
      },
    ],
  });
  assert.equal(response.watch.status, 'cancelled');
  assert.equal(response.watch.selected, undefined);
  assert.equal(response.watch.passengers, undefined);
  assert.equal(response.watch.seatCount, 1);
});
