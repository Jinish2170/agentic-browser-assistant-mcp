// UI review uses a disposable paired profile, never personal tabs or API keys.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withBrowserFixture } from '../tests/browser-fixture.mjs';
import { root } from '../server/config.mjs';

const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
await withBrowserFixture(
  (_request, response) =>
    response.end('<title>Preview workspace</title><main>UI preview fixture</main>'),
  async ({ panel }) => {
    await panel.reload();
    await panel.setViewportSize({ width: 420, height: 900 });
    await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
    await panel.evaluate(() => document.fonts.ready);
    const capture = async (filename) => {
      await panel.mouse.move(0, 0);
      await panel.screenshot({ path: path.join(artifacts, filename), animations: 'disabled' });
    };
    if ((await panel.locator('html').getAttribute('data-theme')) === 'dark')
      await panel.locator('#theme-toggle').click();
    await capture('ui-empty-light.png');
    await panel.locator('#theme-toggle').click();
    await capture('ui-empty-dark.png');
    await panel.locator('#theme-toggle').click();
    await panel.getByRole('tab', { name: 'Activity', exact: true }).click();
    await capture('ui-activity-empty.png');
    await panel.getByRole('tab', { name: 'Memory', exact: true }).click();
    await capture('ui-memory.png');
    await panel.getByRole('tab', { name: 'Settings', exact: true }).click();
    await panel.locator('#settings').evaluate((element) => {
      element.open = true;
    });
    await panel.setViewportSize({ width: 320, height: 900 });
    await capture('ui-settings-narrow.png');
    console.log('Captured five fixture-only workspace previews in artifacts/');
  },
);
