const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboard } = require('./dashboard-harness.cjs');

test('dashboard opens booking setup with the previous manifest that omits separate booking and watch scripts', async () => {
  const app = await dashboard({
    scripts: ['scanner.js', 'ui.js', 'calendar.js', 'content.js'],
    saved: {
      railWatchBookingSetup: { tripType: '2', returnDate: '2026-10-25' },
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
  await app.elements.launcher.onclick();
  app.elements.bookingSetup.click();
  assert.equal(app.elements.shell.hidden, false);
  assert.equal(app.elements.bookingSetupDialog.open, true);
  assert.equal(app.elements.passengerMode.value, 'account');
  assert.equal(app.elements.returnLegFields.hidden, false);
  assert.equal(app.elements.returnDate.min, '2026-10-21');
  assert.equal(app.elements.returnDate.value, '2026-10-25');
  assert.equal(app.elements.demoChip.hidden, true);
  app.elements.pause.click();
  assert.equal(app.elements.demoChip.hidden, true);
});
