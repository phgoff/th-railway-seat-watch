const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../extension/scanner.js');
function setup({ empty = false, handleRequest } = {}) {
  let time = 1000000;
  let tail = Promise.resolve();
  const state = {},
    calls = [];
  const storage = {
    get: async (keys) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(state[k])]),
      ),
    set: async (values) => Object.assign(state, structuredClone(values)),
  };
  const locks = {
    request: (_name, fn) => {
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    },
  };
  const config = {
    origin: '341',
    destination: '1679',
    dates: ['20/10/2026'],
    filter: '1',
    interval: 300000,
  };
  let count = 1,
    failure;
  const request = async (endpoint, params) => {
    calls.push([endpoint, params]);
    if (handleRequest) return handleRequest(endpoint, params);
    if (failure) throw failure;
    return {
      errorCode: 'S_SUCCESS',
      data:
        endpoint === 'getTrip'
          ? empty
            ? []
            : [
                { tripId: 'a', trainNo: '38' },
                { tripId: 'b', trainNo: '170' },
              ]
          : {
              results: [
                {
                  coachId: params.tripId === 'a' ? '116' : '123',
                  coachClass: params.tripId === 'a' ? '1' : '3',
                  coachSeatTypeEn: 'Sleeping Coach',
                  coachAirTypeEn: 'Air Coach',
                  availableSeatCount: count,
                  coachSeats: [],
                },
              ],
            },
    };
  };
  const make = () => create({ storage, locks, request, now: () => time });
  return {
    state,
    calls,
    config,
    make,
    advance: (ms) => (time += ms),
    setCount: (n) => (count = n),
    fail: (e) => (failure = e),
  };
}
test('two tabs share one scan; subsequent first-class scan skips third-class-only train', async () => {
  const h = setup();
  const [a, b] = await Promise.all([h.make().scan(h.config), h.make().scan(h.config)]);
  assert.equal(a.rows.length, 1);
  assert.equal(b.reused, true);
  assert.equal(h.calls.length, 3);
  h.advance(300001);
  await h.make().scan(h.config);
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls[3][1].tripId, 'a');
  h.advance(1800000);
  await h.make().scan(h.config);
  assert.equal(h.calls.length, 7);
});

test('date snapshots reuse subsets and previous dates, with only uncached rows sent as fresh', async () => {
  const h = setup(),
    scanner = h.make();
  await scanner.scan(h.config);
  await scanner.scan({ ...h.config, dates: ['21/10/2026'] });
  assert.equal(h.calls.length, 6);
  assert.equal((await scanner.scan(h.config)).reused, true);
  const range = await scanner.scan({
    ...h.config,
    dates: ['20/10/2026', '21/10/2026', '22/10/2026'],
  });
  assert.equal(h.calls.length, 9);
  assert.deepEqual(
    range.rows.map((row) => row.date),
    ['20/10/2026', '21/10/2026', '22/10/2026'],
  );
  assert.deepEqual(
    range.freshRows.map((row) => row.date),
    ['22/10/2026'],
  );
  h.setCount(0);
  await scanner.verify(h.config, '20/10/2026', '38', { id: '116|||' });
  const rechecked = await scanner.scan(h.config);
  assert.equal(rechecked.reused, true);
  assert.equal(rechecked.rows[0].coaches[0].count, 0);
  h.state.railWatchCooldown = { until: 1900000, failures: 1 };
  const cooled = await scanner.scan(h.config);
  assert.equal(cooled.reused, true);
  assert.deepEqual(h.state.railWatchCooldown, { until: 1900000, failures: 1 });
  await assert.rejects(scanner.scan({ ...h.config, dates: ['23/10/2026'] }), /cooldown/);
});

