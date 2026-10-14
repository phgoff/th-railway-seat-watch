const { test, expect } = require('@playwright/test');

async function chooseCoach(page, leg, train, index = 0) {
  const group = page.locator(
    `#${leg === 'return' ? 'returnChoices' : 'watchChoices'} details[data-watch-train="${train}"]`,
  );
  if (!(await group.evaluate((el) => el.open))) await group.locator('summary').click();
  await group.locator('input').nth(index).check();
}

async function quickSelect(page, leg, action) {
  await page.locator('#' + leg + 'QuickSelect').click();
  await page.locator('#' + leg + action).click();
}

test('the built demo renders real DOM results without third-party requests or script errors', async ({
  page,
}) => {
  const external = [],
    errors = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== new URL(test.info().project.use.baseURL).origin)
      external.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) =>
    errors.push(request.failure().errorText + ' ' + request.url()),
  );
  await page.goto('/dashboard.html?sample=1');
  expect(errors).toEqual([]);
  await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
  await expect(page.locator('.th-no')).toHaveText(['Train 101', 'Train 103', 'Train 105']);
  await expect(page.locator('.mx-cell')).toHaveCount(6);
  await page.getByRole('button', { name: '1 Jan train 103 fully booked', exact: true }).click();
  await expect(page.locator('#detail')).toContainText('Sold out');
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('live header keeps next-check text and all actions at the right edge without the demo chip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard.html?sample=1');
  const assertAlignment = () =>
    expect
      .poll(() =>
        page.locator('.ck-status .status').evaluate((status) => {
          const header = status.getBoundingClientRect();
          const next = status.querySelector('#nextCheckText').getBoundingClientRect();
          const buttons = ['refresh', 'pause', 'close'].map((id) =>
            status.querySelector('#' + id).getBoundingClientRect(),
          );
          return {
            rightEdge: Math.abs(buttons[2].right - header.right) < 1,
            nextToActions: Math.abs(buttons[0].left - next.right - 12) < 1,
            buttonGaps: buttons
              .slice(1)
              .every((button, index) => Math.abs(button.left - buttons[index].right - 10) < 1),
            insideHeader: next.left >= header.left,
          };
        }),
      )
      .toEqual({ rightEdge: true, nextToActions: true, buttonGaps: true, insideHeader: true });
  await assertAlignment();
  await page.route('**/extension/content.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: "globalThis.RailWatchRuntime.mode = 'extension';\n" + (await response.text()),
    });
  });
  await page.reload();
  await expect(page.locator('#demoChip')).not.toBeVisible();
  await page.locator('#demoChip').evaluate((chip) => {
    chip.parentElement.querySelector('#statusText').textContent = 'Checked 6 dates · 5 trains';
    chip.parentElement.querySelector('#nextCheckText').textContent = 'Next 14:30:00';
  });
  await assertAlignment();
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(page.locator('#cockpit')).toHaveClass(/sidebar-collapsed/);
  await assertAlignment();
  for (const width of [1280, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertAlignment();
  }
});

test('route swaps and theme preferences survive a reload', async ({ page }) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Swap route', exact: true }).click();
  await expect(page.locator('#origin')).toHaveValue('Chiang Mai');
  await expect(page.locator('.th-no')).toHaveText(['Train 102', 'Train 104', 'Train 106']);
  await page.getByRole('button', { name: 'Toggle light/dark theme' }).click();
  await expect(page.locator('#shell')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('#origin')).toHaveValue('Chiang Mai');
  await expect(page.locator('#shell')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Swap route', exact: true }).click();
  await expect(page.locator('.th-no')).toHaveText(['Train 101', 'Train 103', 'Train 105']);
});

test('booking setup closes with Escape and the dashboard can close and reopen', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await expect(page.locator('#bookingSetupDialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#bookingSetupDialog')).not.toBeVisible();
  await expect(page.locator('#shell')).toBeVisible();
  await page.getByRole('button', { name: 'Close dashboard', exact: true }).click();
  await expect(page.locator('#shell')).not.toBeVisible();
  await page.getByRole('button', { name: 'Seat dashboard', exact: true }).click();
  await expect(page.locator('.mx-cell')).toHaveCount(6);
});

