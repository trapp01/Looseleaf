/**
 * The desktop app's update bar, with the shell bridge faked inside the page:
 * the fake says a version is ready as soon as the app listens.
 */
import { expect, test } from '@playwright/test';
import { TestServer, TOKEN } from './server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await TestServer.create();
});
test.afterAll(async () => {
  await server.dispose();
});

/** Runs in the page before the app. Only the update calls do anything. */
function installFakeShell(version: string): void {
  const state = { restarts: 0 };
  (window as unknown as { updateState: typeof state }).updateState = state;
  (window as unknown as { looseleafShell: unknown }).looseleafShell = {
    kind: 'desktop',
    platform: 'linux',
    mirrorFolder: async () => null,
    onMenuCommand: () => () => undefined,
    onUpdateReady: (listener: (version: string) => void) => {
      listener(version);
      return () => undefined;
    },
    restartToUpdate: async () => {
      state.restarts += 1;
    },
  };
}

test('a downloaded update shows a bar that restarts the app or waits for the next quit', async ({ page }) => {
  await page.addInitScript(installFakeShell, '0.1.57');
  await page.goto(server.url);
  await page.getByRole('button', { name: /Connect to a server/ }).click();
  await page.getByLabel('Server address').fill(server.url);
  await page.getByLabel('Access token').fill(TOKEN);
  await page.getByRole('button', { name: 'Connect' }).click();

  const bar = page.locator('.update-bar');
  await expect(bar).toContainText('Version 0.1.57 is ready.');
  await bar.getByRole('button', { name: 'Restart to update' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { updateState: { restarts: number } }).updateState.restarts)).toBe(1);

  await bar.getByRole('button', { name: 'Later' }).click();
  await expect(bar).toBeHidden();
});
