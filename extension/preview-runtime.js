(() => {
  if (globalThis.RailWatchRuntime) return;
  const params = new URLSearchParams(location.search);
  const sample = params.get('sample') === '1' || params.has('route');
  const fixture = globalThis.RailWatchPreviewData;
  const capture =
    fixture.captures[params.get('route') === 'reverse' ? 1 : 0] || fixture.captures[0];
  const capturedRows = (capture) =>
    capture.trips.flatMap(({ date, data }) =>
      data.map((trip) => ({
        date,
        train: String(trip.trainNo),
        tripId: String(trip.tripId),
        departure: trip.departureTime,
        arrival: trip.arrivalTime,
        coaches: capture.coaches
          .find((item) => item.date === date && item.tripId === String(trip.tripId))
          .results.map(RailWatchScanner.normalize),
        checkedAt: fixture.capturedAt,
      })),
    );
  const dayISO = (value) => {
    const [day, month, year] = value.split('/');
    return `${year}-${month}-${day.padStart(2, '0')}`;
  };
  const rows = capturedRows(capture);
  const dates = capture.trips.map((item) => dayISO(item.date)).sort();
  const station = (id) => ({
    id,
    name: fixture.stations.find((row) => String(row.stationId) === id).stationNameEn,
  });
  const route = { origin: station(capture.originId), destination: station(capture.destinationId) };
  const selectedRow = rows.find((row) => row.coaches.some((coach) => coach.count > 0)) || rows[0];
  const initialState = {
    schema: 2,
    route,
    data: rows,
    lastCheck: fixture.capturedAt,
    dataFilter: 'all',
    routeResults: Object.fromEntries(
      fixture.captures.map((item) => [
        JSON.stringify([item.originId, item.destinationId, 'all']),
        {
          origin: item.originId,
          destination: item.destinationId,
          filter: 'all',
          data: capturedRows(item),
          lastCheck: fixture.capturedAt,
        },
      ]),
    ),
    from: params.get('start') || dates[0],
    through: params.get('end') || dates[1] || dates[0],
    interval: '900000',
    filter: 'all',
    theme: params.get('theme') || 'dark',
    accent: params.get('accent') || 'brass',
    selected: selectedRow
      ? [params.get('dmy') || selectedRow.date, params.get('train') || selectedRow.train]
      : null,
  };
  const entries = rows
    .map((row) => ({ row, count: row.coaches.reduce((sum, coach) => sum + coach.count, 0) }))
    .filter((item) => item.count > 0 && item.count <= 5)
    .map(({ row, count }) => ({
      at: Date.parse(fixture.capturedAt),
      date: row.date,
      train: row.train,
      count,
      route: route.origin.name + ' → ' + route.destination.name,
      filter: 'all',
    }));
  if (!sample)
    Object.assign(initialState, {
      route: { origin: null, destination: null },
      data: [],
      lastCheck: null,
      routeResults: {},
      from: '',
      through: '',
      selected: null,
    });
  const storageKey =
    'rail-watch-demo-v1-' +
    capture.originId +
    '-' +
    capture.destinationId +
    (sample ? '-sample' : '');
  const seed = {
    railWatch: initialState,
    railWatchAvailabilityLog: { entries: sample ? entries : [] },
  };
  let memory;
  try {
    memory = JSON.parse(localStorage.getItem(storageKey)) || seed;
  } catch {
    memory = seed;
  }
  if (memory.railWatch)
    memory.railWatch.routeResults = {
      ...initialState.routeResults,
      ...memory.railWatch.routeResults,
    };
  const listeners = [];
  const clone = (value) => structuredClone(value);
  const notify = (changes) => listeners.forEach((listener) => listener(changes, 'local'));
  const storage = {
    async get(keys) {
      return Object.fromEntries(
        keys.filter((key) => key in memory).map((key) => [key, clone(memory[key])]),
      );
    },
    async set(values) {
      const changes = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          { oldValue: memory[key], newValue: clone(value) },
        ]),
      );
      Object.assign(memory, clone(values));
      localStorage.setItem(storageKey, JSON.stringify(memory));
      notify(changes);
    },
    async remove(key) {
      const oldValue = memory[key];
      delete memory[key];
      localStorage.setItem(storageKey, JSON.stringify(memory));
      notify({ [key]: { oldValue } });
    },
  };
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey) return;
    const previous = memory;
    try {
      memory = JSON.parse(event.newValue) || {};
    } catch {
      return;
    }
    const keys = new Set([...Object.keys(previous), ...Object.keys(memory)]);
    notify(
      Object.fromEntries(
        [...keys]
          .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(memory[key]))
          .map((key) => [key, { oldValue: previous[key], newValue: memory[key] }]),
      ),
    );
  });
  let watchQueue = Promise.resolve();
  const updateWatch = async (message) => {
    if (message.type === 'rail-watch-arm') {
      const error = RailWatchWatch.validate(message.watch);
      if (error) return { error };
      const stored = await storage.get(['railWatchBookingWatch']);
      if (['armed', 'opening'].includes(stored.railWatchBookingWatch?.status))
        return { error: 'Cancel the active watch before starting another.' };
      const watch = {
        ...clone(message.watch),
        id: crypto.randomUUID(),
        status: 'armed',
        armedAt: Date.now(),
      };
      await storage.set({ railWatchBookingWatch: watch });
      return { ok: true, watch };
    }
    if (['rail-watch-cancel', 'rail-watch-result'].includes(message.type)) {
      let { railWatchBookingWatch: watch } = await storage.get(['railWatchBookingWatch']);
      watch = RailWatchWatch.upgrade(watch);
      if (watch?.id === message.id) {
        if (message.type === 'rail-watch-cancel' && ['armed', 'opening'].includes(watch.status))
          watch = RailWatchWatch.upgrade({ ...watch, status: 'cancelled' });
        else if (message.type === 'rail-watch-result' && watch.status === 'armed') {
          const selected = RailWatchWatch.resolve(watch, message.checks, watch.armedAt);
          if (selected) watch = RailWatchWatch.upgrade({ ...watch, status: 'opened', selected });
        }
        await storage.set({ railWatchBookingWatch: watch });
      }
      return { ok: true, watch };
    }
  };
  globalThis.RailWatchRuntime = {
    mode: 'preview',
    autoOpen: true,
    minimumDate: dates[0],
    storage: { local: storage, onChanged: { addListener: (listener) => listeners.push(listener) } },
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        if (['rail-watch-arm', 'rail-watch-cancel', 'rail-watch-result'].includes(message.type)) {
          watchQueue = watchQueue.catch(() => {}).then(() => updateWatch(message));
          return watchQueue;
        }
        if (message.type === 'rail-watch-booking')
          return {
            message: 'These are demo seats. Open the extension on D-Ticket to book a real coach.',
          };
        if (message.type === 'rail-watch-alerts') {
          const stored = await storage.get(['railWatchAlertSettings', 'railWatchAvailabilityLog']);
          const settings = stored.railWatchAlertSettings || {
            enabled: false,
            trains: '',
            minimum: 1,
          };
          await storage.set({
            railWatchAvailabilityLog: RailWatchAlerts.record(
              message.rows,
              message.config,
              settings,
              stored.railWatchAvailabilityLog || {},
              Date.now(),
              message.routeLabel,
            ),
          });
        }
        return { ok: true };
      },
    },
    async request(endpoint, values) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const routeCapture = fixture.captures.find(
        (item) =>
          item.originId === values.provinceStartId && item.destinationId === values.provinceEndId,
      );
      let data;
      if (endpoint === 'getStation') data = fixture.stations;
      else if (endpoint === 'getTrip')
        data =
          routeCapture?.trips.find((item) => dayISO(item.date) === dayISO(values.dateStart))
            ?.data || [];
      else if (endpoint === 'getTrainCoach')
        data = {
          results:
            routeCapture?.coaches.find((item) => item.tripId === values.tripId)?.results || [],
        };
      else throw Error('Unsupported preview request');
      return { errorCode: 'S_SUCCESS', data: clone(data) };
    },
  };
})();