test('fresh use leaves route and dates empty, keeps all classes checked and allows the first date selection', async ({
  page,
}) => {
  await page.goto('/dashboard.html');
  for (const id of ['origin', 'destination', 'from', 'through'])
    await expect(page.locator('#' + id)).toHaveValue('');
  await expect(page.locator('#filter input:checked')).toHaveCount(4);
  await page.getByRole('switch', { name: 'Toggle seat alerts' }).click();
  await page.locator('#alertTrainPicker summary').click();
  await expect(
    page.getByRole('checkbox', { name: 'Alert on all trains', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Start date', exact: true }).click();
  await expect(page.locator('#dateCalendar')).toBeVisible();
  await page.locator('#calendarDays button:not(:disabled)').first().click();
  await expect(page.locator('#from')).toHaveValue('2027-01-01');
  await expect(page.locator('#through')).toHaveValue('2027-01-01');
  await page.reload();
  await expect(page.locator('#from')).toHaveValue('2027-01-01');
  await expect(page.locator('#origin')).toHaveValue('');
});

test('alert checkboxes cover all, partial, none, reload, keyboard and changing routes', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('switch', { name: 'Toggle seat alerts' }).click();
  const open = () => page.locator('#alertTrainPicker summary').click();
  const all = page.getByRole('checkbox', { name: 'Alert on all trains', exact: true });
  const train = (number) =>
    page.getByRole('checkbox', { name: 'Alert on train ' + number, exact: true });
  await open();
  await expect(all).toBeChecked();
  for (const number of ['101', '103', '105']) await expect(train(number)).toBeChecked();
  await train('101').uncheck();
  await expect(all).toHaveJSProperty('indeterminate', true);
  await expect(train('101')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(all).toBeChecked();
  await expect(all).toHaveJSProperty('indeterminate', false);
  await all.uncheck();
  await expect(page.locator('#alertTrainLabel')).toHaveText('No trains');
  for (const number of ['101', '103', '105']) await expect(train(number)).not.toBeChecked();
  await train('103').check();
  await page.reload();
  await open();
  await expect(train('103')).toBeChecked();
  await expect(all).toHaveJSProperty('indeterminate', true);
  await train('103').uncheck();
  await page.reload();
  await open();
  await expect(all).not.toBeChecked();
  await expect(page.locator('#alertTrainLabel')).toHaveText('No trains');
  for (const number of ['101', '103', '105']) await train(number).check();
  await expect(all).toBeChecked();
  await expect(page.locator('#alertTrainLabel')).toHaveText('All trains');
  await page.getByRole('button', { name: 'Swap route', exact: true }).click();
  await open();
  for (const number of ['102', '104', '106']) await expect(train(number)).toBeChecked();
  await train('104').uncheck();
  await expect(all).toHaveJSProperty('indeterminate', true);
  await all.check();
  await expect(train('104')).toBeChecked();
});

test('date selection keeps the dashboard backdrop clear', async ({ page }) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'End date', exact: true }).click();
  await expect(page.locator('#dateCalendar')).toBeVisible();
  const backdrop = await page
    .locator('#dateCalendar')
    .evaluate((calendar) => globalThis.getComputedStyle(calendar, '::backdrop').backgroundColor);
  expect(backdrop).toBe('rgba(0, 0, 0, 0)');
  await page.getByRole('button', { name: '2027-01-03', exact: true }).click();
  await expect(page.locator('#through')).toHaveValue('2027-01-03');
  await expect(page.locator('#dateCalendar')).not.toBeVisible();
  await expect(page.locator('.mx-cell')).toHaveCount(9);
  await expect(page.locator('#matrix')).toHaveCSS('opacity', '1');
});

test('route swaps keep station names visible throughout the update', async ({ page }) => {
  await page.goto('/dashboard.html?sample=1');
  await page.locator('#origin').evaluate((origin) => {
    const root = origin.getRootNode();
    globalThis.stationOpacities = [];
    globalThis.sampleStations = true;
    const sample = () => {
      globalThis.stationOpacities.push(
        ...['origin', 'destination'].map((id) =>
          Number(globalThis.getComputedStyle(root.getElementById(id)).opacity),
        ),
      );
      if (globalThis.sampleStations) globalThis.requestAnimationFrame(sample);
    };
    globalThis.requestAnimationFrame(sample);
  });
  await page.getByRole('button', { name: 'Swap route', exact: true }).click();
  await expect(page.locator('.th-no')).toHaveText(['Train 102', 'Train 104', 'Train 106']);
  const minimum = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    globalThis.sampleStations = false;
    return Math.min(...globalThis.stationOpacities);
  });
  expect(minimum).toBe(1);
  await expect(page.locator('#origin')).toHaveValue('Chiang Mai');
});

test('booking setup leaves space for the Journey keyboard focus ring', async ({ page }) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await page.keyboard.press('Tab');
  await expect(page.locator('#bookingTripType')).toBeFocused();
  const fits = await page.locator('#bookingTripType').evaluate((select) => {
    const style = globalThis.getComputedStyle(select);
    const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const control = select.getBoundingClientRect();
    const body = select.closest('.booking-dialog-body').getBoundingClientRect();
    return {
      visible: style.outlineStyle !== 'none',
      top: control.top - ring >= body.top,
      right: control.right + ring <= body.right,
      bottom: control.bottom + ring <= body.bottom,
      left: control.left - ring >= body.left,
    };
  });
  expect(fits).toEqual({ visible: true, top: true, right: true, bottom: true, left: true });
});

