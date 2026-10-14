const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');

function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rail watch release ')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const main = path.join(temporary, 'main checkout');
  fs.mkdirSync(main);
  for (const name of [
    '.gitignore',
    'LICENSE',
    'README.md',
    'AGENTS.md',
    'dashboard.html',
    'build-extension.py',
    'release.py',
    'scan-availability.js',
    'package.json',
    'extension',
    'fixtures',
    'tests',
  ]) {
    fs.cpSync(path.join(project, name), path.join(main, name), {
      recursive: true,
      filter: (file) => path.basename(file) !== 'release.test.cjs',
    });
  }
  const manifestPath = path.join(main, 'extension/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = '1.0.0';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const packagePath = path.join(main, 'package.json');
  const developmentPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  developmentPackage.version = '1.0.0';
  fs.writeFileSync(packagePath, JSON.stringify(developmentPackage, null, 2) + '\n');
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(main, 'init', '--initial-branch=main');
  git(main, 'config', 'user.email', 'release-test@example.invalid');
  git(main, 'config', 'user.name', 'Release test');
  git(main, 'config', 'commit.gpgsign', 'false');
  git(main, 'config', 'core.hooksPath', '/dev/null');
  git(main, 'add', '.');
  git(main, 'commit', '-m', 'Initial extension');
  git(main, 'tag', 'v1.0.0');
  const remote = path.join(temporary, 'remote.git');
  git(main, 'init', '--bare', '--initial-branch=main', remote);
  git(main, 'remote', 'add', 'origin', remote);
  git(main, 'push', '-u', 'origin', 'main');
  const feature = path.join(temporary, 'feature checkout');
  git(main, 'worktree', 'add', '-b', 'fix/startup', feature);
  fs.writeFileSync(path.join(feature, 'release-proof.txt'), 'Committed feature\n');
  git(feature, 'add', 'release-proof.txt');
  git(feature, 'commit', '-m', 'Feature ready for release');
  return {
    main,
    feature,
    remote,
    git,
    version: () => JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version,
    packageVersion: () => JSON.parse(fs.readFileSync(packagePath, 'utf8')).version,
  };
}