test('empty train dates are cached when switching away and back', async () => {
  const h = setup({ empty: true }),
    scanner = h.make();
  await scanner.scan(h.config);
  await scanner.scan({ ...h.config, dates: ['21/10/2026'] });
  const back = await scanner.scan(h.config);
  assert.equal(back.reused, true);
  assert.deepEqual(back.rows, []);
  assert.equal(h.calls.length, 2);
});
test('switching filter discovers other coaches, with route/date-isolated trip cache', async () => {
  const h = setup();
  await h.make().scan(h.config);
  const all = await h.make().scan({ ...h.config, filter: 'all' });
  assert.equal(all.rows.length, 2);
  assert.equal(h.calls.filter(([endpoint]) => endpoint === 'getTrip').length, 1);
  await h.make().scan({ ...h.config, destination: 'different' });
  assert.equal(h.calls.filter(([endpoint]) => endpoint === 'getTrip').length, 2);
});
test('click verification catches a disappeared berth and updates shared cached result', async () => {
  const h = setup();
  await h.make().scan(h.config);
  h.setCount(0);
  const result = await h.make().verify(h.config, '20/10/2026', '38', { id: '116|||' });
  assert.equal(result.available, false);
  assert.equal(h.calls.length, 4);
  const shared = await h.make().scan(h.config);
  assert.equal(shared.rows[0].coaches[0].count, 0);
  assert.equal(h.calls.length, 4);
});
test('coach verification refreshes an all-class result reused by a narrower filter', async () => {
  const h = setup();
  h.setCount(8);
  await h.make().scan({ ...h.config, filter: 'all' });
  h.setCount(0);
  const config = { ...h.config, filter: '3' };
  const checked = await h.make().verify(config, '20/10/2026', '170', { id: '123|||' });
  assert.equal(checked.available, false);
  const restored = await h.make().scan(config);
  assert.equal(restored.reused, true);
  assert.deepEqual(
    restored.rows.map((row) => [row.train, row.coaches[0].count]),
    [
      ['38', 8],
      ['170', 0],
    ],
  );
  assert.equal(h.calls.length, 4);
});
test('coach verification updates only its train and date within a wider shared range', async () => {
  const h = setup();
  h.setCount(8);
  const range = { ...h.config, filter: 'all', dates: ['20/10/2026', '21/10/2026'] };
  await h.make().scan(range);
  h.setCount(0);
  await h.make().verify({ ...h.config, filter: '3' }, '20/10/2026', '170', { id: '123|||' });
  const restored = await h.make().scan(range);
  assert.equal(restored.reused, true);
  assert.deepEqual(
    restored.rows.map((row) => [row.date, row.train, row.coaches[0].count]),
    [
      ['20/10/2026', '38', 8],
      ['20/10/2026', '170', 0],
      ['21/10/2026', '38', 8],
      ['21/10/2026', '170', 8],
    ],
  );
  assert.equal(h.calls.length, 7);
});
test('coach verification preserves another route and refreshes the original route snapshot', async () => {
  const h = setup();
  h.setCount(8);
  const original = { ...h.config, filter: 'all' };
  const other = { ...original, destination: 'different' };
  await h.make().scan(original);
  await h.make().scan(other);
  h.setCount(0);
  await h.make().verify({ ...h.config, filter: '3' }, '20/10/2026', '170', { id: '123|||' });
  const preserved = await h.make().scan(other);
  assert.equal(preserved.reused, true);
  assert.deepEqual(
    preserved.rows.map((row) => [row.train, row.coaches[0].count]),
    [
      ['38', 8],
      ['170', 8],
    ],
  );
  const restored = await h.make().scan(original);
  assert.equal(restored.reused, true);
  assert.deepEqual(
    restored.rows.map((row) => [row.train, row.coaches[0].count]),
    [
      ['38', 8],
      ['170', 0],
    ],
  );
  assert.equal(h.calls.length, 7);
});
test('a live class scan refreshes the same coach in a cached all-class snapshot', async () => {
  const h = setup();
  h.setCount(8);
  const all = { ...h.config, filter: 'all' };
  await h.make().scan(all);
  h.setCount(0);
  const fresh = await h.make().scan({ ...h.config, filter: '3' }, undefined, { force: true });
  assert.deepEqual(
    fresh.rows.map((row) => [row.train, row.coaches[0].count]),
    [['170', 0]],
  );
  const restored = await h.make().scan(all);
  assert.equal(restored.reused, true);
  assert.deepEqual(
    restored.rows.map((row) => [row.train, row.coaches[0].count]),
    [
      ['38', 8],
      ['170', 0],
    ],
  );
  assert.equal(h.calls.length, 4);
});
test('429 cooldown persists across tabs, honors Retry-After, and increases after repeated limits', async () => {
  const h = setup();
  h.fail(Object.assign(Error('HTTP 429'), { httpStatus: 429, retryAt: 1900000 }));
  await assert.rejects(h.make().scan(h.config), (e) => e.retryAt === 1900000);
  await assert.rejects(h.make().scan(h.config), (e) => e.retryAt === 1900000);
  assert.equal(h.calls.length, 1);
  h.advance(900001);
  h.fail(Object.assign(Error('HTTP 429'), { httpStatus: 429 }));
  await assert.rejects(h.make().scan(h.config), (e) => e.retryAt === 2500001);
  assert.equal(h.calls.length, 2);
});
test('expired trip cache is discarded after a coach error; previous completed results survive', async () => {
  const h = setup();
  await h.make().scan(h.config);
  h.advance(300001);
  h.fail(Error('E_INVALID_TRIP'));
  await assert.rejects(h.make().scan(h.config));
  assert.deepEqual(h.state.railWatchTrips, {});
  assert.equal(h.state.railWatchShared.rows[0].coaches[0].count, 1);
  h.fail(null);
  await h.make().scan(h.config);
  assert.equal(h.calls.filter(([name]) => name === 'getTrip').length, 2);
});

