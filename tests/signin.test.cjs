const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboard } = require('./dashboard-harness.cjs');

test('sign-in warning follows D-Ticket login state without storing account details', async () => {
  const app = await dashboard({ signedIn: false });
  await app.elements.launcher.onclick();
  assert.equal(app.elements.signInWarning.hidden, false);
  assert.equal(app.elements.signInButton.disabled, false);
  app.setSignedIn(true);
  assert.equal(app.elements.signInWarning.hidden, true);
  app.setSignedIn(false);
  assert.equal(app.elements.signInWarning.hidden, false);
  app.elements.signInButton.click();
  assert.equal(app.elements.shell.hidden, true);
  assert.equal(app.loginClicks(), 1);
  assert.equal(JSON.stringify(app.memory).includes('signed-in'), false);
});

test('unknown login state leaves the warning hidden', async () => {
  const app = await dashboard();
  assert.equal(app.elements.signInWarning.hidden, true);
  assert.equal(app.elements.signInButton.disabled, true);
});
