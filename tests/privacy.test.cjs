const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboard } = require('./dashboard-harness.cjs');
const passenger = {
  mode: 'custom',
  firstName: 'Demo',
  lastName: 'Passenger',
  gender: 'F',
  foreignerFlag: 'Y',
  idCard: 'DEMO12345',
  mobileNo: '0800000000',
  email: '',
};

test('a page event without a booking ID cannot read saved passenger details', async () => {
  const app = await dashboard({ saved: { railWatchPassengers: [passenger] } });
  await app.documentEvent('rail-watch-passenger-request', { id: 123 });
  assert.equal(app.documentEvents.length, 0);
  assert.equal(app.messages.length, 0);
  assert.equal(app.memory.railWatchPassengers[0].firstName, 'Demo');
});

test('only a booking page receives a validated passenger handoff', async () => {
  const options = { handleMessage: async () => ({ passengers: [passenger] }) };
  const home = await dashboard(options);
  await home.documentEvent('rail-watch-passenger-request', { id: 123, bookingId: 'demo-booking' });
  assert.equal(home.documentEvents.length, 0);
  const booking = await dashboard({ ...options, pathname: '/DTicketPublicWeb/booking/booking' });
  await booking.documentEvent('rail-watch-passenger-request', {
    id: 123,
    bookingId: 'demo-booking',
  });
  assert.deepEqual(booking.messages, [{ type: 'rail-watch-passenger', bookingId: 'demo-booking' }]);
  assert.deepEqual(JSON.parse(booking.documentEvents[0].detail), {
    id: 123,
    passengers: [passenger],
  });
});

test('passenger page events reject malformed IDs and invalid handoff replies', async () => {
  for (const detail of [
    null,
    {},
    { id: 0, bookingId: 'valid' },
    { id: -1, bookingId: 'valid' },
    { id: '123', bookingId: 'valid' },
    { id: 1.5, bookingId: 'valid' },
    { id: 123, bookingId: '../invalid' },
  ]) {
    const app = await dashboard({ pathname: '/DTicketPublicWeb/booking/booking' });
    await app.documentEvent('rail-watch-passenger-request', detail);
    assert.deepEqual(app.messages, []);
    assert.deepEqual(app.documentEvents, []);
  }
  for (const passengers of [undefined, [], [{ ...passenger, idCard: '' }]]) {
    const app = await dashboard({
      pathname: '/DTicketPublicWeb/booking/booking',
      handleMessage: async () => ({ passengers }),
    });
    await app.documentEvent('rail-watch-passenger-request', { id: 123, bookingId: 'valid' });
    assert.equal(app.messages.length, 1);
    assert.deepEqual(app.documentEvents, []);
  }
});
