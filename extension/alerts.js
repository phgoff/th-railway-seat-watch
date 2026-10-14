(function (scope) {
  function evaluate(rows, config, settings, previous = {}) {
    const trains = new Set(settings.trains.split(/[\s,]+/).filter(Boolean));
    const counts = {},
      hits = [];
    if (!settings.enabled) return { counts, hits };
    for (const row of rows) {
      if (!config.dates.includes(row.date) || (trains.size && !trains.has(row.train))) continue;
      const count = row.coaches
        .filter(
          (c) =>
            config.filter === 'all' ||
            String(config.filter)
              .split(',')
              .some((f) => (f === 'sleep' ? c.type === 'Sleeping Coach' : c.class === f)),
        )
        .reduce((n, c) => n + c.count, 0);
      const key = JSON.stringify([row.date, row.train]);
      counts[key] = count;
      if (count >= settings.minimum && (previous[key] || 0) < settings.minimum)
        hits.push({ date: row.date, train: row.train, count });
    }
    return { counts, hits };
  }
  function record(rows, config, settings, history = {}, at = Date.now(), route = '') {
    const scopeKey = JSON.stringify([
      config.origin,
      config.destination,
      config.dates,
      config.filter,
      settings.trains,
    ]);
    const previous = history.scope === scopeKey ? history.counts : {};
    const result = evaluate(rows, config, { ...settings, enabled: true, minimum: 1 }, previous);
    const entries = Object.entries(result.counts)
      .filter(([key, count]) => count > 0 && count <= 5 && count !== previous[key])
      .map(([key, count]) => {
        const [date, train] = JSON.parse(key);
        return {
          at,
          route,
          origin: config.origin,
          destination: config.destination,
          date,
          train,
          filter: config.filter,
          count,
        };
      });
    return {
      scope: scopeKey,
      counts: result.counts,
      entries: [
        ...entries,
        ...(history.entries || []).filter((entry) => entry.count > 0 && entry.count <= 5),
      ].slice(0, 200),
    };
  }
  scope.RailWatchAlerts = { evaluate, record };
  if (typeof module !== 'undefined') module.exports = scope.RailWatchAlerts;
})(globalThis);