test('booking choices use concise labels and reload return trains beside the date', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await expect(page.locator('#passengerCount')).toHaveText('1 passenger');
  await expect(page.locator('#watchChoices input:checked')).toHaveCount(0);
  await chooseCoach(page, 'outbound', '103');
  await expect(page.locator('#watchChoiceCount')).toHaveText('1 coach selected');
  await page.locator('#bookingTripType').selectOption('2');
  await expect(page.locator('#returnDate').locator('..').locator('#loadReturn')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Load return trains', exact: true })
    .scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.getByRole('button', { name: 'Load return trains', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Load trains for the return date');
  await page.getByRole('button', { name: 'Load return trains', exact: true }).click();
  await chooseCoach(page, 'return', '104');
  await expect(page.locator('#returnChoiceCount')).toHaveText('1 coach selected');
  await page.getByRole('button', { name: 'Add passenger', exact: true }).click();
  await expect(page.locator('#watchStatus')).toHaveText(
    'Waits for seats for everyone on both legs, then opens one booking.',
  );
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`booking passenger notes stay clear of 1–4 accordions at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/dashboard.html?sample=1');
    await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
    for (let count = 1; count <= 4; count++) {
      if (count > 1) await page.getByRole('button', { name: 'Add passenger', exact: true }).click();
      await page.locator('#passengerMode').selectOption('custom');
      await expect(page.locator('.acc-head')).toHaveCount(count);
      for (const type of ['1', '2']) {
        await page.locator('#bookingTripType').selectOption(type);
        await page.locator('#passengerHint').scrollIntoViewIfNeeded();
        const position = await page.locator('#passengerHint').evaluate((hint) => {
          const root = hint.getRootNode();
          const area = root.querySelector('.passenger-acc-scroll').getBoundingClientRect();
          const note = hint.getBoundingClientRect();
          const last = root.querySelector('.acc-item:last-child').getBoundingClientRect();
          return {
            belowEditor: note.top >= area.bottom,
            belowPassengers: note.top >= Math.min(last.bottom, area.bottom),
          };
        });
        expect(position).toEqual({ belowEditor: true, belowPassengers: true });
        await page.locator('#passengerEmail').scrollIntoViewIfNeeded();
        await expect(page.locator('#passengerEmail')).toBeVisible();
        await expect(page.locator('#passengerCount')).toHaveText(
          `${count} passenger${count === 1 ? '' : 's'}`,
        );
      }
    }
  });
}

test('route inputs browse stations on click, filter names, and reopen without losing focus', async ({
  page,
}) => {
  await page.goto('/dashboard.html');
  const origin = page.getByRole('textbox', { name: 'Origin station' });
  const destination = page.getByRole('textbox', { name: 'Destination station' });
  const suggestions = (input) => input.locator('..').getByRole('listbox');
  await origin.click();
  await expect(suggestions(origin).getByRole('option').first()).toBeVisible();
  await expect(suggestions(origin)).toContainText('Krung Thep Aphiwat');
  await expect(origin).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(suggestions(origin)).not.toBeVisible();
  await expect(origin).toBeFocused();
  await origin.click();
  await expect(suggestions(origin).getByRole('option').first()).toBeVisible();
  await origin.fill('Krung Thep Aphiwat');
  await expect(suggestions(origin).getByRole('option')).toHaveText(['Krung Thep Aphiwat']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(origin).toHaveValue('Krung Thep Aphiwat');
  await expect(suggestions(origin)).not.toBeVisible();
  await origin.click();
  await expect(suggestions(origin)).toContainText('Chiang Mai');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Swap route', exact: true })).toBeFocused();
  await expect(suggestions(origin)).not.toBeVisible();
  await page.keyboard.press('Tab');
  await expect(destination).toBeFocused();
  await expect(suggestions(origin)).not.toBeVisible();
  await expect(origin).toHaveAttribute('aria-expanded', 'false');
  await expect(suggestions(destination).getByRole('option').first()).toBeVisible();
  await destination.fill('เชียงใหม่');
  await expect(suggestions(destination).getByRole('option')).toHaveText(['Chiang Mai']);
  await suggestions(destination).getByRole('option', { name: 'Chiang Mai', exact: true }).click();
  await expect(destination).toHaveValue('Chiang Mai');
  await destination.fill('no-station-matches-this');
  await expect(suggestions(destination)).not.toBeVisible();
  await destination.fill('');
  await expect(suggestions(destination).getByRole('option').first()).toBeVisible();
  await expect(page.locator('#shell')).toBeVisible();
});

test('automatic date checks show queued and checking cells without offering duplicate checks', async ({
  page,
}) => {
  await page.goto('/dashboard.html');
  for (const [id, name] of [
    ['origin', 'Krung Thep Aphiwat'],
    ['destination', 'Chiang Mai'],
  ]) {
    await page.locator('#' + id).fill(name);
    await page.getByRole('option', { name, exact: true }).click();
  }
  await page.evaluate(() => {
    const original = globalThis.RailWatchRuntime.request;
    globalThis.scanRequests = [];
    globalThis.RailWatchRuntime.request = async (endpoint, params) => {
      globalThis.scanRequests.push({ endpoint, params });
      if (endpoint === 'getTrainCoach' && ['10000', '10100'].includes(params.tripId))
        await new Promise((resolve) => {
          globalThis.releaseScan = resolve;
        });
      return original(endpoint, params);
    };
  });
  await page.getByRole('button', { name: 'Start date', exact: true }).click();
  await page.getByRole('button', { name: '2027-01-01', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.scanRequests.some((r) => r.params.tripId === '10000')),
    )
    .toBe(true);
  await expect(page.locator('#matrix')).toContainText('Checking availability');
  await expect(page.locator('#matrix [data-recheck-empty]')).toHaveCount(0);
  await expect(page.locator('#filter input').first()).toHaveCSS('opacity', '1');
  await page.getByRole('button', { name: 'End date', exact: true }).click();
  await page.getByRole('button', { name: '2027-01-03', exact: true }).click();
  await page.evaluate(() => globalThis.releaseScan());
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.scanRequests.some((r) => r.params.tripId === '10100')),
    )
    .toBe(true);
  await expect(
    page.getByRole('button', { name: '2 Jan train 101 checking', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '3 Jan train 101 waiting', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('#detail [data-recheck-empty]')).toHaveCount(0);
  await page.evaluate(() => globalThis.releaseScan());
  await expect(
    page.getByRole('button', { name: '2 Jan train 101 1 seats available', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('.mx-cell.st-loading')).toHaveCount(0);
  await expect(page.locator('#filter input').first()).toHaveCSS('opacity', '1');
});

for (const width of [1280, 320]) {
  test(`multiple watch choices explain locked controls and stay usable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard.html?sample=1');
    await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start watch', exact: true })).toBeDisabled();
    for (const train of ['101', '103']) await chooseCoach(page, 'outbound', train);
    await expect(page.locator('#watchChoiceCount')).toHaveText('2 coaches selected');
    await page.reload();
    await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
    await expect(page.locator('#watchChoices input:checked')).toHaveCount(2);
    await page.getByRole('button', { name: 'Start watch', exact: true }).click();
    await expect(page.locator('#watchStatus')).toContainText('Waiting for 1 seat');
    await expect(page.locator('#watchChoices input:checked')).toHaveCount(2);
    await expect(page.locator('#watchChoices input').first()).toBeDisabled();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('#watchBanner')).toBeVisible();
    await expect(page.locator('#watchBannerTitle')).toHaveText('Watching for 1 seat');
    await expect(page.locator('#watchBannerMeta')).toContainText('2 trains · 2 coaches');
    await expect(page.locator('#origin')).toBeDisabled();
    await expect(page.locator('#origin')).toHaveAttribute('aria-describedby', 'watchLockHint');
    await page.locator('.route-picker').hover();
    await expect(page.locator('#watchLockHint')).toHaveText('Cancel watch to edit.');
    await expect(page.getByRole('tooltip')).not.toBeVisible();
    await page.getByRole('button', { name: 'Pause watch', exact: true }).click();
    await expect(page.locator('#watchBannerTitle')).toHaveText('Watch paused');
    await page.getByRole('button', { name: 'Resume watch', exact: true }).click();
    await expect(page.locator('#watchBannerTitle')).toHaveText('Watching for 1 seat');
    const overflow = await page.evaluate(() => {
      const root = globalThis.document.getElementById('rail-watch-extension').shadowRoot;
      const banner = root.getElementById('watchBanner');
      return banner.scrollWidth > banner.clientWidth;
    });
    expect(overflow).toBe(false);
    await page.getByRole('button', { name: 'Cancel watch', exact: true }).click();
    await expect(page.locator('#watchBanner')).not.toBeVisible();
    await expect(page.locator('#origin')).toBeEnabled();
    await expect(page.locator('#origin')).toHaveValue('Krung Thep Aphiwat');
  });
}

