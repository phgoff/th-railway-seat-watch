const { chromium, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.goto(
      'http://127.0.0.1:4371/dashboard.html?sample=1&start=2027-01-01&end=2027-01-06',
    );
    await expect(page.getByText('Demo data', { exact: true })).toBeVisible();
    await expect(page.locator('#matrix tbody tr')).toHaveCount(6);
    await expect(page.locator('.mx-cell')).toHaveCount(18);
    await expect(page.locator('.mx-cell.st-na')).toHaveCount(1);
    await expect(page.locator('.mx-cell.st-low b').filter({ hasText: /^1$/ })).toHaveCount(2);
    await expect(page.locator('#statusText')).toHaveText('Fictional trains, fares and seat counts');
    await page.mouse.move(0, 0);
    const output = path.resolve(__dirname, '../test-results/dashboard.png');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await page.screenshot({ path: output, fullPage: true });
    console.log('Saved ' + path.relative(process.cwd(), output) + ' using fictional demo data.');
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
