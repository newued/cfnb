const { chromium } = require('playwright-core');
const fs = require('fs');

(async () => {
  // Connect to existing Edge browser (port 9222, has proxy access)
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', {
    timeout: 30000,
  });

  const context = browser.contexts()[0];
  const page = await context.newPage();

  // Fetch subscription URL through Edge's network (includes proxy 127.0.0.1:3067)
  await page.goto('https://english2to3gendu-ux.cc.cd/sub/sub-key-001', {
    waitUntil: 'load',
    timeout: 60000,
  });
  await page.waitForTimeout(3000);

  // Get response body (the vless subscription content)
  const bodyText = await page.evaluate(() => document.body.innerText);

  // Save to local file
  fs.writeFileSync('D:\\cfnb\\sub_final.txt', bodyText, 'utf8');
  console.log('Updated sub_final.txt at', new Date().toISOString());
  console.log('Content length:', bodyText.length);
  console.log('Lines:', bodyText.trim().split('\n').length);

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error('Update failed:', e.message);
  process.exit(1);
});
