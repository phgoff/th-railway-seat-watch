const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../extension/alerts.js');
const config = { dates: ['20/10/2026'], filter: '1' };
const settings = { enabled: true, trains: '38, 32', minimum: 1 };
const rows = [
  {
    date: '20/10/2026',
    train: '38',
    coaches: [
      { class: '1', count: 1 },
      { class: '3', count: 10 },
    ],
  },
  { date: '20/10/2026', train: '170', coaches: [{ class: '1', count: 4 }] },
  { date: '21/10/2026', train: '32', coaches: [{ class: '1', count: 4 }] },
];
test('alerts match dates, selected trains and class, and deduplicate until seats return', () => {
  const first = evaluate(rows, config, settings);
  assert.deepEqual(first.hits, [{ date: '20/10/2026', train: '38', count: 1 }]);
  assert.deepEqual(evaluate(rows, config, settings, first.counts).hits, []);
  const sold = evaluate(
    [
      {
        ...rows[0],
        coaches: [
          { class: '1', count: 0 },
          { class: '3', count: 10 },
        ],
      },
    ],
    config,
    settings,
    first.counts,
  );
  assert.deepEqual(sold.hits, []);
  assert.equal(evaluate(rows, config, settings, sold.counts).hits.length, 1);
});
test('minimum seat threshold and disabled alerts are respected', () => {
  assert.deepEqual(evaluate(rows, config, { ...settings, minimum: 2 }).hits, []);
  assert.deepEqual(evaluate(rows, config, { ...settings, enabled: false }).hits, []);
  assert.equal(evaluate(rows, config, { ...settings, trains: '' }).hits.length, 2);
});
test('combined classes count first and second class seats while excluding third class', () => {
  const result = evaluate(
    [
      {
        date: '20/10/2026',
        train: '38',
        coaches: [
          { class: '1', count: 1 },
          { class: '2', count: 2 },
          { class: '3', count: 10 },
        ],
      },
    ],
    { ...config, filter: '1,2' },
    { ...settings, minimum: 3 },
  );
  assert.deepEqual(result.hits, [{ date: '20/10/2026', train: '38', count: 3 }]);
});
test('availability log works with alerts off and records changed counts or returning seats', () => {
  const { record } = require('../extension/alerts.js');
  const disabled = { ...settings, enabled: false };
  const first = record(rows, config, disabled, {}, 1000, 'Hat Yai → Bangkok');
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].count, 1);
  assert.equal(first.entries[0].at, 1000);
  const unchanged = record(rows, config, disabled, structuredClone(first), 2000);
  assert.equal(unchanged.entries.length, 1);
  const changedRows = [{ ...rows[0], coaches: [{ class: '1', count: 2 }] }];
  const changed = record(changedRows, config, disabled, unchanged, 3000);
  assert.equal(changed.entries.length, 2);
  assert.equal(changed.entries[0].count, 2);
  const sold = record(
    [{ ...rows[0], coaches: [{ class: '1', count: 0 }] }],
    config,
    disabled,
    changed,
    4000,
  );
  const returned = record(rows, config, disabled, sold, 5000);
  assert.equal(returned.entries.length, 3);
});
test('availability log keeps only the latest 200 entries', () => {
  const { record } = require('../extension/alerts.js');
  let history = {};
  for (let n = 1; n <= 205; n++)
    history = record(
      [{ ...rows[0], coaches: [{ class: '1', count: (n % 5) + 1 }] }],
      config,
      settings,
      history,
      n,
    );
  assert.equal(history.entries.length, 200);
  assert.equal(history.entries[0].at, 205);
  assert.equal(history.entries.at(-1).at, 6);
});

test('explicitly selecting no trains suppresses alerts while all and subsets still produce hits', () => {
  assert.deepEqual(evaluate(rows, config, { ...settings, trains: 'none' }), {
    counts: {},
    hits: [],
  });
  assert.deepEqual(evaluate(rows, config, { ...settings, trains: '170' }).hits, [
    { date: '20/10/2026', train: '170', count: 4 },
  ]);
  assert.deepEqual(evaluate(rows, config, { ...settings, trains: '' }).hits, [
    { date: '20/10/2026', train: '38', count: 1 },
    { date: '20/10/2026', train: '170', count: 4 },
  ]);
});

test('history keeps only changed low counts, including returning from plentiful seats', () => {
  const { record } = require('../extension/alerts.js');
  const all = { ...settings, enabled: false, trains: '', minimum: 20 };
  const observations = [0, 1, 5, 6, 100].map((count) => ({
    ...rows[0],
    train: String(count),
    coaches: [{ class: '1', count }],
  }));
  const first = record(observations, config, all, {}, 1);
  assert.deepEqual(
    first.entries.map((entry) => entry.count),
    [1, 5],
  );
  assert.equal(first.counts[JSON.stringify([config.dates[0], '100'])], 100);
  let history = record(
    [{ ...rows[0], coaches: [{ class: '1', count: 1 }] }],
    config,
    settings,
    {},
    1,
  );
  history = record(
    [{ ...rows[0], coaches: [{ class: '1', count: 6 }] }],
    config,
    settings,
    history,
    2,
  );
  assert.equal(history.entries.length, 1);
  history = record(
    [{ ...rows[0], coaches: [{ class: '1', count: 1 }] }],
    config,
    settings,
    history,
    3,
  );
  assert.deepEqual(
    history.entries.map((entry) => entry.at),
    [3, 1],
  );
  history = record(
    [{ ...rows[0], coaches: [{ class: '1', count: 1 }] }],
    config,
    settings,
    {
      ...history,
      entries: [...history.entries, { count: 60, at: 0 }],
    },
    4,
  );
  assert.equal(history.entries.length, 2);
});