test('round-trip choices wait for both legs and resolve a later available train once', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await page.locator('#bookingTripType').selectOption('2');
  await chooseCoach(page, 'outbound', '103');
  await chooseCoach(page, 'outbound', '105');
  await page.getByRole('button', { name: 'Load return trains', exact: true }).click();
  await chooseCoach(page, 'return', '104');
  await chooseCoach(page, 'return', '106');
  await page.getByRole('button', { name: 'Start watch', exact: true }).click();
  await expect(page.locator('#watchStatus')).toContainText('Waiting for 1 seat');
  await page.locator('#cancelWatch').click();
  await chooseCoach(page, 'outbound', '105', 1);
  await chooseCoach(page, 'return', '106', 1);
  await page.getByRole('button', { name: 'Start watch', exact: true }).click();
  await expect(page.locator('#watchOutcome')).toBeVisible();
  await expect(page.locator('#watchOutcomeTrips')).toContainText('Train 105');
  await expect(page.locator('#watchOutcomeTrips')).toContainText('Train 106');
  await expect(page.locator('#watchOutcomeTrips')).toContainText('Return');
  const result = await page.evaluate(async () => {
    const watch = (await globalThis.RailWatchRuntime.storage.local.get(['railWatchBookingWatch']))
      .railWatchBookingWatch;
    return {
      status: watch.status,
      outbound: watch.selected.train,
      inbound: watch.selected.returnLeg.train,
      passengersKept: 'passengers' in watch,
    };
  });
  expect(result).toEqual({
    status: 'opened',
    outbound: '105',
    inbound: '106',
    passengersKept: false,
  });
});

test('station suggestions show loading, preserve typed text, and retry a failed load', async ({
  page,
}) => {
  await page.route('**/extension/preview-runtime.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
      (() => {
        const request = globalThis.RailWatchRuntime.request;
        let fail = true;
        globalThis.RailWatchRuntime.request = async (endpoint, params) => {
          if (endpoint === 'getStation' && fail) {
            await new Promise(resolve => { globalThis.releaseStations = resolve; });
            fail = false;
            throw Error('HTTP 503');
          }
          return request(endpoint, params);
        };
      })();`,
    });
  });
  await page.goto('/dashboard.html');
  const origin = page.getByRole('textbox', { name: 'Origin station', exact: true });
  await origin.click();
  await expect(page.locator('#originOptions')).toContainText('Loading stations…');
  await expect(origin).toHaveAttribute('aria-busy', 'true');
  await origin.fill('Chiang');
  await page.evaluate(() => globalThis.releaseStations());
  await expect(
    page.getByRole('button', { name: 'Retry loading stations', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry loading stations', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Chiang Mai', exact: true })).toBeVisible();
  await expect(origin).toHaveValue('Chiang');
  await expect(origin).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('option', { name: 'Chiang Mai', exact: true }).click();
  await expect(origin).toHaveValue('Chiang Mai');
});

test('keyboard choice focus survives station loading and the next Space toggles it', async ({
  page,
}) => {
  await page.route('**/extension/preview-runtime.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
      (() => {
        const request = globalThis.RailWatchRuntime.request;
        globalThis.RailWatchRuntime.request = async (endpoint, params) => {
          if (endpoint === 'getStation') await new Promise(resolve => { globalThis.finishStationLoad = resolve; });
          const result = await request(endpoint, params);
          if (endpoint === 'getStation') globalThis.stationsFinished = true;
          return result;
        };
      })();`,
    });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  const choice = page.locator('#watchChoices input').first();
  await choice.focus();
  await page.keyboard.press('Space');
  await expect(choice).toBeChecked();
  await page.evaluate(() => globalThis.finishStationLoad());
  await expect.poll(() => page.evaluate(() => globalThis.stationsFinished)).toBe(true);
  await expect(choice).toBeFocused();
  await page.keyboard.press('Space');
  await expect(choice).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Start watch', exact: true })).toBeDisabled();
});

