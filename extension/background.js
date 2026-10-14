chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'rail-watch-open' });
  } catch {
    await chrome.tabs.create({ url: 'https://dticket.railway.co.th/DTicketPublicWeb/home/Home' });
  }
});

importScripts('booking.js', 'watch.js');
const passengerKeyPrefix = 'railWatchBookingPassenger_';
const passengerAlarmPrefix = 'rail-watch-passenger-';
async function cleanupPassengerHandoffs(closedTabId) {
  const records = await chrome.storage.session.get(null);
  for (const [key, record] of Object.entries(records)) {
    if (!key.startsWith(passengerKeyPrefix)) continue;
    const alarm = passengerAlarmPrefix + key.slice(passengerKeyPrefix.length);
    if (
      !Number.isFinite(record?.expires) ||
      record.expires <= Date.now() ||
      !Number.isInteger(record?.tabId) ||
      record.tabId === closedTabId ||
      RailWatchBooking.validatePassengers(record.passengers)
    ) {
      await chrome.storage.session.remove(key);
      await chrome.alarms.clear(alarm);
    } else {
      await chrome.alarms.create(alarm, { when: record.expires });
    }
  }
}
async function cleanupStoredWatch() {
  const { railWatchBookingWatch: watch } = await chrome.storage.local.get([
    'railWatchBookingWatch',
  ]);
  if (watch) {
    await chrome.storage.local.set({ railWatchBookingWatch: RailWatchWatch.upgrade(watch) });
  }
}
let bookingQueue = cleanupPassengerHandoffs()
  .then(cleanupStoredWatch)
  .catch(() => {});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(passengerAlarmPrefix)) return;
  bookingQueue = bookingQueue.catch(() => {}).then(() => cleanupPassengerHandoffs());
});
chrome.tabs.onRemoved.addListener((tabId) => {
  bookingQueue = bookingQueue.catch(() => {}).then(() => cleanupPassengerHandoffs(tabId));
});
async function openBooking(params, passengers) {
  const target = Object.fromEntries(
    [
      'provinceStartId',
      'provinceEndId',
      'dateStart',
      'trainNo',
      'coachId',
      'autoFill',
      'preferLowerBerths',
    ]
      .filter((key) => params[key] !== undefined)
      .map((key) => [key, params[key]]),
  );
  if (params.returnLeg) {
    const error = RailWatchBooking.validateReturn(target.dateStart, params.returnLeg);
    if (error || !/^\d+\|\d+\|\d+\|\d+$/.test(target.coachId))
      throw Error(error || 'Choose an outbound coach.');
    target.returnLeg = Object.fromEntries(
      ['date', 'train', 'coachId'].map((key) => [key, params.returnLeg[key]]),
    );
  }
  target.expires = Date.now() + 120000;
  target.seatCount = passengers?.length || params.seatCount || 1;
  if (!Number.isInteger(target.seatCount) || target.seatCount < 1 || target.seatCount > 4)
    throw Error('Choose 1–4 passengers.');
  let key;
  let tab;
  try {
    if (passengers) {
      const error = RailWatchBooking.validatePassengers(passengers);
      if (error) throw Error(error);
      target.bookingId = crypto.randomUUID();
      key = passengerKeyPrefix + target.bookingId;
      await chrome.storage.session.set({ [key]: { passengers, expires: target.expires } });
    }
    tab = await chrome.tabs.create({
      url:
        'https://dticket.railway.co.th/DTicketPublicWeb/home/Home#rail-watch-search=' +
        encodeURIComponent(JSON.stringify(target)),
    });
    if (key) {
      if (!Number.isInteger(tab?.id)) throw Error('Cannot identify booking tab.');
      await chrome.storage.session.set({
        [key]: { passengers, expires: target.expires, tabId: tab.id },
      });
      await chrome.alarms.create(passengerAlarmPrefix + target.bookingId, { when: target.expires });
    }
    return tab;
  } catch (error) {
    if (key) {
      await chrome.storage.session.remove(key);
      await chrome.alarms.clear(passengerAlarmPrefix + target.bookingId);
      if (Number.isInteger(tab?.id)) await chrome.tabs.remove(tab.id);
    }
    throw error;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'rail-watch-booking') return;
  const p = message.params || {};
  if (
    !sender.url?.startsWith('https://dticket.railway.co.th/DTicketPublicWeb/') ||
    !/^\d+$/.test(p.provinceStartId) ||
    !/^\d+$/.test(p.provinceEndId) ||
    !RailWatchBooking.day(p.dateStart) ||
    !/^\d+$/.test(p.trainNo) ||
    (p.autoFill !== undefined && typeof p.autoFill !== 'boolean') ||
    (p.preferLowerBerths !== undefined && typeof p.preferLowerBerths !== 'boolean')
  ) {
    respond({ error: 'Invalid booking destination' });
    return;
  }
  bookingQueue = bookingQueue.catch(() => {}).then(() => openBooking(p, message.passengers));
  bookingQueue.then(
    () => respond({ ok: true }),
    (error) => respond({ error: error.message }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    !['rail-watch-arm', 'rail-watch-cancel', 'rail-watch-result', 'rail-watch-passenger'].includes(
      message?.type,
    )
  )
    return;
  if (!sender.url?.startsWith('https://dticket.railway.co.th/DTicketPublicWeb/')) {
    respond({ error: 'Invalid watch sender' });
    return;
  }
  const task = async () => {
    if (message.type === 'rail-watch-passenger') {
      if (typeof message.bookingId !== 'string' || !/^[\w-]{1,100}$/.test(message.bookingId))
        throw Error('Invalid booking ID');
      if (
        !Number.isInteger(sender.tab?.id) ||
        new URL(sender.url).pathname !== '/DTicketPublicWeb/booking/booking'
      )
        throw Error('Invalid passenger sender');
      const key = passengerKeyPrefix + message.bookingId;
      const record = (await chrome.storage.session.get([key]))[key];
      if (
        !record ||
        !Number.isFinite(record.expires) ||
        record.expires <= Date.now() ||
        !Number.isInteger(record.tabId) ||
        RailWatchBooking.validatePassengers(record.passengers)
      ) {
        await chrome.storage.session.remove(key);
        await chrome.alarms.clear(passengerAlarmPrefix + message.bookingId);
        throw Error('Passenger handoff expired. Fill the passenger on D-Ticket.');
      }
      if (record.tabId !== sender.tab.id) throw Error('Invalid passenger sender');
      return { passengers: record.passengers };
    }
    let { railWatchBookingWatch: watch } = await chrome.storage.local.get([
      'railWatchBookingWatch',
    ]);
    watch = RailWatchWatch.upgrade(watch);
    if (message.type === 'rail-watch-arm') {
      const error = RailWatchWatch.validate(message.watch);
      if (error) throw Error(error);
      if (watch?.status === 'armed' || watch?.status === 'opening')
        throw Error('Cancel the active watch before starting another.');
      watch = { ...message.watch, id: crypto.randomUUID(), status: 'armed', armedAt: Date.now() };
      await chrome.storage.local.set({ railWatchBookingWatch: watch });
    } else if (watch?.id === message.id) {
      if (message.type === 'rail-watch-cancel' && ['armed', 'opening'].includes(watch.status)) {
        watch = RailWatchWatch.upgrade({ ...watch, status: 'cancelled' });
        await chrome.storage.local.set({ railWatchBookingWatch: watch });
      } else if (message.type === 'rail-watch-result' && watch.status === 'armed') {
        const selected = RailWatchWatch.resolve(watch, message.checks, watch.armedAt);
        if (!selected) return { watch };
        watch = { ...watch, status: 'opening', selected };
        await chrome.storage.local.set({ railWatchBookingWatch: watch });
        try {
          const tab = await openBooking(
            {
              provinceStartId: watch.origin,
              provinceEndId: watch.destination,
              dateStart: selected.date || watch.date,
              trainNo: selected.train,
              coachId: selected.coachId,
              returnLeg: selected.returnLeg,
              autoFill: true,
              preferLowerBerths: watch.preferLowerBerths,
            },
            watch.passengers,
          );
          watch = RailWatchWatch.upgrade({ ...watch, status: 'opened', tabId: tab?.id });
        } catch (error) {
          watch = RailWatchWatch.upgrade({ ...watch, status: 'error', error: error.message });
        }
        await chrome.storage.local.set({ railWatchBookingWatch: watch });
      }
    }
    return { watch };
  };
  bookingQueue = bookingQueue.catch(() => {}).then(task);
  bookingQueue.then(
    (result) => respond({ ok: true, ...result }),
    (error) => respond({ error: error.message }),
  );
  return true;
});

