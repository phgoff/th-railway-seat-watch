import { defineConfig } from '@playwright/test';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (!process.env.RAIL_WATCH_TEST_PORT) {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  process.env.RAIL_WATCH_TEST_PORT = String(listener.address().port);
  await new Promise((resolve) => listener.close(resolve));
}
const port = Number(process.env.RAIL_WATCH_TEST_PORT);
const outputDir = (process.env.RAIL_WATCH_BROWSER_OUTPUT ||= `test-results/${randomUUID()}`);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  outputDir,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  use: { baseURL, headless: true },
  webServer: {
    command: `python3 -m http.server ${port} --bind 127.0.0.1`,
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    stderr: 'ignore',
    url: baseURL,
    reuseExistingServer: false,
  },
});