test('a failed watch check preserves its error and allows a fresh retry', async ({ page }) => {
  await page.route('**/extension/preview-runtime.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
      (() => {
        const request = globalThis.RailWatchRuntime.request;
        let fail = true;
        globalThis.RailWatchRuntime.request = async (endpoint, params) => {
          if (endpoint === 'getTrainCoach' && fail) { fail=false; throw Object.assign(Error('HTTP 403'), {httpStatus:403}); }
          return request(endpoint, params);
        };
      })();`,
    });
  });
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await page.locator('#watchChoices input').nth(1).check();
  await page.getByRole('button', { name: 'Start watch', exact: true }).click();
  await expect(page.locator('#watchStatus')).toContainText('Watch paused');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('#statusText')).toContainText('HTTP 403');
  await expect(page.locator('#watchBannerTitle')).toHaveText('Watch paused');
  await page.getByRole('button', { name: 'Resume watch', exact: true }).click();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.locator('#watchBannerText')).toContainText('Demo match found');
  await expect(page.locator('#bookingSetupDialog')).not.toBeVisible();
  await expect(page.locator('#watchOutcome')).not.toBeVisible();
  await expect(page.locator('#origin')).toBeEnabled();
});

test('train disclosures preserve collapsed selections, keyboard focus and a single modal scroll', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  const first = page.locator('#watchChoices details[data-watch-train="101"]');
  const other = page.locator('#watchChoices details[data-watch-train="103"]');
  await expect(first).toHaveAttribute('open', '');
  await expect(other).not.toHaveAttribute('open');
  await chooseCoach(page, 'outbound', '103');
  await expect(other.locator('summary')).toContainText('1 selected');
  await other.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(other).not.toHaveAttribute('open');
  await first.locator('input').first().check();
  await expect(other).not.toHaveAttribute('open');
  await expect(other.locator('summary')).toContainText('1 selected');
  await expect(first.locator('input').first()).toBeFocused();
  await page.evaluate(() =>
    globalThis.document
      .getElementById('rail-watch-extension')
      .shadowRoot.getElementById('refresh')
      .click(),
  );
  await expect(first.locator('input').first()).toBeEnabled();
  await expect(first.locator('input').first()).toBeFocused();
  await expect(other).not.toHaveAttribute('open');
  await expect(page.locator('#watchChoices')).toHaveCSS('overflow-y', 'visible');
  await expect(first.locator('.watch-choice-copy').first()).toContainText(
    'Class 1 · Sleeper · A/C',
  );
  await expect(first.locator('.watch-choice-description').first()).not.toBeEmpty();
  await page.locator('#watchDatesCalendar').click();
  await page.getByRole('button', { name: 'Watch departure 1/01/2027', exact: true }).click();
  await page.locator('#calendarDone').click();
  await expect(page.locator('#watchChoiceCount')).toHaveText('0 coaches selected');
  await expect(page.getByRole('button', { name: 'Start watch', exact: true })).toBeDisabled();
});

for (const width of [1280, 320]) {
  test(`a match replaces the foreground modal with a persistent result at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard.html?sample=1');
    await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
    await chooseCoach(page, 'outbound', '105', 1);
    await page.getByRole('button', { name: 'Start watch', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Demo seats found', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#watchOutcome')).toBeVisible();
    await expect(page.locator('#watchOutcome')).toBeFocused();
    await expect(page.locator('#bookingSetupFields')).not.toBeVisible();
    await expect(page.locator('#bookingSetupFooter')).not.toBeVisible();
    await expect(page.locator('#watchOutcomeTrips')).toContainText('Train 105');
    await expect(page.locator('#watchOutcomeTrips')).toContainText('1/01/2027');
    await expect(page.locator('#watchOutcomeMessage')).toContainText('No booking was opened');
    await page
      .locator('#watchOutcome')
      .getByRole('button', { name: 'Edit choices', exact: true })
      .focus();
    await page.evaluate(async () => {
      const store = globalThis.RailWatchRuntime.storage.local;
      const saved = await store.get(['railWatchBookingWatch']);
      await store.set(saved);
    });
    await expect(
      page.locator('#watchOutcome').getByRole('button', { name: 'Edit choices', exact: true }),
    ).toBeFocused();
    const size = await page.locator('#bookingSetupDialog').evaluate((el) => ({
      fits: el.scrollWidth === el.clientWidth,
      compact: el.getBoundingClientRect().height < 600,
    }));
    expect(size).toEqual({ fits: true, compact: true });
    await page
      .locator('#watchOutcome')
      .getByRole('button', { name: 'Edit choices', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Booking setup', exact: true })).toBeVisible();
    await expect(page.locator('#bookingTripType')).toBeFocused();
    await expect(page.locator('#watchOutcome')).not.toBeVisible();
    await page.getByRole('button', { name: 'Start watch', exact: true }).click();
    await expect(page.locator('#watchOutcome')).toBeVisible();
    await page.getByRole('button', { name: 'Back to dashboard', exact: true }).click();
    await expect(page.locator('#bookingSetupDialog')).not.toBeVisible();
    await expect(page.locator('#watchBanner')).toBeFocused();
    await page
      .locator('#watchBanner')
      .getByRole('button', { name: 'Edit choices', exact: true })
      .click();
    await expect(page.locator('#watchOutcome')).not.toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('#bookingSetupDialog')).not.toBeVisible();
    await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
    await expect(page.locator('#watchOutcome')).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#watchBanner')).toHaveAttribute('data-state', 'opened');
    const savedWatch = await page.evaluate(
      async () =>
        (await globalThis.RailWatchRuntime.storage.local.get(['railWatchBookingWatch']))
          .railWatchBookingWatch,
    );
    await page.getByRole('button', { name: 'Dismiss watch result', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#watchBanner')).not.toBeVisible();
    await expect(page.locator('#pause')).toBeFocused();
    expect(
      await page.evaluate(
        async () =>
          (await globalThis.RailWatchRuntime.storage.local.get(['railWatchBookingWatch']))
            .railWatchBookingWatch,
      ),
    ).toEqual(savedWatch);
    await page.locator('#pause').click();
    await expect(page.locator('#watchBanner')).not.toBeVisible();
    await page.reload();
    await expect(page.locator('#watchBanner')).not.toBeVisible();
    await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
    await chooseCoach(page, 'outbound', '105', 1);
    await page.getByRole('button', { name: 'Start watch', exact: true }).click();
    await expect(page.locator('#watchOutcome')).toBeVisible();
    await page.getByRole('button', { name: 'Back to dashboard', exact: true }).click();
    await expect(page.locator('#watchBanner')).toBeVisible();
  });
}

test('watch mode uses one visible lock note and suppresses disabled and nested hover help', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await chooseCoach(page, 'outbound', '103');
  await page.getByRole('button', { name: 'Start watch', exact: true }).click();
  await expect(page.locator('#bookingWatchLockHint')).toBeVisible();
  await expect(page.locator('#bookingTripType')).toHaveAttribute(
    'aria-describedby',
    'bookingWatchLockHint',
  );
  for (const selector of ['#bookingTripType', '#watchDatesCalendar', '#passengerMode']) {
    await page.locator(selector).first().hover();
    await expect(page.getByRole('tooltip')).not.toBeVisible();
  }
  await page.locator('#watchChoices label').first().hover();
  await expect(page.getByRole('tooltip')).not.toBeVisible();
  await expect(page.locator('#watchChoices label').first()).toContainText('Sold out');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  for (const selector of ['.route-picker', '#dateRange', '#filter', '#swap']) {
    await page.locator(selector).hover();
    await expect(page.getByRole('tooltip')).not.toBeVisible();
  }
  await expect(page.locator('#swap')).not.toHaveAttribute('title');
  await page.getByRole('button', { name: 'Cancel watch', exact: true }).click();
  await page.locator('#swap').hover();
  await expect(page.getByRole('tooltip')).toHaveText('Swap route');
});

test('starting and cancelling a watch keeps classes and coach detail steady while fresh counts update', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: '1 Jan train 103 fully booked', exact: true }).click();
  await page.evaluate(() => {
    const root = globalThis.document.getElementById('rail-watch-extension').shadowRoot;
    globalThis.originalDetail = root.getElementById('detail').firstElementChild;
    globalThis.originalCoaches = [...root.querySelectorAll('#detail li')];
    globalThis.classBrightness = [];
    globalThis.captureBrightness = true;
    function sample() {
      globalThis.classBrightness.push(
        globalThis.getComputedStyle(root.querySelector('#filter input')).opacity,
      );
      if (globalThis.captureBrightness) globalThis.requestAnimationFrame(sample);
    }
    sample();
    const request = globalThis.RailWatchRuntime.request;
    globalThis.RailWatchRuntime.request = async (endpoint, params) => {
      const result = await request(endpoint, params);
      if (endpoint === 'getTrainCoach') result.data.results[1].availableSeatCount = 2;
      return result;
    };
  });
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await chooseCoach(page, 'outbound', '103');
  await page.getByRole('button', { name: 'Start watch', exact: true }).click();
  await expect(page.locator('#watchStatus')).toContainText('Waiting for 1 seat');
  await expect(page.locator('#watchBanner')).toHaveAttribute('data-state', 'armed');
  await expect(page.locator('#detail .cnt').first()).toHaveText('2');
  await page.locator('#cancelWatch').click();
  await expect(page.locator('#origin')).toBeEnabled();
  const stable = await page.evaluate(() => {
    globalThis.captureBrightness = false;
    const root = globalThis.document.getElementById('rail-watch-extension').shadowRoot;
    return {
      brightness: [...new Set(globalThis.classBrightness)],
      detail: root.getElementById('detail').firstElementChild === globalThis.originalDetail,
      coaches: globalThis.originalCoaches.every((row) => row.isConnected),
    };
  });
  expect(stable).toEqual({ brightness: ['1'], detail: true, coaches: true });
});

