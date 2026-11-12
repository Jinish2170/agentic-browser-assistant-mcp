import { BROWSER_PROTOCOL } from '../shared/protocol.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createBridge } from '../server/bridge.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults } from '../server/config.mjs';
import { request as httpRequest } from 'node:http';

const token = 'test-token-'.repeat(8);
const id = 'a'.repeat(32);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const config = { ...structuredClone(defaults), token, port: 0 };
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jev-bridge-test-'));
  const settings = {
    configFile: path.join(temp, 'config.json'),
    load: async () => {},
    key: () => '',
    publicView: () => ({ provider: {}, jev: {} }),
  };
  const bridge = await createBridge(config, { settings });
  await bridge.listen();
  config.port = bridge.server.address().port;
  const url = `http://127.0.0.1:${config.port}`;
  const request = (path, options = {}) =>
    fetch(url + path, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...options,
    });
  return { bridge, config, url, request };
}

async function pair(url, apiKey = token, protocol = BROWSER_PROTOCOL) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/extension', {
    origin: `chrome-extension://${id}`,
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({ type: 'auth', token: apiKey, extensionId: id, protocol, version: '0.4.0' }),
  );
  return ws;
}

test('bridge refuses unauthenticated HTTP, hostile Origin and Host', async () => {
  const { bridge, url, request } = await fixture();
  try {
    assert.equal((await fetch(url + '/status')).status, 401);
    assert.equal(
      (
        await request('/status', {
          headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(
        url + '/status',
        { headers: { Authorization: `Bearer ${token}`, Host: 'evil.test' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(hostileHostStatus, 403);
    const status = await (await request('/status')).json();
    assert.equal(status.connected, false);
    assert.equal(JSON.stringify(status).includes(token), false);
  } finally {
    await bridge.close();
  }
});

test('authenticated extension round-trip validates commands and preserves returned screenshots', async () => {
  const { bridge, url, request } = await fixture();
  try {
    const ws = await pair(url);
    ws.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'command')
        ws.send(
          JSON.stringify({
            type: 'result',
            id: message.id,
            result: { image: { mimeType: 'image/png', data: 'abc' } },
          }),
        );
    });
    for (let i = 0; !bridge.browser.connected && i < 100; i++) await wait(5);
    const result = await request('/command', {
      method: 'POST',
      body: JSON.stringify({ name: 'browser_screenshot', args: { tabId: 1 } }),
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).result.image.data, 'abc');
    const invalid = await request('/command', {
      method: 'POST',
      body: JSON.stringify({
        name: 'browser_navigate',
        args: { tabId: 1, url: 'javascript:alert(1)' },
      }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await bridge.close();
  }
});

test('invalid WebSocket token is rejected; concurrent browser profiles are not mixed', async () => {
  const { bridge, url } = await fixture();
  try {
    const bad = await pair(url, 'bad');
    const badCode = await new Promise((resolve) => bad.once('close', resolve));
    assert.equal(badCode, 1008);
    await pair(url);
    for (let i = 0; !bridge.browser.connected && i < 100; i++) await wait(5);
    const second = await pair(url);
    const secondCode = await new Promise((resolve) => second.once('close', resolve));
    assert.equal(secondCode, 1008);
  } finally {
    await bridge.close();
  }
});

test('timeout has an unknown outcome and is never automatically retried', async () => {
  const { bridge, url } = await fixture();
  let actions = 0;
  try {
    const ws = await pair(url);
    ws.on('message', (bytes) => {
      if (JSON.parse(bytes.toString()).type === 'command') actions++;
    });
    for (let i = 0; !bridge.browser.connected && i < 100; i++) await wait(5);
    await assert.rejects(
      bridge.browser.command(
        { name: 'browser_click', args: { tabId: 1, x: 10, y: 10 } },
        { timeoutMs: 20 },
      ),
      /COMMAND_TIMEOUT/,
    );
    await wait(30);
    assert.equal(actions, 1);
    assert.equal(bridge.browser.connected, false);
  } finally {
    await bridge.close();
  }
});

test('batch overlaps distinct tabs, validates all inputs before dispatch and locks each tab', async () => {
  const { bridge, url } = await fixture();
  const received = [];
  let release;
  try {
    const ws = await pair(url);
    ws.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.type !== 'command') return;
      received.push(message);
      if (received.length === 2)
        release = () =>
          received.forEach((entry) =>
            ws.send(
              JSON.stringify({
                type: 'result',
                id: entry.id,
                result: { tabId: entry.command.args.tabId },
              }),
            ),
          );
    });
    for (let i = 0; !bridge.browser.connected && i < 100; i++) await wait(5);
    await assert.rejects(
      bridge.browser.command({
        name: 'browser_batch',
        args: {
          commands: [
            { name: 'browser_click', args: { tabId: 1, x: 10, y: 10 } },
            { name: 'browser_navigate', args: { tabId: 2, url: 'javascript:bad()' } },
          ],
        },
      }),
    );
    assert.equal(received.length, 0);
    await assert.rejects(
      bridge.browser.command({
        name: 'browser_batch',
        args: {
          commands: [
            { name: 'browser_snapshot', args: { tabId: 1 } },
            { name: 'browser_snapshot', args: { tabId: 1 } },
          ],
        },
      }),
      /BATCH_DEPENDENCY/,
    );
    const batch = bridge.browser.command({
      name: 'browser_batch',
      args: {
        commands: [
          { name: 'browser_snapshot', args: { tabId: 1 } },
          { name: 'browser_snapshot', args: { tabId: 2 } },
        ],
      },
    });
    for (let i = 0; !release && i < 100; i++) await wait(5);
    assert.equal(received.length, 2, 'Both tab commands must arrive before either result');
    await assert.rejects(
      bridge.browser.command({ name: 'browser_snapshot', args: { tabId: 1 } }),
      /BROWSER_BUSY/,
    );
    release();
    assert.deepEqual(
      (await batch).results.map((entry) => entry.result.tabId),
      [1, 2],
    );
  } finally {
    await bridge.close();
  }
});

test('legacy extension reports a reload requirement and dispatches no updated commands', async () => {
  for (const protocol of [1, 2, 3]) {
    const { bridge, url, request } = await fixture();
    try {
      const ws = await pair(url, token, protocol);
      let commands = 0;
      ws.on('message', (bytes) => {
        if (JSON.parse(bytes).type === 'command') commands++;
      });
      for (let i = 0; !bridge.browser.connected && i < 100; i++) await wait(5);
      const status = await (await request('/status')).json();
      assert.equal(status.extensionNeedsReload, true);
      await assert.rejects(
        bridge.browser.command({ name: 'browser_click', args: { tabId: 1, x: 10, y: 10 } }),
        /EXTENSION_UPDATE_REQUIRED/,
      );
      assert.equal(commands, 0);
    } finally {
      await bridge.close();
    }
  }
});

test('pre-input boundary metadata survives extension WebSocket and HTTP without inferring from text', async () => {
  const { bridge, url, request } = await fixture();
  const ws = await pair(url);
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.type === 'command')
      ws.send(
        JSON.stringify({
          type: 'result',
          id: message.id,
          error: 'ELEMENT_OCCLUDED: overlay',
          mutationOutcome: 'not_dispatched',
        }),
      );
  });
  try {
    for (let i = 0; !bridge.browser.connected && i < 30; i++) await wait(5);
    const response = await request('/command', {
      method: 'POST',
      body: JSON.stringify({ name: 'browser_click', args: { tabId: 1, x: 10, y: 10 } }),
    });
    const receipt = await response.json();
    assert.equal(response.status, 400);
    assert.equal(receipt.mutationOutcome, 'not_dispatched');
  } finally {
    ws.close();
    await bridge.close();
  }
});
