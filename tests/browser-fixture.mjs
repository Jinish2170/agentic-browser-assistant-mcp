import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridge } from '../server/bridge.mjs';
import { Settings } from '../server/settings.mjs';
import { defaults, root } from '../server/config.mjs';

export async function withBrowserFixture(handler, run) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'jev-corpus-'));
  const fixture = createServer((request, response) =>
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500);
      response.end(error.message);
    }),
  );
  let context, bridge, client;
  try {
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const config = {
      ...structuredClone(defaults),
      port: 0,
      token: 'fixture-corpus-token-'.repeat(3),
    };
    const configFile = path.join(temporary, 'config.json');
    bridge = await createBridge(config, {
      settings: new Settings(config, path.join(temporary, 'secrets.json'), configFile),
    });
    await bridge.listen();
    config.port = bridge.server.address().port;
    await writeFile(configFile, JSON.stringify(config));
    const extension = path.join(temporary, 'extension');
    await cp(path.join(root, 'dist/extension'), extension, { recursive: true });
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        '--no-sandbox',
      ],
      viewport: { width: 1100, height: 900 },
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`);
    await panel.evaluate(async ({ port, token }) => {
      const result = await chrome.runtime.sendMessage({
        type: 'pair',
        connection: { url: `http://127.0.0.1:${port}`, token },
      });
      if (result.error) throw new Error(result.error);
    }, config);
    client = new Client({ name: 'jev-corpus', version: '0.4.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, 'server/mcp.mjs')],
        env: { ...process.env, JEV_CONFIG: configFile },
      }),
    );
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert(!result.isError, result.content?.[0]?.text);
      return JSON.parse(result.content.find((item) => item.type === 'text').text);
    };
    for (let i = 0; !(await call('browser_status')).connected && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert((await call('browser_status')).connected);
    return await run({ call, origin, context, panel, bridge, config, configFile });
  } finally {
    await client?.close();
    await context?.close();
    await bridge?.close();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
}