test('fresh coach sorting preserves focus on a booking control that remains available', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page
    .getByRole('button', { name: '1 Jan train 101 13 seats available', exact: true })
    .click();
  const coach = page.locator('#detail button[data-book-coach="1003|4|3|4"]');
  await coach.focus();
  await page.evaluate(() => {
    const root = globalThis.document.getElementById('rail-watch-extension').shadowRoot;
    globalThis.focusedCoachBefore = root.activeElement;
    const request = globalThis.RailWatchRuntime.request;
    globalThis.RailWatchRuntime.request = async (endpoint, params) => {
      const result = await request(endpoint, params);
      if (endpoint === 'getTrainCoach') result.data.results[1].availableSeatCount = 20;
      return result;
    };
    root.getElementById('refresh').click();
  });
  await expect(page.locator('#detail .cnt').nth(1)).toHaveText('20');
  await expect(coach).toBeFocused();
  expect(await coach.evaluate((el) => el === globalThis.focusedCoachBefore)).toBe(true);
});

test('availability history displays only low observations, including older saved history', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await expect(page.locator('#availabilityLog tr')).toHaveCount(5);
  await expect(page.locator('#availabilityLog td:last-child')).toHaveText([
    '1',
    '1',
    '2',
    '4',
    '3',
  ]);
  await page.evaluate(async () => {
    await globalThis.RailWatchRuntime.storage.local.set({
      railWatchAvailabilityLog: {
        entries: [
          { at: 0, date: '1/01/2027', train: '101', count: 1 },
          { at: 1, date: '1/01/2027', train: '103', count: 5 },
          { at: 2, date: '1/01/2027', train: '105', count: 6 },
          { at: 3, date: '1/01/2027', train: '107', count: 0 },
        ],
      },
    });
  });
  await expect(page.locator('#availabilityLog tr')).toHaveCount(2);
  await expect(page.locator('#availabilityLog td:last-child')).toHaveText(['1', '5']);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeEnabled();
  const counts = await page.evaluate(async () => {
    const log = (await globalThis.RailWatchRuntime.storage.local.get(['railWatchAvailabilityLog']))
      .railWatchAvailabilityLog;
    return log.entries.map((e) => e.count);
  });
  expect(counts.every((count) => count > 0 && count <= 5)).toBe(true);
});