test('all-class results cover class changes without requests, then refresh after five minutes', async () => {
  const h = setup();
  const all = await h.make().scan({ ...h.config, filter: 'all' });
  const requests = h.calls.length;
  for (const filter of ['1', '3', 'sleep', 'all']) {
    const result = await h.make().scan({ ...h.config, filter });
    assert.equal(result.reused, true);
    assert.equal(result.at, all.at);
    assert.equal(h.calls.length, requests);
  }
  h.setCount(0);
  h.advance(300001);
  const fresh = await h.make().scan(h.config);
  assert.equal(fresh.reused, undefined);
  assert.equal(fresh.rows[0].coaches[0].count, 0);
  assert.equal(h.calls.length, requests + 1);
});
test('restoration only accepts cached results covering the selected route, dates and class', async () => {
  const h = setup(),
    scanner = h.make();
  const cached = await scanner.scan({ ...h.config, filter: 'all' });
  assert.equal(scanner.covers(cached, h.config), true);
  assert.equal(scanner.covers(cached, { ...h.config, destination: 'other' }), false);
  assert.equal(scanner.covers(cached, { ...h.config, dates: ['21/10/2026'] }), false);
  h.advance(300001);
  const first = await scanner.scan(h.config);
  assert.equal(scanner.covers(first, { ...h.config, filter: 'all' }), false);
});
test('combined first and second class filters reuse broader results and skip third class', async () => {
  const h = setup();
  await h.make().scan({ ...h.config, filter: 'all' });
  const requests = h.calls.length;
  const combined = await h.make().scan({ ...h.config, filter: '1,2' });
  assert.equal(combined.reused, true);
  assert.equal(h.calls.length, requests);
  h.advance(300001);
  const fresh = await h.make().scan({ ...h.config, filter: '1,2' });
  assert.deepEqual(
    fresh.rows.map((r) => r.train),
    ['38'],
  );
  assert.equal(h.calls.length, requests + 1);
  assert.equal(h.make().covers(fresh, h.config), true);
  assert.equal(h.make().covers(fresh, { ...h.config, filter: '3' }), false);
});

test('manual force checks refresh seat counts while normal scans reuse cached results and cooldowns still apply', async () => {
  const h = setup();
  const scanner = h.make();
  const first = await scanner.scan(h.config);
  assert.equal(first.rows[0].coaches[0].count, 1);
  h.setCount(4);
  const cached = await scanner.scan(h.config);
  assert.equal(cached.rows[0].coaches[0].count, 1);
  const fresh = await scanner.scan(h.config, undefined, { force: true });
  assert.equal(fresh.rows[0].coaches[0].count, 4);
  assert.equal(h.calls.filter(([name]) => name === 'getTrip').length, 1);
  assert.equal((await scanner.scan(h.config)).rows[0].coaches[0].count, 4);
  h.fail(Object.assign(Error('HTTP 429'), { httpStatus: 429 }));
  await assert.rejects(scanner.scan(h.config, undefined, { force: true }), (e) => !!e.retryAt);
  const requests = h.calls.length;
  await assert.rejects(scanner.scan(h.config, undefined, { force: true }), /cooldown/);
  assert.equal(h.calls.length, requests);
});

