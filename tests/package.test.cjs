const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const project = path.resolve(__dirname, '..');

test('the ZIP is reproducible, excludes local files, and starts from its extracted contents', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-watch-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['build-extension.py', 'dashboard.html', 'extension', 'fixtures', 'LICENSE']) {
    fs.cpSync(path.join(project, name), path.join(directory, name), { recursive: true });
  }
  fs.writeFileSync(
    path.join(directory, 'extension', '.env'),
    'TEST_ONLY=never-package-local-files\n',
  );
  fs.writeFileSync(path.join(directory, 'fixtures', 'local-private.json'), '{"testOnly":true}\n');
  const build = () =>
    execFileSync('python3', ['build-extension.py'], { cwd: directory, stdio: 'pipe' });
  const archive = path.join(directory, 'railway-seat-watch-extension.zip');
  build();
  const first = fs.readFileSync(archive);
  fs.utimesSync(path.join(directory, 'extension', 'manifest.json'), 123456789, 123456789);
  build();
  assert.deepEqual(fs.readFileSync(archive), first);
  const extract = path.join(directory, 'unpacked');
  const names = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps(z.namelist())); z.extractall(sys.argv[2])',
        archive,
        extract,
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(names, [
    'extension/LICENSE',
    'extension/README.md',
    'extension/alerts.js',
    'extension/background.js',
    'extension/booking.js',
    'extension/bridge.js',
    'extension/calendar.js',
    'extension/content.js',
    'extension/icon.png',
    'extension/icon.svg',
    'extension/manifest.json',
    'extension/scanner.js',
    'extension/ui.js',
    'extension/watch.js',
  ]);
  const packagedManifest = JSON.parse(
    fs.readFileSync(path.join(extract, 'extension', 'manifest.json')),
  );
  assert.equal(
    packagedManifest.version,
    JSON.parse(fs.readFileSync(path.join(directory, 'extension', 'manifest.json'))).version,
  );
  for (const icon of [
    ...Object.values(packagedManifest.icons),
    packagedManifest.action.default_icon,
  ])
    assert.ok(fs.statSync(path.join(extract, 'extension', icon)).size > 0);
  execFileSync('node', ['--test', path.join(project, 'tests', 'startup.test.cjs')], {
    cwd: extract,
    stdio: 'pipe',
  });
});