for (const width of [1280, 320]) {
  test(`one-way multiple departure dates persist and find a later day at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard.html?sample=1');
    await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
    await chooseCoach(page, 'outbound', '103', 1);
    await page.locator('#watchDatesCalendar').click();
    await page.getByRole('button', { name: 'Watch departure 2/01/2027', exact: true }).click();
    await expect(page.locator('#watchChoiceCount')).toHaveText('1 coach selected');
    await expect(page.locator('#calendarDays button[aria-pressed="true"]')).toHaveCount(2);
    await page.locator('#calendarDone').click();
    await page.reload();
    await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
    await expect(page.locator('#watchDatesText')).toHaveText('1 Jan, 2 Jan');
    await page.locator('#watchDatesCalendar').click();
    await expect(page.locator('#calendarDays button[aria-pressed="true"]')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('#watchDatesCalendar')).toBeFocused();
    await expect(page.locator('#watchChoices input:checked')).toHaveCount(1);
    await page.getByRole('button', { name: 'Start watch', exact: true }).click();
    await expect(page.locator('#watchOutcome')).toBeVisible();
    await expect(page.locator('#watchOutcomeTrips')).toContainText('2/01/2027');
    const match = await page.evaluate(
      async () =>
        (await globalThis.RailWatchRuntime.storage.local.get(['railWatchBookingWatch']))
          .railWatchBookingWatch.selected,
    );
    expect(match.date).toBe('2/01/2027');
    expect(match.train).toBe('103');
    await page.locator('#watchOutcomeEdit').click();
    await page.locator('#bookingTripType').selectOption('2');
    await expect(page.locator('#watchDateChoices')).not.toBeVisible();
    await expect(page.locator('#watchDate')).toBeVisible();
  });
}

test('one-way date choices can all be cleared and an active watch locks them until cancellation', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await page.locator('#watchDatesCalendar').click();
  await page.getByRole('button', { name: 'Watch departure 1/01/2027', exact: true }).click();
  await expect(page.locator('#calendarSelection')).toHaveText('0 dates selected');
  await page.locator('#calendarDone').click();
  await expect(page.getByRole('button', { name: 'Start watch', exact: true })).toBeDisabled();
  await page.locator('#watchDatesCalendar').click();
  await page.getByRole('button', { name: 'Watch departure 1/01/2027', exact: true }).click();
  await page.getByRole('button', { name: 'Watch departure 2/01/2027', exact: true }).click();
  await page.locator('#calendarDone').click();
  await chooseCoach(page, 'outbound', '103');
  await page.getByRole('button', { name: 'Start watch', exact: true }).click();
  await expect(page.locator('#watchDatesCalendar').first()).toBeDisabled();
  await page.locator('#cancelWatch').click();
  await expect(page.locator('#watchDatesCalendar').first()).toBeEnabled();
  await expect(page.locator('#watchDatesText')).toHaveText('1 Jan, 2 Jan');
});

test('departure-date keyboard selection survives a background refresh', async ({ page }) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await page.locator('#watchDatesCalendar').click();
  const date = page.getByRole('button', { name: 'Watch departure 2/01/2027', exact: true });
  await date.focus();
  await page.keyboard.press('Space');
  await expect(date).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() =>
    globalThis.document
      .getElementById('rail-watch-extension')
      .shadowRoot.getElementById('refresh')
      .click(),
  );
  await expect(date).toBeEnabled();
  await expect(date).toBeFocused();
  await page.keyboard.press('Space');
  await expect(date).toHaveAttribute('aria-pressed', 'false');
});

test('watch calendar keeps separate dates across months, bounds choices and restores focus', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1&start=2027-01-30&end=2027-02-02');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  const trigger = page.locator('#watchDatesCalendar');
  await trigger.click();
  await expect(page.locator('#calendarMonth')).toHaveText('January 2027');
  await expect(page.locator('#calendarPrev')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Watch departure 29/01/2027', exact: true }),
  ).toBeDisabled();
  const lastJanuary = page.getByRole('button', { name: 'Watch departure 31/01/2027', exact: true });
  await lastJanuary.focus();
  await page.keyboard.press('ArrowRight');
  const february = page.getByRole('button', { name: 'Watch departure 1/02/2027', exact: true });
  await expect(february).toBeFocused();
  await page.keyboard.press('Space');
  await expect(february).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#calendarNext')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Watch departure 3/02/2027', exact: true }),
  ).toBeDisabled();
  await page.locator('#calendarPrev').click();
  await expect(
    page.getByRole('button', { name: 'Watch departure 30/01/2027', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(lastJanuary).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#calendarSelection')).toHaveText('2 dates selected');
  await expect(lastJanuary).toHaveCSS('height', '32px');
  await page.locator('#calendarDone').click();
  await expect(trigger).toBeFocused();
  await expect(page.locator('#watchDatesText')).toHaveText('30 Jan, 1 Feb');
  await page.locator('#bookingSetupDone').click();
  await page.locator('#fromCalendar').click();
  await expect(page.locator('#calendarFooter')).not.toBeVisible();
  await page.getByRole('button', { name: '2027-01-31', exact: true }).click();
  await expect(page.locator('#from')).toHaveValue('2027-01-31');
  await expect(page.locator('#dateCalendar')).not.toBeVisible();
});

test('watch calendar fits a touch viewport with larger day targets', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(test.info().project.use.baseURL + '/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await page.locator('#watchDatesCalendar').click();
  const day = page.getByRole('button', { name: 'Watch departure 2/01/2027', exact: true });
  await expect(day).toHaveCSS('height', '44px');
  const bounds = await page.locator('#dateCalendar').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
  await day.tap();
  await expect(page.locator('#calendarSelection')).toHaveText('2 dates selected');
  await page.locator('#calendarDone').tap();
  await expect(page.locator('#watchDatesText')).toHaveText('1 Jan, 2 Jan');
  await page.locator('#bookingSetupDone').tap();
  await page.locator('#from').fill('2027-04-30');
  await page.locator('#from').dispatchEvent('change');
  await page.locator('#through').fill('2027-05-03');
  await page.locator('#through').dispatchEvent('change');
  await expect(page.getByRole('button', { name: 'Check now', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Booking setup', exact: true }).tap();
  await page.locator('#watchDatesCalendar').tap();
  await expect(page.locator('#calendarMonth')).toHaveText('April 2027');
  const april = await page.locator('#dateCalendar').boundingBox();
  await page.locator('#calendarNext').tap();
  await expect(page.locator('#calendarMonth')).toHaveText('May 2027');
  const may = await page.locator('#dateCalendar').boundingBox();
  expect(may.height).toBeGreaterThan(april.height);
  expect(may.y + may.height).toBeLessThanOrEqual(640);
  await page.locator('#calendarDone').tap();
  await context.close();
});

test('lower-berth preference defaults on, persists off, locks during a watch and reaches Book now', async ({
  page,
}) => {
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  const preference = page.getByRole('checkbox', {
    name: 'Prefer available lower berths in sleepers',
    exact: true,
  });
  await expect(preference).toBeChecked();
  await preference.uncheck();
  await chooseCoach(page, 'outbound', '103');
  await page.reload();
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  await expect(preference).not.toBeChecked();
  await page.getByRole('button', { name: 'Start watch', exact: true }).click();
  await expect(preference).toBeDisabled();
  await expect(preference).not.toBeChecked();
  await expect(page.locator('#outboundQuickSelect')).toBeDisabled();
  await expect(page.locator('#outboundClearChoices')).toBeDisabled();
  const watched = await page.evaluate(
    async () =>
      (await globalThis.RailWatchRuntime.storage.local.get(['railWatchBookingWatch']))
        .railWatchBookingWatch,
  );
  expect(watched.preferLowerBerths).toBe(false);
  await page.locator('#cancelWatch').click();
  await expect(preference).toBeEnabled();
  await quickSelect(page, 'outbound', 'ClearChoices');
  await chooseCoach(page, 'outbound', '101', 1);
  await page.evaluate(() => {
    const runtime = globalThis.RailWatchRuntime.runtime;
    const send = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = (message) => {
      if (message.type === 'rail-watch-booking') globalThis.lastBookingParams = message.params;
      return send(message);
    };
  });
  await page.locator('#bookNow').click();
  await expect(page.locator('#bookNow')).toBeEnabled();
  expect(await page.evaluate(() => globalThis.lastBookingParams.preferLowerBerths)).toBe(false);
});

for (const width of [1280, 320]) {
  test(`quick select actions select across trains, keep existing choices and stay separate on both legs at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard.html?sample=1');
    await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
    await chooseCoach(page, 'outbound', '101', 3);
    const seated = page
      .locator('#watchChoices input[data-train="101"][data-sleeper="false"]')
      .last();
    await quickSelect(page, 'outbound', 'Sleepers');
    const sleepers = page.locator('#watchChoices input[data-sleeper="true"]');
    const count = await sleepers.count();
    expect(count).toBeGreaterThan(1);
    await expect(page.locator('#watchChoices input[data-sleeper="true"]:checked')).toHaveCount(
      count,
    );
    await expect(seated).toBeChecked();
    await expect(page.locator('#watchChoiceCount')).toHaveText(count + 1 + ' coaches selected');
    await quickSelect(page, 'outbound', 'Sleepers');
    await expect(page.locator('#watchChoiceCount')).toHaveText(count + 1 + ' coaches selected');
    await page.locator('#bookingTripType').selectOption('2');
    await expect(page.locator('#returnQuickSelect')).toBeDisabled();
    await page.locator('#loadReturn').click();
    await expect(page.locator('#returnQuickSelect')).toBeEnabled();
    await quickSelect(page, 'return', 'Sleepers');
    const returnCount = await page.locator('#returnChoices input[data-sleeper="true"]').count();
    expect(returnCount).toBeGreaterThan(1);
    await expect(page.locator('#returnChoices input[data-sleeper="true"]:checked')).toHaveCount(
      returnCount,
    );
    await expect(page.locator('#returnChoices input[data-sleeper="false"]:checked')).toHaveCount(0);
    await quickSelect(page, 'return', 'ClearChoices');
    await expect(page.locator('#returnChoices input:checked')).toHaveCount(0);
    await expect(page.locator('#watchChoices input:checked')).toHaveCount(count + 1);
    await quickSelect(page, 'return', 'AllChoices');
    await expect(page.locator('#returnChoices input:checked')).toHaveCount(
      await page.locator('#returnChoices input').count(),
    );
    await quickSelect(page, 'outbound', 'ClearChoices');
    await expect(page.locator('#watchChoices input:checked')).toHaveCount(0);
    await expect(page.locator('#returnChoices input:checked')).toHaveCount(
      await page.locator('#returnChoices input').count(),
    );
    await quickSelect(page, 'outbound', 'AllChoices');
    await expect(page.locator('#watchChoices input:checked')).toHaveCount(
      await page.locator('#watchChoices input').count(),
    );
    await quickSelect(page, 'outbound', 'ClearChoices');
    await expect(page.locator('#bookNow')).toBeDisabled();
  });
}

