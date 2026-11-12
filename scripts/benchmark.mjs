import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridge } from '../server/bridge.mjs';
import { defaults, root } from '../server/config.mjs';
import { Settings } from '../server/settings.mjs';

const samples = Number(process.env.JEV_BENCH_SAMPLES || 10);
assert(Number.isInteger(samples) && samples >= 3 && samples <= 100);
const label = process.argv[2] || 'baseline';
assert(/^[a-z0-9-]+$/.test(label));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'jev-benchmark-'));
let context, bridge, client;
const fixture = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><title>Agent benchmark</title><style>
  body{font:16px system-ui;margin:0;display:grid;grid-template-columns:240px 1fr}
  nav{height:90vh;overflow:auto}nav a{display:block;padding:8px}
  main{padding:32px}input,button{padding:12px;margin:8px}
  </style><nav>${Array.from({ length: 1000 }, (_, i) => `<a href="#item-${i}">Archived item ${i}</a>`).join('')}</nav>
  <main><h1>Benchmark workspace</h1><p>Fill the form and verify its result.</p>
  <input aria-label="Project name" id="project"><input aria-label="Owner" id="owner">
  <button id="save" onclick="document.querySelector('output').textContent='Saved: '+document.querySelector('#project').value">Save</button><output></output></main>`);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const config = {
  ...structuredClone(defaults),
  port: 0,
  token: 'fixture-benchmark-token-'.repeat(3),
};
const configFile = path.join(temporary, 'config.json');
const startClient = async () => {
  const result = new Client({ name: 'jev-benchmark', version: '0.4.1' });
  await result.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'server/mcp.mjs')],
      env: { ...process.env, JEV_CONFIG: configFile },
    }),
  );
  return result;
};
const decode = (result) => {
  assert(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content.find((item) => item.type === 'text').text);
};
const measure = async (action, prepare) => {
  const values = [];
  let result;
  for (let i = 0; i < samples; i++) {
    await prepare?.(i);
    const began = performance.now();
    result = await action(i);
    values.push(performance.now() - began);
  }
  values.sort((a, b) => a - b);
  return {
    samples,
    medianMs: +values[Math.floor(values.length / 2)].toFixed(2),
    p95Ms: +values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)].toFixed(2),
    resultBytes: Buffer.byteLength(JSON.stringify(result)),
    ...(result?.imageBytes ? { imageBytes: result.imageBytes, mimeType: result.mimeType } : {}),
  };
};
try {
  const settings = new Settings(config, path.join(temporary, 'secrets.json'), configFile);
  bridge = await createBridge(config, { settings });
  await bridge.listen();
  config.port = bridge.server.address().port;
  await writeFile(configFile, JSON.stringify(config));
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${path.join(root, 'dist/extension')}`,
      `--load-extension=${path.join(root, 'dist/extension')}`,
      '--no-sandbox',
    ],
    viewport: { width: 1100, height: 900 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(origin);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.evaluate(async ({ port, token }) => {
    const response = await chrome.runtime.sendMessage({
      type: 'pair',
      connection: { url: `http://127.0.0.1:${port}`, token },
    });
    if (response.error) throw new Error(response.error);
  }, config);
  await panel
    .locator('#connection-status')
    .filter({ hasText: 'Connected to local bridge' })
    .waitFor();
  client = await startClient();
  const call = async (name, args = {}) => decode(await client.callTool({ name, arguments: args }));
  const tabs = (await call('browser_tabs')).tabs;
  const tabId = tabs.find((tab) => tab.url === `${origin}/`).id;
  const report = {
    label,
    measuredAt: new Date().toISOString(),
    node: process.version,
    browser: context.browser()?.version() || 'Chromium persistent context',
    samples,
    fixture: '1000 sidebar links and two-field form',
    metrics: {},
  };
  report.metrics.persistentStatus = await measure(() => call('browser_status'));
  report.metrics.coldStatus = await measure(async () => {
    const cold = await startClient();
    try {
      return decode(await cold.callTool({ name: 'browser_status', arguments: {} }));
    } finally {
      await cold.close();
    }
  });
  report.metrics.fullSnapshot = await measure(() =>
    call('browser_snapshot', { tabId, maxText: 12000 }),
  );
  report.metrics.actionAndSnapshot = await measure(async () => {
    await call('browser_type', { tabId, selector: '#project', text: 'Benchmark project' });
    return call('browser_snapshot', { tabId, maxText: 12000 });
  });
  report.metrics.scopedSnapshot = await measure(() =>
    call('browser_snapshot', { tabId, scopeSelector: 'main' }),
  );
  if (process.env.JEV_BENCH_JPEG === '1')
    report.metrics.scopedWithoutFrames = await measure(() =>
      call('browser_snapshot', { tabId, scopeSelector: 'main', includeFrames: false }),
    );
  report.metrics.actionAndScopedSnapshot = await measure(async () => {
    await call('browser_type', { tabId, selector: '#project', text: 'Benchmark project' });
    return call('browser_snapshot', { tabId, scopeSelector: 'main' });
  });
  report.metrics.individualFormFields = await measure(async () => {
    await call('browser_type', { tabId, selector: '#project', text: 'Benchmark project' });
    await call('browser_type', { tabId, selector: '#owner', text: 'Benchmark owner' });
    return call('browser_snapshot', { tabId, scopeSelector: 'main' });
  });
  report.metrics.compoundFormFields = await measure(() =>
    call('browser_fill_form', {
      tabId,
      fields: [
        { kind: 'text', selector: '#project', value: 'Benchmark project' },
        { kind: 'text', selector: '#owner', value: 'Benchmark owner' },
      ],
      observation: { scopeSelector: 'main' },
    }),
  );
  report.metrics.compoundAction = await measure(() =>
    call('browser_step', {
      tabId,
      action: { name: 'browser_type', args: { selector: '#project', text: 'Benchmark project' } },
      observation: { scopeSelector: 'main' },
    }),
  );
  const resetFields = (project, owner = '') =>
    page.evaluate(
      ({ project, owner }) => {
        document.querySelector('#project').value = project;
        document.querySelector('#owner').value = owner;
      },
      { project, owner },
    );
  report.metrics.typeEmptyField = await measure(
    () => call('browser_type', { tabId, selector: '#project', text: 'Benchmark project' }),
    () => resetFields(''),
  );
  report.metrics.typeExistingField = await measure(
    () => call('browser_type', { tabId, selector: '#project', text: 'Benchmark project' }),
    () => resetFields('Previous project'),
  );
  const formArguments = {
    tabId,
    fields: [
      { kind: 'text', selector: '#project', value: 'Benchmark project' },
      { kind: 'text', selector: '#owner', value: 'Benchmark owner' },
    ],
    observation: { scopeSelector: 'main' },
  };
  report.metrics.fillEmptyFields = await measure(
    () => call('browser_fill_form', formArguments),
    () => resetFields(''),
  );
  report.metrics.fillUnchangedFields = await measure(
    () => call('browser_fill_form', formArguments),
    () => resetFields('Benchmark project', 'Benchmark owner'),
  );
  for (const [format, name] of [
    ['png', 'screenshotPNG'],
    ...(process.env.JEV_BENCH_JPEG === '1' ? [['jpeg', 'screenshotJPEG']] : []),
  ]) {
    report.metrics[name] = await measure(async () => {
      const result = await client.callTool({
        name: 'browser_screenshot',
        arguments: { tabId, ...(format === 'jpeg' ? { format, quality: 80 } : {}) },
      });
      assert(!result.isError, result.content?.[0]?.text);
      const captured = result.content.find((item) => item.type === 'image');
      assert(captured);
      return {
        mimeType: captured.mimeType,
        imageBytes: Buffer.from(captured.data, 'base64').length,
      };
    });
  }
  if (process.env.JEV_BENCH_JPEG === '1') {
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.id = 'texture-benchmark';
      canvas.width = 1000;
      canvas.height = 800;
      canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:1000';
      const context = canvas.getContext('2d');
      const pixels = context.createImageData(canvas.width, canvas.height);
      let seed = 20261005;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const grain = ((seed >>> 24) - 128) * 0.35;
        const x = (i / 4) % canvas.width,
          y = Math.floor(i / 4 / canvas.width);
        pixels.data[i] = 110 + 65 * Math.sin(x / 70) + grain;
        pixels.data[i + 1] = 130 + 50 * Math.cos(y / 90) + grain;
        pixels.data[i + 2] = 140 + 60 * Math.sin((x + y) / 120) + grain;
        pixels.data[i + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      document.body.append(canvas);
    });
    try {
      for (const format of ['png', 'jpeg'])
        report.metrics[`textureScreenshot${format.toUpperCase()}`] = await measure(async () => {
          const result = await client.callTool({
            name: 'browser_screenshot',
            arguments: { tabId, format, ...(format === 'jpeg' ? { quality: 80 } : {}) },
          });
          assert(!result.isError);
          const captured = result.content.find((item) => item.type === 'image');
          return {
            mimeType: captured.mimeType,
            imageBytes: Buffer.from(captured.data, 'base64').length,
          };
        });
    } finally {
      await page.evaluate(() => document.querySelector('#texture-benchmark').remove());
    }
  }
  const observation = await call('browser_snapshot', { tabId, maxText: 12000 });
  assert(
    observation.elements.some((el) => el.name === 'Project name'),
    'Main form must have an actionable ref',
  );
  const text = observation.text;
  report.largePageFindsMainTask = text.includes('Benchmark workspace');
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const output = path.join(artifacts, `benchmark-${label}.json`);
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Benchmark saved: ${output}`);
} finally {
  await client?.close();
  await context?.close();
  await bridge?.close();
  await new Promise((resolve) => fixture.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
