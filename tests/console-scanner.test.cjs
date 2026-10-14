const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(search) {
  const calls = [];
  const context = vm.createContext({
    sessionDataBooking: search,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    jQuery: () => ({ serializeArray: () => [] }),
    SmartUtil: {
      ajax(endpoint, fields, callbacks) {
        const params = Object.fromEntries(fields.map((x) => [x.name, x.value]));
        calls.push({ endpoint, params });
        setImmediate(() =>
          callbacks.onSuccess({
            errorCode: 'S_SUCCESS',
            data: endpoint.endsWith('getTrip')
              ? [{ tripId: '42', trainNo: '99' }]
              : { results: [] },
          }),
        );
        return undefined;
      },
    },
  });
  vm.runInContext(fs.readFileSync('scan-availability.js', 'utf8'), context);
  return { calls, run: (options) => context.scanAvailability(options) };
}
test('explicit route and range crosses a year boundary using callback API', async () => {
  const h = setup({});
  const rows = await h.run({
    originId: '123',
    destinationId: '456',
    from: '2026-12-31',
    through: '2027-01-02',
  });
  assert.deepEqual(
    Array.from(rows, (r) => r.date),
    ['31/12/2026', '1/01/2027', '2/01/2027'],
  );
  assert.equal(h.calls.length, 6);
  assert.ok(
    h.calls.every((c) => c.params.provinceStartId === '123' && c.params.provinceEndId === '456'),
  );
});
test('omitted options use the current page search, with no fixed station or date defaults', async () => {
  const h = setup({ provinceStartId: '789', provinceEndId: '987', dateStart: '29/02/2028' });
  const rows = await h.run();
  assert.equal(rows[0].date, '29/02/2028');
  assert.equal(rows[0].originId, '789');
  assert.equal(h.calls.length, 2);
});
test('invalid dates, routes and oversized ranges fail before any requests', async () => {
  const h = setup({});
  const base = { originId: '1', destinationId: '2', from: '2026-02-30' };
  await assert.rejects(h.run(base), /Invalid departure date/);
  await assert.rejects(h.run({ ...base, from: '2026-01-01', through: '2026-02-02' }), /31 days/);
  await assert.rejects(h.run({ ...base, destinationId: '1' }), /different origin/);
  await assert.rejects(h.run(), /Choose different/);
  assert.equal(h.calls.length, 0);
});