importScripts('alerts.js');
let alertQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'rail-watch-alerts') return;
  if (!sender.url?.startsWith('https://dticket.railway.co.th/DTicketPublicWeb/')) {
    respond({ error: 'Invalid notification sender' });
    return;
  }
  const task = async () => {
    const {
      railWatchAlertSettings: settings = { enabled: false, trains: '', minimum: 1 },
      railWatchAlertHistory: history = {},
      railWatchAvailabilityLog: log = {},
    } = await chrome.storage.local.get([
      'railWatchAlertSettings',
      'railWatchAlertHistory',
      'railWatchAvailabilityLog',
    ]);
    const config = message.config;
    if (!Array.isArray(message.rows) || !Array.isArray(config?.dates))
      throw Error('Invalid alert results');
    await chrome.storage.local.set({
      railWatchAvailabilityLog: RailWatchAlerts.record(
        message.rows,
        config,
        settings,
        log,
        Date.now(),
        message.routeLabel,
      ),
    });
    if (!settings.enabled) return;
    if ((await chrome.notifications.getPermissionLevel()) !== 'granted')
      throw Error(
        'Notifications are blocked. Allow notifications for your browser. Availability history still saves seat counts.',
      );
    const scope = JSON.stringify([
      config.origin,
      config.destination,
      config.dates,
      config.filter,
      settings.trains,
      settings.minimum,
    ]);
    const result = RailWatchAlerts.evaluate(
      message.rows,
      config,
      settings,
      history.scope === scope ? history.counts : {},
    );
    if (result.hits.length) {
      const description = result.hits
        .slice(0, 5)
        .map((h) => `${h.date} · Train ${h.train}: ${h.count} available`)
        .join('\n');
      await chrome.notifications.create('rail-watch-availability', {
        type: 'basic',
        iconUrl: 'icon.png',
        title:
          'Seats available · ' +
          (config.filter === 'all'
            ? 'All classes'
            : config.filter === 'sleep'
              ? 'Sleeper'
              : 'Classes ' + config.filter.replaceAll(',', ', ')),
        message: description + (result.hits.length > 5 ? `\n+${result.hits.length - 5} more` : ''),
        contextMessage: message.routeLabel,
      });
    }
    await chrome.storage.local.set({ railWatchAlertHistory: { scope, counts: result.counts } });
  };
  alertQueue = alertQueue.catch(() => {}).then(task);
  alertQueue.then(
    () => respond({ ok: true }),
    (error) => respond({ error: error.message }),
  );
  return true;
});
chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('rail-watch-')) return;
  const tabs = await chrome.tabs.query({ url: 'https://dticket.railway.co.th/DTicketPublicWeb/*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'rail-watch-open' }).catch(() => {});
  } else
    await chrome.tabs.create({ url: 'https://dticket.railway.co.th/DTicketPublicWeb/home/Home' });
});