test('one release command versions, checks the ZIP, updates the main checkout and pushes once', (t) => {
  const h = fixture(t);
  const output = execFileSync('python3', ['release.py'], {
    cwd: h.feature,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.match(output, /Released 1\.0\.1 to origin\/main/);
  assert.ok(output.includes('Extension folder: ' + path.join(h.main, 'extension')));
  assert.equal(h.version(), '1.0.1');
  assert.equal(h.packageVersion(), '1.0.1');
  assert.equal(
    fs.readFileSync(path.join(h.main, 'release-proof.txt'), 'utf8'),
    'Committed feature\n',
  );
  const commit = h.git(h.main, 'rev-parse', 'HEAD');
  assert.equal(h.git(h.main, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], commit);
  assert.equal(h.git(h.main, 'ls-remote', 'origin', 'refs/tags/v1.0.1').split(/\s+/)[0], commit);
  assert.equal(h.git(h.main, 'status', '--porcelain'), '');
  assert.equal(h.git(h.feature, 'status', '--porcelain'), '');
  const repeat = spawnSync('python3', ['release.py'], { cwd: h.feature, encoding: 'utf8' });
  assert.equal(repeat.status, 1);
  assert.match(repeat.stderr, /No committed changes to release/);
  assert.equal(h.version(), '1.0.1');
  assert.equal(h.git(h.main, 'rev-parse', 'HEAD'), commit);
  fs.writeFileSync(path.join(h.main, 'user-notes.txt'), 'Preserve this work\n');
  const dirty = spawnSync('python3', ['release.py'], { cwd: h.feature, encoding: 'utf8' });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /uncommitted files/);
  assert.equal(
    fs.readFileSync(path.join(h.main, 'user-notes.txt'), 'utf8'),
    'Preserve this work\n',
  );
});

test('release flags publish the next minor or major version in both versioned files', (t) => {
  for (const [flag, expected] of [
    ['--minor', '1.1.0'],
    ['--major', '2.0.0'],
  ]) {
    const h = fixture(t);
    const output = execFileSync('python3', ['release.py', flag], {
      cwd: h.feature,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.match(output, new RegExp(`Released ${expected.split('.').join('\\.')} to origin/main`));
    assert.equal(h.version(), expected);
    assert.equal(h.packageVersion(), expected);
  }
});

test('a release versions merged pull request work sitting on origin main', (t) => {
  const h = fixture(t);
  h.git(h.main, 'checkout', '-b', 'merged-pr');
  fs.writeFileSync(path.join(h.main, 'pr-notes.md'), 'Merged through a pull request\n');
  h.git(h.main, 'add', 'pr-notes.md');
  h.git(h.main, 'commit', '-m', 'Merged change');
  h.git(h.main, 'push', 'origin', 'merged-pr:main');
  h.git(h.main, 'checkout', 'main');
  h.git(h.main, 'merge', '--ff-only', 'origin/main');
  const output = execFileSync('python3', ['release.py'], {
    cwd: h.main,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.match(output, /Released 1\.0\.1 to origin\/main/);
  assert.equal(h.version(), '1.0.1');
  assert.equal(h.packageVersion(), '1.0.1');
  const commit = h.git(h.main, 'rev-parse', 'HEAD');
  assert.equal(h.git(h.main, 'ls-remote', 'origin', 'refs/tags/v1.0.1').split(/\s+/)[0], commit);
  assert.equal(h.git(h.main, 'status', '--porcelain'), '');
});

test('release flags refuse to re-version an unpublished checked release', (t) => {
  const h = fixture(t);
  const hook = path.join(h.remote, 'hooks/pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const rejected = spawnSync('python3', ['release.py'], { cwd: h.feature, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /hook declined/);
  fs.rmSync(hook);
  const refused = spawnSync('python3', ['release.py', '--major'], {
    cwd: h.feature,
    encoding: 'utf8',
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already checked/);
  assert.equal(h.version(), '1.0.1');
  assert.equal(h.packageVersion(), '1.0.1');
});

test('a missing packaged booking helper stops the release before committing, merging or pushing', (t) => {
  const h = fixture(t);
  const before = h.git(h.main, 'rev-parse', 'HEAD');
  fs.appendFileSync(
    path.join(h.feature, 'build-extension.py'),
    `
package_path = root / 'railway-seat-watch-extension.zip'
with zipfile.ZipFile(package_path) as package:
    entries = [(name, package.read(name)) for name in package.namelist() if name != 'extension/booking.js']
with zipfile.ZipFile(package_path, 'w') as package:
    for name, data in entries:
        package.writestr(name, data)
`,
  );
  h.git(h.feature, 'add', 'build-extension.py');
  h.git(h.feature, 'commit', '-m', 'Reproduce missing packaged helper');
  const featureBefore = h.git(h.feature, 'rev-parse', 'HEAD');
  const failure = spawnSync('python3', ['release.py'], { cwd: h.feature, encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /Package missing: extension\/booking\.js/);
  assert.equal(h.git(h.feature, 'rev-parse', 'HEAD'), featureBefore);
  assert.equal(h.git(h.main, 'rev-parse', 'HEAD'), before);
  assert.equal(h.git(h.main, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], before);
  assert.equal(h.version(), '1.0.0');
});

test('retrying a rejected push publishes the checked commit without a second version bump', (t) => {
  const h = fixture(t);
  const hook = path.join(h.remote, 'hooks/pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const rejected = spawnSync('python3', ['release.py'], { cwd: h.feature, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /hook declined/);
  const checkedCommit = h.git(h.main, 'rev-parse', 'HEAD');
  assert.equal(h.version(), '1.0.1');
  fs.rmSync(hook);
  const retried = execFileSync('python3', ['release.py'], {
    cwd: h.feature,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.match(retried, /Retrying the unpublished 1\.0\.1 release/);
  assert.equal(h.version(), '1.0.1');
  assert.equal(h.git(h.main, 'rev-parse', 'HEAD'), checkedCommit);
  assert.equal(
    h.git(h.main, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0],
    checkedCommit,
  );
  assert.equal(
    h.git(h.main, 'ls-remote', 'origin', 'refs/tags/v1.0.1').split(/\s+/)[0],
    checkedCommit,
  );
});

test('a rejected tag push is finished by rerunning the release command', (t) => {
  const h = fixture(t);
  const hook = path.join(h.remote, 'hooks/pre-receive');
  fs.writeFileSync(
    hook,
    '#!/bin/sh\ninput=$(cat)\ncase "$input" in *refs/heads/*) exit 0;; *) exit 1;; esac\n',
    { mode: 0o755 },
  );
  const rejected = spawnSync('python3', ['release.py'], { cwd: h.feature, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /hook declined/);
  const pushedCommit = h.git(h.main, 'rev-parse', 'HEAD');
  assert.equal(h.version(), '1.0.1');
  assert.equal(
    h.git(h.main, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0],
    pushedCommit,
  );
  assert.equal(h.git(h.main, 'ls-remote', 'origin', 'refs/tags/v1.0.1'), '');
  fs.rmSync(hook);
  const finished = execFileSync('python3', ['release.py'], {
    cwd: h.feature,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.match(finished, /Retrying the unpublished 1\.0\.1 release/);
  assert.equal(h.version(), '1.0.1');
  assert.equal(h.git(h.main, 'rev-parse', 'HEAD'), pushedCommit);
  assert.equal(
    h.git(h.main, 'ls-remote', 'origin', 'refs/tags/v1.0.1').split(/\s+/)[0],
    pushedCommit,
  );
  assert.equal(h.git(h.feature, 'status', '--porcelain'), '');
});

function workflowCommand(name) {
  const workflow = fs.readFileSync(path.join(project, '.github/workflows/release.yml'), 'utf8');
  const step = workflow.slice(workflow.indexOf(`      - name: ${name}\n`));
  const command = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length);
  const lines = command.split('\n');
  return lines
    .slice(
      0,
      lines.findIndex((line) => !line.startsWith('          ')),
    )
    .map((line) => line.slice(10))
    .join('\n');
}

function releaseArchive(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railway workflow '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'extension'));
  fs.writeFileSync(path.join(directory, 'extension/manifest.json'), '{"version":"1.0.0"}');
  execFileSync(
    'python3',
    [
      '-c',
      "import zipfile; z=zipfile.ZipFile('railway-seat-watch-extension.zip','w'); z.write('extension/manifest.json'); z.close()",
    ],
    { cwd: directory },
  );
  const archive = fs.readFileSync(path.join(directory, 'railway-seat-watch-extension.zip'));
  const digest = require('node:crypto').createHash('sha256').update(archive).digest('hex');
  fs.writeFileSync(
    path.join(directory, 'railway-seat-watch-extension.zip.sha256'),
    `${digest}  railway-seat-watch-extension.zip\n`,
  );
  fs.writeFileSync(
    path.join(directory, 'gh'),
    `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync('publication.json', JSON.stringify({args: process.argv.slice(2), notes: fs.readFileSync('release-notes.md', 'utf8')}));\n`,
    { mode: 0o755 },
  );
  return directory;
}

function runWorkflow(command, directory, env) {
  return new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn('bash', ['-e', '-c', command], {
      cwd: directory,
      env: { ...process.env, ...env, PATH: directory + path.delimiter + process.env.PATH },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
  });
}

test('manual release metadata accepts the manifest version and rejects invalid or mismatched tags', async (t) => {
  const directory = releaseArchive(t);
  const output = path.join(directory, 'outputs');
  const command = workflowCommand('Validate release metadata');
  const result = await runWorkflow(command, directory, {
    RELEASE_TAG: 'v1.0.0',
    GITHUB_OUTPUT: output,
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(output, 'utf8'), 'tag=v1.0.0\nversion=1.0.0\n');
  for (const tag of ['v1.0.1', 'v01.0.0', 'refs/heads/main', 'v1.0.0; touch injected']) {
    const rejected = await runWorkflow(command, directory, {
      RELEASE_TAG: tag,
      GITHUB_OUTPUT: output,
    });
    assert.equal(rejected.status, 1, tag);
  }
  assert.equal(fs.existsSync(path.join(directory, 'injected')), false);
  assert.equal(fs.readFileSync(output, 'utf8'), 'tag=v1.0.0\nversion=1.0.0\n');
});

async function publicationFixture(t, state = {}) {
  const directory = releaseArchive(t);
  const commit = 'a'.repeat(40);
  const requests = [];
  const server = require('node:http').createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ method: request.method, url: request.url, data });
    let value;
    let status = 200;
    if (state.unavailable) {
      status = 503;
    } else if (request.url.endsWith('/releases/tags/v1.0.0')) {
      value = state.published ? { id: 7 } : null;
    } else if (request.url.endsWith('/git/ref/tags/v1.0.0')) {
      value = state.target ? { object: state.target } : null;
    } else if (request.url.includes('/git/tags/')) {
      value = { object: { type: 'commit', sha: state.annotatedCommit || commit } };
    } else if (request.url.endsWith('/git/refs') && request.method === 'POST') {
      value = { object: { type: 'commit', sha: data.sha } };
    } else {
      status = 500;
    }
    response.writeHead(value == null && status === 200 ? 404 : status, {
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    GH_TOKEN: 'fictional-test-token',
    GH_REPO: 'example/railway',
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    RELEASE_TAG: 'v1.0.0',
    RELEASE_VERSION: '1.0.0',
    RELEASE_COMMIT: commit,
    RELEASE_ARTIFACT: '314',
    RELEASE_RUN: 'https://github.com/example/railway/actions/runs/42',
  };
  return {
    directory,
    commit,
    requests,
    env,
    command: workflowCommand('Publish the verified archive'),
  };
}

test('manual publication creates a missing tag at the verified commit and publishes the checked ZIP', async (t) => {
  const h = await publicationFixture(t);
  const result = await runWorkflow(h.command, h.directory, h.env);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(
    h.requests.find((request) => request.method === 'POST'),
    {
      method: 'POST',
      url: '/repos/example/railway/git/refs',
      data: { ref: 'refs/tags/v1.0.0', sha: h.commit },
    },
  );
  const publication = JSON.parse(fs.readFileSync(path.join(h.directory, 'publication.json')));
  assert.deepEqual(publication.args, [
    'release',
    'create',
    'v1.0.0',
    '--verify-tag',
    '--target',
    h.commit,
    '--title',
    'Railway Seat Watch v1.0.0',
    '--generate-notes',
    '--notes-file',
    'release-notes.md',
    'railway-seat-watch-extension.zip',
    'railway-seat-watch-extension.zip.sha256',
  ]);
  assert.equal(
    publication.notes,
    `Version \`1.0.0\`. Verified commit \`${h.commit}\`. Artifact ID \`314\`.\n\n[Verification and ZIP artifact](https://github.com/example/railway/actions/runs/42).\n`,
  );
});

for (const type of ['commit', 'tag']) {
  test(`manual publication preserves an existing ${type} tag at the verified commit`, async (t) => {
    const h = await publicationFixture(t, { target: { type, sha: 'a'.repeat(40) } });
    const result = await runWorkflow(h.command, h.directory, h.env);
    assert.equal(result.status, 0, result.output);
    assert.equal(h.requests.filter((request) => request.method !== 'GET').length, 0);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(h.directory, 'publication.json'))).args[2],
      'v1.0.0',
    );
  });
}

for (const [name, state, change, message] of [
  ['published tag', { published: true }, {}, /release already exists/],
  [
    'tag at another commit',
    { target: { type: 'commit', sha: 'b'.repeat(40) } },
    {},
    /does not target the verified commit/,
  ],
  [
    'annotated tag at another commit',
    { target: { type: 'tag', sha: 'b'.repeat(40) }, annotatedCommit: 'c'.repeat(40) },
    {},
    /does not target the verified commit/,
  ],
  ['short commit SHA', {}, { RELEASE_COMMIT: 'aaaaaaa' }, /full verified commit SHA/],
  [
    'archive version mismatch',
    {},
    { RELEASE_VERSION: '1.0.1', RELEASE_TAG: 'v1.0.1' },
    /Archive and verified manifest version differ/,
  ],
  ['API failure', { unavailable: true }, {}, /503/],
]) {
  test(`manual publication rejects ${name} before publishing or changing refs`, async (t) => {
    const h = await publicationFixture(t, state);
    const result = await runWorkflow(h.command, h.directory, { ...h.env, ...change });
    assert.notEqual(result.status, 0);
    assert.match(result.output, message);
    assert.deepEqual(
      h.requests.filter((request) => request.method !== 'GET'),
      [],
    );
    assert.equal(fs.existsSync(path.join(h.directory, 'publication.json')), false);
  });
}

test('manual publication rejects an altered ZIP before checking or changing remote state', async (t) => {
  const h = await publicationFixture(t);
  fs.appendFileSync(path.join(h.directory, 'railway-seat-watch-extension.zip'), 'altered');
  const result = await runWorkflow(h.command, h.directory, h.env);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /FAILED/);
  assert.deepEqual(h.requests, []);
  assert.equal(fs.existsSync(path.join(h.directory, 'publication.json')), false);
});
