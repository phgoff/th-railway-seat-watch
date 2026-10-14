/* Shared by content-script tabs. Web Locks release automatically when a tab closes. */
(function (scope) {
  function matches(coach, filter) {
    return (
      filter === 'all' ||
      String(filter)
        .split(',')
        .some((f) => (f === 'sleep' ? coach.type === 'Sleeping Coach' : String(coach.class) === f))
    );
  }
  function normalize(coach) {
    return {
      id: [coach.coachId, coach.coachNo, coach.coachLayoutId, coach.coachTypeId]
        .map((value) => String(value ?? ''))
        .join('|'),
      desc: coach.coachDesc,
      class: String(coach.coachClass),
      type: coach.coachSeatTypeEn,
      air: coach.coachAirTypeEn,
      count: Number(coach.availableSeatCount),
      prices: coach.coachSeats.map((p) => ({ price: Number(p.seatFeeAmt), type: p.seatTypNameEn })),
    };
  }
  function create({ storage, locks, request, now = Date.now }) {
    const scopeKey = (config) =>
      JSON.stringify([2, config.origin, config.destination, config.dates, config.filter]);
    const covers = (result, config) => {
      if (!result) return false;
      try {
        const cached = JSON.parse(result.key),
          requested = JSON.parse(scopeKey(config));
        return (
          JSON.stringify(cached.slice(0, 4)) === JSON.stringify(requested.slice(0, 4)) &&
          (cached[4] === 'all' ||
            String(requested[4])
              .split(',')
              .every((f) => String(cached[4]).split(',').includes(f)))
        );
      } catch {
        return false;
      }
    };
    async function run(task) {
      return locks.request('rail-watch-network', async () => {
        const state = await storage.get(['railWatchTrips', 'railWatchShared', 'railWatchCooldown']);
        const cooldown = state.railWatchCooldown || {};
        const cache = state.railWatchTrips || {};
        let requested = false;
        let networkError = null;
        let rateLimited = false;
        async function api(endpoint, params) {
          if (networkError) throw networkError;
          if (cooldown.until > now())
            throw Object.assign(Error('Rate-limit cooldown'), { retryAt: cooldown.until });
          requested = true;
          try {
            const response = await request(endpoint, params);
            if (response.errorCode !== 'S_SUCCESS') throw Error(response.errorCode);
            return response.data;
          } catch (error) {
            networkError ||= error;
            if (
              error.httpStatus === 429 ||
              /RATE.?LIMIT|TOO.?MANY/i.test(error.message) ||
              (error.httpStatus === 503 && error.retryAt)
            ) {
              const failures = (cooldown.failures || 0) + (rateLimited ? 0 : 1);
              const until = Math.max(
                cooldown.until || 0,
                error.retryAt || 0,
                now() + Math.min(3600000, 300000 * 2 ** (failures - 1)),
              );
              rateLimited = true;
              Object.assign(cooldown, { until, failures });
              networkError.retryAt = until;
              await storage.set({ railWatchCooldown: { ...cooldown } });
              error.retryAt = until;
            }
            throw error;
          }
        }
        async function trips(config, date) {
          const key = JSON.stringify([config.origin, config.destination, date]);
          let entry = cache[key];
          if (!entry || now() - entry.at >= 1800000) {
            const list = await api('getTrip', {
              tripType: '1',
              provinceStartId: config.origin,
              provinceEndId: config.destination,
              dateStart: date,
              dateEnd: '',
            });
            entry = cache[key] = { at: now(), list, topology: {} };
          }
          return { key, entry };
        }
        async function coaches(config, trip, entry, key) {
          try {
            const data = await api('getTrainCoach', {
              tripId: String(trip.tripId),
              provinceStartId: config.origin,
              provinceEndId: config.destination,
            });
            const rows = data.results.map(normalize);
            for (const scan of Object.values(entry.scans || {})) {
              const row = scan.rows.find((row) => row.train === String(trip.trainNo));
              if (row) {
                row.coaches = rows;
                row.checkedAt = new Date(now()).toISOString();
              }
            }
            entry.topology[String(trip.tripId)] = rows.map((c) => ({
              class: c.class,
              type: c.type,
            }));
            return rows;
          } catch (error) {
            networkError ||= error;
            delete cache[key];
            await storage.set({ railWatchTrips: cache });
            throw error;
          }
        }
        let result;
        try {
          result = await task({ state, cache, api, trips, coaches });
        } catch (error) {
          if (rateLimited) {
            error.retryAt = cooldown.until;
            await storage.set({ railWatchCooldown: { ...cooldown } });
          }
          throw error;
        }
        const recent = Object.fromEntries(
          Object.entries(cache)
            .filter(([, value]) => now() - value.at < 1800000)
            .slice(-100),
        );
        await storage.set({
          railWatchTrips: recent,
          ...(requested ? { railWatchCooldown: { until: 0, failures: 0 } } : {}),
        });
        return result;
      });
    }
    return {
      scopeKey,
      covers,
      scan(config, progress = () => {}, { force = false } = {}) {
        return run(async ({ state, trips, coaches }) => {
          const key = scopeKey(config);
          const shared = state.railWatchShared;
          if (
            !force &&
            covers(shared, config) &&
            now() - shared.at < Math.max(300000, config.interval)
          )
            return { ...shared, reused: true };
          const rows = [],
            freshRows = [],
            checked = [];
          let reusedDates = 0;
          for (const date of config.dates) {
            progress(date, rows.length);
            const { key: tripKey, entry } = await trips(config, date);
            const cached = Object.entries(entry.scans || {})
              .filter(([filter, scan]) => {
                return (
                  (filter === 'all' ||
                    config.filter.split(',').every((value) => filter.split(',').includes(value))) &&
                  now() >= scan.at &&
                  now() - scan.at < Math.max(300000, config.interval)
                );
              })
              .sort(([, a], [, b]) => b.at - a.at)[0]?.[1];
            if (!force && cached) {
              rows.push(
                ...cached.rows.filter((row) =>
                  row.coaches.some((coach) => matches(coach, config.filter)),
                ),
              );
              checked.push(cached.at);
              reusedDates++;
              continue;
            }
            const tripsToCheck = entry.list.filter((trip) => {
              const topology = entry.topology[String(trip.tripId)];
              return !topology || topology.some((coach) => matches(coach, config.filter));
            });
            const orderedRows = new Array(tripsToCheck.length);
            let nextTrip = 0;
            let error = null;
            async function worker() {
              while (!error && nextTrip < tripsToCheck.length) {
                const index = nextTrip++;
                const trip = tripsToCheck[index];
                try {
                  const coachRows = await coaches(config, trip, entry, tripKey);
                  if (!coachRows.some((coach) => matches(coach, config.filter))) continue;
                  orderedRows[index] = {
                    date,
                    train: String(trip.trainNo),
                    tripId: String(trip.tripId),
                    departure: trip.departureTime,
                    arrival: trip.arrivalTime,
                    checkedAt: new Date(now()).toISOString(),
                    coaches: coachRows,
                  };
                } catch (failure) {
                  error ||= failure;
                }
              }
            }
            await Promise.all(Array.from({ length: Math.min(2, tripsToCheck.length) }, worker));
            if (error) throw error;
            const dateRows = orderedRows.filter(Boolean);
            const at = dateRows.reduce(
              (oldest, row) => Math.min(oldest, Date.parse(row.checkedAt)),
              now(),
            );
            entry.scans ||= {};
            entry.scans[config.filter] = { at, rows: dateRows };
            rows.push(...dateRows);
            freshRows.push(...dateRows);
            checked.push(at);
          }
          const result = {
            key,
            at: Math.min(now(), ...checked),
            rows,
            ...(reusedDates === config.dates.length ? { reused: true } : { freshRows }),
          };
          await storage.set({ railWatchShared: result });
          return result;
        });
      },
      verify(config, date, train, coach) {
        return run(async ({ state, trips, coaches }) => {
          const { key, entry } = await trips(config, date);
          const trip = entry.list.find((t) => String(t.trainNo) === String(train));
          if (!trip)
            throw Object.assign(Error('This train is no longer listed for that date.'), {
              code: 'RAIL_WATCH_TRAIN_MISSING',
            });
          const rows = await coaches(config, trip, entry, key);
          const selected = rows.find((c) =>
            coach.id
              ? c.id === coach.id
              : c.class === coach.class && c.type === coach.type && c.air === coach.air,
          );
          const checkedAt = new Date(now()).toISOString();
          const shared = state.railWatchShared;
          const sharedScope = shared ? JSON.parse(shared.key) : null;
          if (sharedScope?.[1] === config.origin && sharedScope[2] === config.destination) {
            const row = shared.rows.find((r) => r.date === date && r.train === String(train));
            if (row) {
              row.coaches = rows;
              row.checkedAt = checkedAt;
              await storage.set({ railWatchShared: shared });
            }
          }
          return { available: !!selected && selected.count > 0, coaches: rows, checkedAt };
        });
      },
      stations() {
        return run(({ api }) => api('getStation', { LineId: '' }));
      },
    };
  }
  scope.RailWatchScanner = { create, matches, normalize };
  if (typeof module !== 'undefined') module.exports = scope.RailWatchScanner;
})(typeof globalThis === 'undefined' ? this : globalThis);