function controlled() {
  const pending = new Map();
  const trips = ['a', 'b', 'c', 'd'].map((tripId, index) => ({
    tripId,
    trainNo: String(38 + index),
  }));
  const h = setup({
    handleRequest(endpoint, params) {
      if (endpoint === 'getTrip') return { errorCode: 'S_SUCCESS', data: trips };
      if (endpoint === 'getStation') return { errorCode: 'S_SUCCESS', data: [] };
      return new Promise((resolve, reject) => {
        pending.set(params.tripId, {
          resolve() {
            pending.delete(params.tripId);
            resolve({
              errorCode: 'S_SUCCESS',
              data: {
                results: [
                  {
                    coachId: params.tripId,
                    coachClass: '1',
                    availableSeatCount: 1,
                    coachSeats: [],
                  },
                ],
              },
            });
          },
          reject(error) {
            pending.delete(params.tripId);
            reject(error);
          },
        });
      });
    },
  });
  return { ...h, pending };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('scans overlap only two coach requests and preserve train order despite reversed completion', async () => {
  const h = controlled();
  const scan = h.make().scan(h.config);
  await turn();
  assert.deepEqual([...h.pending.keys()], ['a', 'b']);
  h.pending.get('b').resolve();
  await turn();
  assert.deepEqual([...h.pending.keys()], ['a', 'c']);
  h.pending.get('c').resolve();
  await turn();
  assert.deepEqual([...h.pending.keys()], ['a', 'd']);
  h.pending.get('d').resolve();
  await turn();
  assert.equal(h.state.railWatchShared, undefined);
  h.pending.get('a').resolve();
  const result = await scan;
  assert.deepEqual(
    result.rows.map((row) => row.train),
    ['38', '39', '40', '41'],
  );
  assert.deepEqual(result.freshRows, result.rows);
  assert.equal((await h.make().scan(h.config)).reused, true);
  assert.equal(h.calls.length, 5);
});

test('failed parallel scans stop queued coaches and hold the shared lock until active requests settle', async () => {
  const h = controlled();
  const previous = { key: 'previous', rows: [{ train: 'old', coaches: [{ count: 9 }] }] };
  h.state.railWatchShared = previous;
  const scan = h
    .make()
    .scan(h.config)
    .catch((error) => error);
  await turn();
  const stations = h.make().stations();
  h.pending.get('a').reject(Error('E_INVALID_TRIP'));
  await turn();
  assert.deepEqual([...h.pending.keys()], ['b']);
  assert.equal(h.calls.length, 3);
  h.pending.get('b').resolve();
  assert.equal((await scan).message, 'E_INVALID_TRIP');
  await stations;
  assert.deepEqual(
    h.calls.map(([endpoint]) => endpoint),
    ['getTrip', 'getTrainCoach', 'getTrainCoach', 'getStation'],
  );
  assert.deepEqual(h.state.railWatchShared, previous);
  assert.deepEqual(h.state.railWatchTrips, {});
});

test('simultaneous rate limits count once, retain the longest retry and block the next tab', async () => {
  const h = controlled();
  const scan = h
    .make()
    .scan(h.config)
    .catch((error) => error);
  await turn();
  const nextTab = h
    .make()
    .stations()
    .catch((error) => error);
  h.pending
    .get('a')
    .reject(Object.assign(Error('HTTP 429'), { httpStatus: 429, retryAt: 1600000 }));
  await turn();
  assert.equal(h.calls.length, 3);
  h.pending
    .get('b')
    .reject(Object.assign(Error('HTTP 429'), { httpStatus: 429, retryAt: 1900000 }));
  assert.equal((await scan).retryAt, 1900000);
  assert.equal((await nextTab).retryAt, 1900000);
  assert.deepEqual(h.state.railWatchCooldown, { until: 1900000, failures: 1 });
  assert.equal(h.calls.length, 3);
});