test('quick select opens by keyboard, restores focus, dismisses cleanly and stays within a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/dashboard.html?sample=1');
  await page.getByRole('button', { name: 'Booking setup', exact: true }).click();
  const trigger = page.locator('#outboundQuickSelect');
  const menu = page.locator('#outboundQuickMenu');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#outboundSleepers')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#outboundAllChoices')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  const count = await page.locator('#watchChoices input').count();
  await expect(page.locator('#watchChoices input:checked')).toHaveCount(count);
  await trigger.click();
  const bounds = await menu.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
  await page.keyboard.press('End');
  await expect(page.locator('#outboundClearChoices')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.locator('#bookingSetupDialog')).toBeVisible();
  await expect(page.locator('#watchChoices input:checked')).toHaveCount(count);
  await trigger.click();
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(page.locator('#bookingSetupDialog')).toBeVisible();
  await trigger.click();
  await trigger.click();
  await expect(menu).not.toBeVisible();
  await trigger.click();
  await page.locator('#bookingMeta').click();
  await expect(menu).not.toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(menu).not.toBeVisible();
  await trigger.click();
  await page.evaluate(() =>
    globalThis.document
      .getElementById('rail-watch-extension')
      .shadowRoot.getElementById('bookingSetupDialog')
      .close(),
  );
  await expect(menu).not.toBeVisible();
});
