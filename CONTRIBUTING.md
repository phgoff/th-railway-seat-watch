# Contribute to Railway Seat Watch

Use Node.js 24 and Python 3.10 or later. The JavaScript tools require Node.js 22.13 or later. The extension itself has no package dependencies.

## Set up development tools

Run these commands from the repository root:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-dev.txt
npm ci --ignore-scripts
npx playwright install chromium
```

On Windows, activate the environment with `.venv\Scripts\activate`. Keep the environment active when you run the development commands.

## Change and verify the app

1. Edit the sources listed in [AGENTS.md](AGENTS.md).
2. Run `npm run format` to format JavaScript, HTML, JSON, documentation, workflows, and Python.
3. Run `npm run check` to lint, check formatting, build the ZIP, and run the tests.
4. Inspect the diff, including generated files. Commit generated outputs with their sources.
5. Load the `extension` folder in a Chromium browser, reload the extension, and refresh D-Ticket.

Browser checks use a temporary Chromium profile and fictional demo data. On Linux, use `npx playwright install --with-deps chromium` to install its system dependencies.

The tests cover scans, cache reuse, rate limits, dates, alerts, booking, passenger handoffs, watches, and packaged startup. Release tests use temporary repositories and a local bare remote. They do not push this repository or publish releases.

For the demo, run `python3 -m http.server 4371 --bind 127.0.0.1` and open `http://127.0.0.1:4371/dashboard.html`. Use fictional passenger details when testing. State whether you checked the demo or a live signed-in D-Ticket session in your PR.

Before opening a PR, reproduce any bug and verify its fix. Keep tests that exercise observable results or protect a safety boundary. Avoid assertions about implementation spelling. Do not include real passenger details, cookies, or tokens in issues, screenshots, fixtures, or logs.

## Check availability from the console

Paste `scan-availability.js` into the D-Ticket console, then run `await scanAvailability()` to check the current route and date. The tool runs one scan.

## Publish a ZIP release

1. From a branch with committed changes, run `python3 release.py` to release the next patch
   version, or `python3 release.py --minor` / `--major` for feature or breaking releases.
   The command versions `extension/manifest.json` and `package.json` together, builds and
   tests the ZIP, updates the main checkout, pushes `main`, and pushes the matching `v*` tag.
2. Pushing the tag runs the **Publish ZIP release** workflow. It verifies the tagged commit
   and attaches the ZIP and SHA-256 checksum to the GitHub release. To publish again after a
   failed run, dispatch the workflow from GitHub Actions and enter the matching tag.
3. Download the ZIP and SHA-256 checksum from GitHub Releases.

The workflow builds and tests the selected commit before publishing. The version tag must
match the manifest, and a published version is never replaced.
