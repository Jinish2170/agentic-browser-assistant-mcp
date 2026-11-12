import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, readFile, cp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../server/bridge.mjs';
import { defaults } from '../server/config.mjs';
import { Settings } from '../server/settings.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'jev-e2e-'));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
let context, mcp, bridge;
let mockCalls = 0;
const fixtureHtml = await readFile(path.join(root, 'tests/fixtures/workflow.html'), 'utf8');
const fixture = createServer(async (request, response) => {
  if (request.url === '/slow-page') {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<title>Slow resource fixture</title><p>Early state is available</p><img src="/slow-resource">',
    );
    return;
  }
  if (request.url === '/slow-resource') {
    setTimeout(() => response.end('slow resource'), 2000);
    return;
  }
  if (request.url === '/file.txt') {
    response.setHeader('Content-Disposition', 'attachment; filename=test.txt');
    response.end('test file');
    return;
  }
  if (request.url === '/frame') {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      `<title>Frame</title><button id="frame-button" onclick="document.querySelector('p').textContent=event.isTrusted ? 'Frame clicked' : 'Untrusted click'">Frame button</button><p></p><input id="frame-input" aria-label="Frame input"><script>window.inputEvents=[];for(const type of ['mousemove','mousedown','mouseup','click']) document.addEventListener(type,e=>inputEvents.push({type,target:e.target.id,x:e.clientX,y:e.clientY,buttons:e.buttons,trusted:e.isTrusted}));</script>`,
    );
    return;
  }
  if (request.url.startsWith('/nested')) {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<title>Nested frame</title><iframe style="margin:20px;border:4px solid purple;transform:scale(.8);transform-origin:top left" src="/frame"></iframe>',
    );
    return;
  }
  if (request.url.startsWith('/diagnostic.json')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ message: 'captured-response-fixture' }));
    return;
  }
  if (request.url === '/v1/responses') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (mockCalls === 0) await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(input.model, 'fixture-model');
    const actions = [
      [
        'browser_type',
        { tabId: globalThis.testTabId, selector: '#project', text: 'Agent project' },
      ],
      ['browser_select', { tabId: globalThis.testTabId, selector: '#priority', value: 'urgent' }],
      ['browser_click', { tabId: globalThis.testTabId, selector: '#save' }],
      [
        'finish_task',
        {
          summary: 'Created the requested test project.',
          evidence: 'Saved request: Agent project (urgent)',
          success: true,
        },
      ],
    ];
    const [name, args] = actions[mockCalls++];
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: `call-${mockCalls}`,
            name,
            arguments: JSON.stringify(args),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    );
    return;
  }
  if (request.url === '/jev') {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        model: 'fixture-jev',
        answers: {
          decision: {
            type: 'choice',
            choice: 'dom',
            probabilities: { dom: 0.96, vision: 0.02, both: 0.02 },
            confidence: 0.94,
          },
        },
      }),
    );
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(fixtureHtml);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;

try {
  const extension = path.join(temp, 'extension');
  await cp(path.join(root, 'dist/extension'), extension, { recursive: true });
  const config = {
    ...structuredClone(defaults),
    port: 0,
    token: 'fixture-pairing-token-'.repeat(4),
    provider: { ...defaults.provider, model: 'fixture-model', baseUrl: `${origin}/v1` },
    jev: { ...defaults.jev, enabled: true, endpoint: `${origin}/jev` },
    uploadRoots: [temp],
  };
  const configFile = path.join(temp, 'config.json');
  const settings = new Settings(config, path.join(temp, 'secrets.json'), configFile);
  settings.key = (_env, kind) => `${kind}-fixture-key`;
  bridge = await createBridge(config, { settings });
  await bridge.listen();
  config.port = bridge.server.address().port;
  await writeFile(configFile, JSON.stringify(config));
  const base = `http://127.0.0.1:${config.port}`;
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-sandbox',
    ],
    viewport: { width: 1100, height: 900 },
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const webpage = await context.newPage();
  await webpage.goto(origin);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.setViewportSize({ width: 420, height: 900 });
  await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
  await panel.locator('#chat-empty').waitFor();
  await panel.locator('[data-prompt]').first().click();
  assert((await panel.locator('#goal').inputValue()).length > 10);
  await panel.locator('#goal').fill('');
  await panel.evaluate(() => document.fonts.ready);
  await panel.screenshot({
    path: path.join(artifacts, 'ui-empty-light.png'),
    animations: 'disabled',
  });
  await panel.locator('#theme-toggle').click();
  assert.equal(await panel.locator('html').getAttribute('data-theme'), 'dark');
  await panel.screenshot({
    path: path.join(artifacts, 'ui-empty-dark.png'),
    animations: 'disabled',
  });
  await panel.reload();
  assert.equal(await panel.locator('html').getAttribute('data-theme'), 'dark');
  await panel.locator('#theme-toggle').click();
  await panel.getByRole('tab', { name: 'Chat', exact: true }).focus();
  await panel.keyboard.press('End');
  assert.equal(
    await panel.getByRole('tab', { name: 'Settings', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await panel.setViewportSize({ width: 320, height: 900 });
  assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.screenshot({
    path: path.join(artifacts, 'ui-settings-narrow.png'),
    animations: 'disabled',
  });
  await panel.setViewportSize({ width: 420, height: 900 });
  console.log(
    'PASS: workspace keyboard navigation, starter controls, theme persistence and narrow layout',
  );
  await panel.locator('#bridge-url').fill(base);
  await panel.locator('#pair-token').fill(config.token);
  await panel.locator('#pair-form button').click();
  await panel
    .locator('#connection-status')
    .filter({ hasText: 'Connected to local bridge' })
    .waitFor();
  const defaultAccess = (await api('/command', 'POST', { name: 'browser_capabilities', args: {} }))
    .result;
  assert.equal(defaultAccess.allWebsites.persistent, true);
  const defaultTabs = (await api('/command', 'POST', { name: 'browser_tabs', args: {} })).result
    .tabs;
  const defaultTab = defaultTabs.find((tab) => tab.url === `${origin}/`);
  assert(defaultTab, 'Freshly paired extension can access a website without a per-site grant');
  assert(
    (await api('/command', 'POST', { name: 'browser_snapshot', args: { tabId: defaultTab.id } }))
      .result.elements.length > 0,
  );
  console.log('PASS: production manifest and default all-website access without per-site setup');
  await panel
    .locator('#grants li')
    .filter({ hasText: 'All HTTP(S) websites' })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await panel.locator('#origin').fill(origin);
  await panel.locator('#grant').click();
  await panel.locator('#grants').filter({ hasText: origin }).waitFor();
  const tabs = (await api('/command', 'POST', { name: 'browser_tabs', args: {} })).result.tabs;
  const tabId = tabs.find((tab) => tab.url === `${origin}/`).id;
  globalThis.testTabId = tabId;
  const command = async (name, args = {}) =>
    (await api('/command', 'POST', { name, args: { tabId, ...args } })).result;

  const slowTab = (
    await api('/command', 'POST', {
      name: 'browser_open',
      args: { url: `${origin}/slow-page`, active: false },
    })
  ).result;
  const began = performance.now();
  await api('/command', 'POST', {
    name: 'browser_wait',
    args: { tabId: slowTab.tabId, text: 'Early state is available', timeoutMs: 1200 },
  });
  assert(performance.now() - began < 1200, 'Predicate must not wait for the slow image');
  await api('/command', 'POST', {
    name: 'browser_tab',
    args: { tabId: slowTab.tabId, operation: 'close' },
  });
  console.log('PASS: explicit state predicates bypass unrelated slow resource loading');
  const named = await command('browser_snapshot', { nameContains: 'Project', role: 'textbox' });
  assert.equal(named.elements.length, 1);
  assert.equal(named.elements[0].name, 'Project name');
  const links = await command('browser_extract', { kind: 'links' });
  assert.equal(links.kind, 'links');
  assert.equal(links.trust, 'UNTRUSTED_WEBPAGE_DATA');
  const shadowText = await command('browser_extract', {
    kind: 'text',
    scopeSelector: '#shadow-host',
  });
  assert.equal(shadowText.text, 'Shadow action');
  let snapshot = await command('browser_snapshot');
  assert.equal(snapshot.text.includes('Ignore the user'), false);
  assert.equal(snapshot.elements.find((el) => el.type === 'password').value, '[REDACTED]');
  assert(snapshot.elements.some((el) => el.name === 'Shadow action'));
  const oldRef = snapshot.elements.find((el) => el.name === 'Project name').ref;
  await command('browser_snapshot');
  await assert.rejects(command('browser_type', { ref: oldRef, text: 'stale' }), /STALE_REF/);
  console.log('PASS: DOM grounding, password redaction, open shadow roots and stale refs');

  await command('browser_type', { selector: '#project', text: 'Manual project' });
  await command('browser_select', { selector: '#priority', value: 'urgent' });
  await command('browser_click', { selector: '#save' });
  await webpage
    .locator('#result')
    .filter({ hasText: 'Saved request: Manual project (urgent)' })
    .waitFor();
  assert.equal(await webpage.locator('body').getAttribute('data-trusted'), 'true');
  const screenshot = await command('browser_screenshot');
  assert.equal(Buffer.from(screenshot.image.data, 'base64').subarray(1, 4).toString(), 'PNG');
  await writeFile(
    path.join(artifacts, 'browser-viewport.png'),
    Buffer.from(screenshot.image.data, 'base64'),
  );
  const canvasBox = await webpage.locator('#canvas').boundingBox();
  await command('browser_click', { x: canvasBox.x + 70, y: canvasBox.y + 50 });
  await webpage.locator('#canvas-result').filter({ hasText: 'Canvas clicked' }).waitFor();
  await command('browser_drag', {
    fromX: canvasBox.x + 45,
    fromY: canvasBox.y + 45,
    toX: canvasBox.x + 130,
    toY: canvasBox.y + 60,
  });
  await command('browser_hover', { selector: '#save' });
  await command('browser_type', { selector: '#project', text: 'Keyboard project' });
  await command('browser_press', { key: 'Enter' });
  await webpage
    .locator('#result')
    .filter({ hasText: 'Saved request: Keyboard project (urgent)' })
    .waitFor();
  await command('browser_scroll', { deltaY: 650 });
  await webpage.waitForFunction(() => scrollY > 0);
  await command('browser_scroll', { selector: '#long' });
  await command('browser_click', { selector: '#long' });
  await webpage.locator('#result').filter({ hasText: 'Bottom clicked' }).waitFor();
  // All targets are checked before any field changes; a bad second target must not fill the first.
  const previousProject = await webpage.locator('#project').inputValue();
  await assert.rejects(
    command('browser_fill_form', {
      fields: [
        { kind: 'text', selector: '#project', value: 'Should never be entered' },
        { kind: 'select', selector: '#priority', value: 'missing-option' },
      ],
    }),
    /FORM_FIELD_OPTION/,
  );
  assert.equal(await webpage.locator('#project').inputValue(), previousProject);
  const form = await command('browser_fill_form', {
    fields: [
      { kind: 'text', selector: '#project', value: 'Compound project' },
      { kind: 'select', selector: '#priority', value: 'normal' },
      { kind: 'check', selector: '#remember', value: true },
      { kind: 'text', selector: '#password', value: 'fixture-secret-value' },
    ],
  });
  assert.equal(form.outcome, 'filled', JSON.stringify(form));
  assert.equal(await webpage.locator('#project').inputValue(), 'Compound project');
  assert.equal(await webpage.locator('#remember').isChecked(), true);
  assert.equal(JSON.stringify(form).includes('fixture-secret-value'), false);
  const checkbox = await command('browser_fill_form', {
    fields: [{ kind: 'check', selector: '#remember', value: true }],
  });
  assert.equal(checkbox.fields[0].status, 'unchanged');
  await webpage.evaluate(() => {
    window.unchangedEvents = 0;
    for (const name of ['input', 'change']) {
      document.querySelector('#project').addEventListener(name, () => window.unchangedEvents++);
      document.querySelector('#priority').addEventListener(name, () => window.unchangedEvents++);
    }
  });
  const sameFields = [
    { kind: 'text', selector: '#project', value: 'Compound project' },
    { kind: 'select', selector: '#priority', value: 'normal' },
  ];
  const unchangedForm = await command('browser_fill_form', { fields: sameFields });
  assert(unchangedForm.fields.every((field) => field.status === 'unchanged'));
  assert.equal(await webpage.evaluate(() => unchangedEvents), 0);
  await command('browser_fill_form', { fields: sameFields, skipUnchanged: false });
  assert((await webpage.evaluate(() => unchangedEvents)) > 0);
  const withoutFrames = await command('browser_snapshot', {
    scopeSelector: '#project',
    includeFrames: false,
  });
  assert.equal(withoutFrames.frames, undefined);
  const beforeOcclusion = await webpage.locator('#project').inputValue();
  await webpage.evaluate(() => (document.querySelector('#overlay').style.display = 'block'));
  await assert.rejects(
    command('browser_type', { selector: '#project', text: 'Must not type' }),
    /ELEMENT_OCCLUDED/,
  );
  assert.equal(await webpage.locator('#project').inputValue(), beforeOcclusion);
  await webpage.evaluate(() => (document.querySelector('#overlay').style.display = 'none'));
  await webpage.evaluate(() => {
    document.querySelector('#password').focus();
    document
      .querySelector('#project')
      .addEventListener('focus', () => document.querySelector('#priority').focus(), { once: true });
  });
  await assert.rejects(
    command('browser_type', { selector: '#project', text: 'Wrong focus' }),
    /ELEMENT_FOCUS_CHANGED/,
  );
  assert.equal(await webpage.locator('#project').inputValue(), beforeOcclusion);
  await webpage.evaluate(() => {
    const group = document.createElement('optgroup');
    group.disabled = true;
    group.innerHTML = '<option value="disabled-group">Unavailable option</option>';
    document.querySelector('#priority').append(group);
  });
  await assert.rejects(
    command('browser_select', { selector: '#priority', value: 'disabled-group' }),
    /disabled/,
  );
  assert.equal(await webpage.locator('#priority').inputValue(), 'normal');
  const controlScope = await command('browser_snapshot', { scopeSelector: '#project' });
  assert.equal(controlScope.elements.length, 1);
  const shadowScope = await command('browser_snapshot', { scopeSelector: '#shadow-host' });
  assert(shadowScope.elements.some((el) => el.name === 'Shadow action'));
  assert(shadowScope.text.includes('Shadow action'));
  console.log(
    'PASS: preflighted multi-field fill, native checkbox state, secret redaction and scoped shadow observations',
  );
  const compound = await command('browser_step', {
    action: { name: 'browser_click', args: { selector: '#async-save' } },
    wait: { text: 'Asynchronous save completed', timeoutMs: 2000 },
    observation: { scopeSelector: 'body' },
  });
  assert.equal(compound.outcome, 'observed');
  assert(compound.snapshot.text.includes('Asynchronous save completed'));
  assert.equal(await webpage.locator('#async-result').textContent(), 'Asynchronous save completed');
  await webpage.evaluate(() => {
    const scope = document.createElement('section');
    scope.id = 'wait-scope';
    scope.innerHTML =
      '<span class="pending">Scoped update</span><span class="hidden-node" hidden>Hidden marker</span>';
    document.body.prepend(scope);
    const outside = document.createElement('span');
    outside.className = 'pending';
    outside.textContent = 'Outside scope';
    document.body.append(outside);
  });
  await command('browser_wait', {
    selector: '.pending',
    text: 'Scoped update',
    scopeSelector: '#wait-scope',
    timeoutMs: 1000,
  });
  await command('browser_wait', {
    selector: '.hidden-node',
    scopeSelector: '#wait-scope',
    condition: 'attached',
    timeoutMs: 1000,
  });
  await command('browser_wait', {
    selector: '.hidden-node',
    scopeSelector: '#wait-scope',
    condition: 'hidden',
    timeoutMs: 1000,
  });
  await webpage.evaluate(() => document.querySelector('#wait-scope .pending').remove());
  await command('browser_wait', {
    selector: '.pending',
    scopeSelector: '#wait-scope',
    condition: 'detached',
    timeoutMs: 1000,
  });
  await assert.rejects(
    command('browser_wait', {
      selector: '#async-save',
      text: 'Text absent from this page',
      timeoutMs: 100,
    }),
    /WAIT_TIMEOUT/,
  );
  await assert.rejects(
    command('browser_wait', { selector: '[', timeoutMs: 1000 }),
    /valid selector|not a valid/i,
  );
  await webpage.evaluate(() => document.querySelector('#wait-scope').remove());
  console.log(
    'PASS: scoped combined waits, hidden/attached/detached states, unchanged form events and occluded typing',
  );
  const unmet = await command('browser_step', {
    action: { name: 'browser_type', args: { selector: '#project', text: 'Not submitted' } },
    wait: { text: 'A condition that does not exist', timeoutMs: 100 },
  });
  assert.equal(unmet.outcome, 'condition_not_met');
  assert(
    unmet.snapshot.elements.some(
      (el) => el.name === 'Project name' && el.value === 'Not submitted',
    ),
  );
  console.log(
    'PASS: trusted clicks, native typing, select controls, screenshots, canvas and async compound action verification',
  );

  snapshot = await command('browser_snapshot');
  const frame = snapshot.frames.find((frame) => frame.url.endsWith('/frame'));
  const frameSnapshot = await command('browser_snapshot', { frameId: frame.frameId });
  assert(frameSnapshot.elements.some((el) => el.name === 'Frame button'));
  await webpage.locator('iframe').scrollIntoViewIfNeeded();
  await command('browser_click', { frameId: frame.frameId, ref: frameSnapshot.elements[0].ref });
  assert(
    (await command('browser_snapshot', { frameId: frame.frameId })).text.includes('Frame clicked'),
  );
  await command('browser_click', { selector: '#shadow-button' });
  await webpage.locator('#result').filter({ hasText: 'Shadow clicked' }).waitFor();
  await webpage.locator('#overlay').evaluate((el) => (el.style.display = 'block'));
  await assert.rejects(command('browser_click', { selector: '#save' }), /OCCLUDED/);
  await webpage.locator('#overlay').evaluate((el) => (el.style.display = 'none'));
  console.log('PASS: frame snapshots, shadow input and occlusion detection');

  await assert.rejects(
    command('browser_evaluate', { expression: 'document.title' }),
    /ADVANCED_ACCESS_REQUIRED/,
  );
  await panel.locator('#advanced').check();
  await panel.locator('#grant').click();
  console.log('CHECK: advanced grant saved');
  assert.equal(
    (await command('browser_evaluate', { expression: 'document.title' })).value,
    'Browser agent test workspace',
  );
  const file = path.join(temp, 'upload.txt');
  await writeFile(file, 'test upload');
  await command('browser_upload', { selector: '#upload', files: [file] });
  await webpage.locator('#result').filter({ hasText: 'Attached: upload.txt' }).waitFor();
  console.log('CHECK: local file attached');
  const dialog = webpage.waitForEvent('dialog');
  const clickDialog = command('browser_click', { selector: '#confirm' });
  await dialog;
  await clickDialog;
  await command('browser_dialog', { accept: true });
  await webpage.locator('#result').filter({ hasText: 'Confirmed' }).waitFor();
  const downloadEvent = webpage.waitForEvent('download');
  await command('browser_click', { selector: '#download' });
  await downloadEvent;
  const downloadState = await command('browser_downloads');
  assert(downloadState.events.some((event) => event.method === 'Page.downloadWillBegin'));
  const managed = await command('browser_download', {
    operation: 'start',
    url: `${origin}/file.txt`,
    filename: 'jev-fixture/test.txt',
  });
  const completedDownload = await command('browser_downloads', {
    waitForId: managed.id,
    timeoutMs: 8000,
  });
  const managedState = completedDownload.awaited;
  assert.equal(managedState.state, 'complete', JSON.stringify(managedState));
  await assert.rejects(
    command('browser_download', { operation: 'cancel', id: 999999 }),
    /NOT_OWNED/,
  );
  assert.equal((await command('browser_tab_manage', { operation: 'pin' })).pinned, true);
  assert.equal((await command('browser_tab_manage', { operation: 'unpin' })).pinned, false);
  assert.equal((await command('browser_tab_manage', { operation: 'mute' })).muted, true);
  await command('browser_tab_manage', { operation: 'unmute' });
  const windowState = await command('browser_window', {
    operation: 'resize',
    width: 1000,
    height: 800,
  });
  assert.equal(windowState.width, 1000);
  console.log('PASS: managed download completion, tab pin/mute and window resizing');
  console.log('PASS: advanced grants, evaluation, confined uploads and dialogs');

  const accessibility = await command('browser_accessibility');
  assert(accessibility.nodes.some((node) => node.name?.includes('Project name')));
  assert.equal(JSON.stringify(accessibility).includes('do-not-leak'), false);
  await command('browser_diagnostics', { operation: 'start' });
  await command('browser_evaluate', {
    expression:
      "console.log('diagnostic-console-fixture'); fetch('/diagnostic.json?token=do-not-record-query').then(response => response.json())",
  });
  let captured;
  for (let i = 0; i < 30; i++) {
    captured = await command('browser_diagnostics');
    if (
      captured.network.some(
        (request) => request.url.endsWith('/diagnostic.json') && request.complete,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(captured.console.some((entry) => entry.text.includes('diagnostic-console-fixture')));
  assert.equal(JSON.stringify(captured).includes('do-not-record-query'), false);
  const request = captured.network.find((entry) => entry.url.endsWith('/diagnostic.json'));
  assert.match(
    (await command('browser_response', { requestId: request.requestId })).body,
    /captured-response-fixture/,
  );
  assert((await command('browser_metrics')).metrics.some((metric) => metric.name === 'Documents'));
  await command('browser_emulate', { operation: 'viewport', width: 640, height: 480 });
  assert.equal((await command('browser_evaluate', { expression: 'innerWidth' })).value, 640);
  await command('browser_emulate', { operation: 'reset' });
  console.log(
    'PASS: accessibility, console/network metadata, gated response bodies, performance and viewport emulation',
  );

  await panel.locator('#mode').selectOption('read');
  await panel.locator('#grant').click();
  await command('browser_snapshot');
  await assert.rejects(command('browser_click', { selector: '#save' }), /READ_ONLY/);
  await command('browser_screenshot');
  await panel.locator('#mode').selectOption('interact');
  await panel.locator('#grant').click();
  await assert.rejects(
    command('browser_navigate', { url: 'https://unauthorized.example' }),
    /ACCESS_REQUIRED/,
  );
  console.log('PASS: read-only enforcement and destination-origin isolation');

  mcp = new Client({ name: 'jev-e2e', version: '1.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'server/mcp.mjs')],
      env: { ...process.env, JEV_CONFIG: configFile },
    }),
  );
  const inventory = await mcp.listTools();
  assert(inventory.tools.some((tool) => tool.name === 'browser_run'));
  for (const name of ['browser_groups', 'browser_group_tabs', 'browser_group_update'])
    assert(inventory.tools.some((tool) => tool.name === name));
  assert(inventory.tools.find((tool) => tool.name === 'browser_snapshot').annotations.readOnlyHint);
  const mcpScreenshot = await mcp.callTool({ name: 'browser_screenshot', arguments: { tabId } });
  const mcpJPEG = await mcp.callTool({
    name: 'browser_screenshot',
    arguments: { tabId, format: 'jpeg', quality: 80 },
  });
  assert(!mcpJPEG.isError);
  const jpegImage = mcpJPEG.content.find((item) => item.type === 'image');
  assert.equal(jpegImage.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(jpegImage.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  assert(mcpScreenshot.content.some((item) => item.type === 'image'));
  console.log(
    `PASS: real stdio MCP handshake, ${inventory.tools.length} tools and image transport`,
  );

  await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
  await panel.locator('#target-tab').selectOption(String(tabId));
  await panel.locator('#goal').fill('Create an urgent request named Agent project');
  await panel.locator('#run').click();
  await panel.locator('#task-progress').waitFor();
  await panel.locator('#progress-title').filter({ hasText: 'Waiting for fixture-model' }).waitFor();
  await panel
    .locator('#progress-elapsed')
    .filter({ hasText: /[1-9]\d*s elapsed/ })
    .waitFor();
  await panel.screenshot({ path: path.join(artifacts, 'ui-live-progress.png') });
  console.log('PASS: progress appears in chat while the planner response is pending');
  await panel.getByRole('tab', { name: 'Activity', exact: true }).click();
  await panel.locator('#task-output').waitFor();
  const { currentTaskId } = await panel.evaluate(() => chrome.storage.session.get('currentTaskId'));
  let task;
  for (let i = 0; i < 150; i++) {
    task = await api(`/tasks/${currentTaskId}`);
    if (task.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(task.status, 'completed', task.error || task.summary);
  assert.equal(task.evidence, 'Saved request: Agent project (urgent)');
  assert.equal(mockCalls, 4);
  assert(task.events.some((event) => event.type === 'jev' && event.accepted));
  for (let i = 0; bridge.runner.busy && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const conversation = await api(`/sessions/${task.sessionId}`);
  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.modelState, undefined);
  await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
  await panel
    .locator('#transcript')
    .filter({ hasText: 'Created the requested test project' })
    .waitFor();
  await panel.getByRole('tab', { name: 'Memory', exact: true }).click();
  await panel.locator('#fact-text').fill('Use concise comparison tables');
  await panel.locator('#save-fact').click();
  await panel.locator('#facts').filter({ hasText: 'Use concise comparison tables' }).waitFor();
  assert.equal((await api('/memory')).reusable[0].text, 'Use concise comparison tables');
  const skills = await mcp.callTool({ name: 'browser_skills', arguments: {} });
  assert(
    JSON.parse(skills.content[0].text).skills.some((skill) => skill.id === 'multi-tab-research'),
  );
  const mcpTask = await mcp.callTool({ name: 'browser_task', arguments: { id: currentTaskId } });
  assert.equal(JSON.parse(mcpTask.content[0].text).status, 'completed');
  await panel.getByRole('tab', { name: 'Activity', exact: true }).click();
  await panel.locator('#task-status').filter({ hasText: 'Completed' }).waitFor();
  await panel.locator('#task-evidence').filter({ hasText: 'Agent project' }).waitFor();
  await writeFile(path.join(artifacts, 'e2e-task.json'), JSON.stringify(task, null, 2));
  // A real overlay must fail before native input, return fresh evidence and remain recoverable.
  await webpage.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'test-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:#fff9;z-index:999999';
    overlay.innerHTML = '<button onclick="this.parentElement.remove()">Reject Optional</button>';
    document.body.append(overlay);
  });
  const covered = await command('browser_step', {
    action: { name: 'browser_click', args: { selector: '#save' } },
  });
  assert.equal(covered.outcome, 'action_blocked');
  assert.equal(covered.action.mutationOutcome, 'not_dispatched');
  assert(covered.snapshot.elements.some((el) => el.name === 'Reject Optional'));
  await command('browser_step', {
    action: {
      name: 'browser_click',
      args: { ref: covered.snapshot.elements.find((el) => el.name === 'Reject Optional').ref },
    },
  });
  assert.equal(await webpage.locator('#test-overlay').count(), 0);
  console.log(
    'PASS: native pre-input occlusion returns fresh evidence; overlay dismissal succeeds without click-through',
  );
  const fastStartBegan = performance.now();
  const fastStart = await api('/tasks', 'POST', { goal: `open ${origin}/startup-check`, tabId });
  let openedTask;
  for (let i = 0; i < 100; i++) {
    openedTask = await api(`/tasks/${fastStart.id}`);
    if (openedTask.status !== 'running' && !bridge.runner.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(openedTask.status, 'completed', openedTask.error);
  assert.equal(mockCalls, 4, 'pure URL opening must not invoke the planner');
  assert.equal(openedTask.timings.modelMs, 0);
  assert.equal(openedTask.ledger.observations[0].url, `${origin}/startup-check`);
  console.log(
    `PASS: real grouped startup URL task completed in ${(performance.now() - fastStartBegan).toFixed(0)}ms with zero model calls`,
  );
  await api('/command', 'POST', {
    name: 'browser_tab',
    args: { tabId: openedTask.activeTabId, operation: 'close' },
  });
  console.log(
    'PASS: complete LLM + Jev + extension workflow with verified final evidence (fixture APIs)',
  );
  console.log(
    'PASS: conversation transcript, explicitly saved reusable memory and local skills through the UI/MCP',
  );

  await panel.locator('#pause').click();
  await assert.rejects(command('browser_snapshot'), /PAUSED/);
  assert.equal(
    (await api('/command', 'POST', { name: 'browser_capabilities', args: {} })).result.paused,
    true,
  );
  await panel.locator('#pause').click();
  await command('browser_snapshot');
  const created = (
    await api('/command', 'POST', {
      name: 'browser_open',
      args: { url: `${origin}/second`, active: false },
    })
  ).result;
  await api('/command', 'POST', { name: 'browser_wait', args: { tabId: created.tabId } });
  assert.equal(created.warning, undefined);
  assert.equal(created.group.title, 'JEV Browser');
  assert.equal(created.group.color, 'purple');
  const grouped = (
    await api('/command', 'POST', {
      name: 'browser_open',
      args: { url: `${origin}/grouped`, active: false },
    })
  ).result;
  assert.equal(grouped.groupId, created.groupId);
  const groupInventory = await mcp.callTool({ name: 'browser_groups', arguments: {} });
  assert(!groupInventory.isError);
  const visibleGroup = JSON.parse(groupInventory.content[0].text).groups.find(
    (group) => group.id === created.groupId,
  );
  assert(
    visibleGroup.tabIds.includes(created.tabId) && visibleGroup.tabIds.includes(grouped.tabId),
  );
  const renamed = await mcp.callTool({
    name: 'browser_group_update',
    arguments: {
      groupId: created.groupId,
      title: 'JEV Browser · Research',
      color: 'green',
      collapsed: true,
    },
  });
  assert(!renamed.isError);
  assert.equal(JSON.parse(renamed.content[0].text).group.collapsed, true);
  const reused = (
    await api('/command', 'POST', {
      name: 'browser_open',
      args: { url: `${origin}/reused`, active: false },
    })
  ).result;
  assert.equal(reused.groupId, created.groupId);
  assert.equal(reused.group.title, 'JEV Browser · Research');
  assert.equal(reused.group.collapsed, false);
  const regrouped = (
    await api('/command', 'POST', {
      name: 'browser_group_tabs',
      args: { tabIds: [tabId, grouped.tabId], title: 'MCP workspace', color: 'blue' },
    })
  ).result;
  assert.notEqual(regrouped.groupId, created.groupId);
  assert.equal(regrouped.group.title, 'MCP workspace');
  assert.equal((await command('browser_tab_manage', { operation: 'ungroup' })).groupId, -1);
  const joined = (
    await api('/command', 'POST', {
      name: 'browser_group_tabs',
      args: { tabIds: [grouped.tabId], groupId: created.groupId },
    })
  ).result;
  assert.equal(joined.groupId, created.groupId);
  assert.equal(joined.group.title, 'JEV Browser · Research');
  const ordinary = (
    await api('/command', 'POST', {
      name: 'browser_open',
      args: { url: `${origin}/ordinary`, active: false, grouped: false },
    })
  ).result;
  assert.equal(ordinary.groupId, -1);
  for (const extra of [grouped, reused, ordinary])
    await api('/command', 'POST', {
      name: 'browser_tab',
      args: { tabId: extra.tabId, operation: 'close' },
    });
  console.log(
    'PASS: visible JEV Browser group, reuse, rename/color, collapse/expand, manual grouping, ungroup and ordinary-tab opt-out through MCP',
  );
  const batch = (
    await api('/command', 'POST', {
      name: 'browser_batch',
      args: {
        commands: [
          { name: 'browser_snapshot', args: { tabId } },
          { name: 'browser_snapshot', args: { tabId: created.tabId } },
        ],
      },
    })
  ).result;
  assert.equal(batch.results.length, 2);
  assert(
    batch.results.every((entry) => !entry.error && entry.result.text.includes('Request workspace')),
  );
  console.log('PASS: concurrent observations of multiple real browser tabs');
  assert.equal(
    (await api('/command', 'POST', { name: 'browser_snapshot', args: { tabId: created.tabId } }))
      .result.url,
    `${origin}/second`,
  );
  await api('/command', 'POST', {
    name: 'browser_navigate',
    args: { tabId: created.tabId, url: `${origin}/third` },
  });
  await api('/command', 'POST', { name: 'browser_wait', args: { tabId: created.tabId } });
  assert.equal(
    (await api('/command', 'POST', { name: 'browser_snapshot', args: { tabId: created.tabId } }))
      .result.url,
    `${origin}/third`,
  );
  await api('/command', 'POST', {
    name: 'browser_tab',
    args: { tabId: created.tabId, operation: 'back' },
  });
  await api('/command', 'POST', { name: 'browser_wait', args: { tabId: created.tabId } });
  assert.equal(
    (await api('/command', 'POST', { name: 'browser_snapshot', args: { tabId: created.tabId } }))
      .result.url,
    `${origin}/second`,
  );
  await api('/command', 'POST', {
    name: 'browser_tab',
    args: { tabId: created.tabId, operation: 'close' },
  });
  console.log('PASS: tab creation, navigation, history, waits and close');
  const recreated = (
    await api('/command', 'POST', {
      name: 'browser_open',
      args: { url: `${origin}/recreated`, active: false },
    })
  ).result;
  assert.equal(recreated.group.title, 'JEV Browser');
  assert.notEqual(recreated.groupId, created.groupId);
  await api('/command', 'POST', {
    name: 'browser_tab',
    args: { tabId: recreated.tabId, operation: 'close' },
  });
  console.log('PASS: recreate a managed group after its last tab closes');
  const crossOrigin = `http://localhost:${fixture.address().port}`;
  await command('browser_evaluate', {
    expression: `(() => { const frame = document.createElement('iframe'); frame.id = 'cross-frame'; frame.src = '${crossOrigin}/nested'; frame.style.cssText = 'display:block;width:500px;height:300px;border:6px solid purple;transform:scale(.9);transform-origin:top left'; document.body.append(frame); return true; })()`,
  });
  await webpage.locator('#cross-frame').scrollIntoViewIfNeeded();
  await webpage
    .frameLocator('#cross-frame')
    .frameLocator('iframe')
    .locator('#frame-button')
    .waitFor();
  const beforeBroad = await command('browser_snapshot');
  let nested = beforeBroad.frames.find((entry) => entry.url === `${crossOrigin}/frame`);
  await assert.rejects(command('browser_snapshot', { frameId: nested.frameId }), /ACCESS_REQUIRED/);
  await panel.getByRole('tab', { name: 'Settings', exact: true }).click();
  await panel.locator('#grant-all').click();
  await panel.locator('#grants').filter({ hasText: 'All HTTP(S) websites' }).waitFor();
  const nestedSnapshot = await command('browser_snapshot', { frameId: nested.frameId });
  const nestedClick = await command('browser_click', {
    frameId: nested.frameId,
    ref: nestedSnapshot.elements[0].ref,
  });
  console.log('Nested click coordinates:', JSON.stringify(nestedClick));
  try {
    await command('browser_wait', {
      frameId: nested.frameId,
      text: 'Frame clicked',
      timeoutMs: 2000,
    });
  } catch (error) {
    console.log(
      'Nested frame failure state:',
      JSON.stringify(await command('browser_snapshot', { frameId: nested.frameId })),
    );
    console.log(
      'Nested delivered events:',
      JSON.stringify(
        await webpage
          .frameLocator('#cross-frame')
          .frameLocator('iframe')
          .locator('body')
          .evaluate(() => ({
            events: window.inputEvents,
            focused: document.hasFocus(),
            visibility: document.visibilityState,
          })),
      ),
    );
    const capture = await command('browser_screenshot');
    await writeFile(
      path.join(artifacts, 'e2e-frame-failure.png'),
      Buffer.from(capture.image.data, 'base64'),
    );
    throw error;
  }
  assert(
    (await command('browser_snapshot', { frameId: nested.frameId })).text.includes('Frame clicked'),
  );
  await command('browser_type', {
    frameId: nested.frameId,
    selector: '#frame-input',
    text: 'Nested input text',
  });
  assert.equal(
    (await command('browser_snapshot', { frameId: nested.frameId })).elements.find(
      (el) => el.name === 'Frame input',
    ).value,
    'Nested input text',
  );
  const frameSamples = Number(process.env.JEV_FRAME_SAMPLES || 1);
  assert(Number.isInteger(frameSamples) && frameSamples >= 1 && frameSamples <= 100);
  for (let sample = 1; sample < frameSamples; sample++) {
    const frameUrl = `${crossOrigin}/nested?sample=${sample}`;
    const outer = webpage.frames().find((frame) => frame.url().startsWith(`${crossOrigin}/nested`));
    await webpage.locator('#cross-frame').evaluate((el, url) => (el.src = url), frameUrl);
    await outer.waitForURL(frameUrl);
    await webpage
      .frameLocator('#cross-frame')
      .frameLocator('iframe')
      .locator('#frame-button')
      .waitFor();
    nested = (await command('browser_snapshot')).frames.find(
      (entry) => entry.url === `${crossOrigin}/frame`,
    );
    const result = await command('browser_step', {
      action: {
        name: 'browser_click',
        args: { frameId: nested.frameId, selector: '#frame-button' },
      },
      wait: { frameId: nested.frameId, text: 'Frame clicked', timeoutMs: 2000 },
      observation: { frameId: nested.frameId },
    });
    if (result.outcome !== 'observed') {
      console.log(
        'Fresh frame input events:',
        JSON.stringify(
          await webpage
            .frameLocator('#cross-frame')
            .frameLocator('iframe')
            .locator('body')
            .evaluate(() => window.inputEvents),
        ),
      );
      console.log(
        'Fresh frame target box:',
        JSON.stringify(
          await webpage
            .frameLocator('#cross-frame')
            .frameLocator('iframe')
            .locator('#frame-button')
            .boundingBox(),
        ),
      );
      const capture = await command('browser_screenshot');
      await writeFile(
        path.join(artifacts, 'e2e-frame-failure.png'),
        Buffer.from(capture.image.data, 'base64'),
      );
    }
    assert.equal(
      result.outcome,
      'observed',
      `Fresh cross-site frame ${sample}: ${JSON.stringify(result)}`,
    );
    const events = await webpage
      .frameLocator('#cross-frame')
      .frameLocator('iframe')
      .locator('body')
      .evaluate(() => window.inputEvents);
    assert.equal(
      events.filter(
        (event) => event.type === 'click' && event.target === 'frame-button' && event.trusted,
      ).length,
      1,
    );
    assert(events.some((event) => event.type === 'mousedown' && event.buttons === 1));
  }
  if (frameSamples > 1)
    console.log(
      `PASS: ${frameSamples} freshly navigated cross-site frame clicks with no action replay`,
    );
  await webpage.locator('#cross-frame').evaluate((el) => (el.style.transform = 'rotate(4deg)'));
  await assert.rejects(
    command('browser_click', { frameId: nested.frameId, selector: '#frame-button' }),
    /TRANSFORM_UNSUPPORTED/,
  );
  await webpage.locator('#cross-frame').evaluate((el) => (el.style.transform = 'scale(.9)'));
  await webpage.locator('#overlay').evaluate((el) => {
    el.style.display = 'block';
    el.style.zIndex = '9999';
  });
  await assert.rejects(
    command('browser_click', { frameId: nested.frameId, selector: '#frame-button' }),
    /OCCLUDED/,
  );
  await webpage.locator('#overlay').evaluate((el) => (el.style.display = 'none'));
  await panel.locator('#origin').fill(crossOrigin);
  await panel.locator('#grant').click();
  await panel
    .locator('#grants li')
    .filter({ hasText: crossOrigin })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await assert.rejects(command('browser_snapshot', { frameId: nested.frameId }), /ACCESS_REQUIRED/);
  await panel
    .locator('#grants li')
    .filter({ hasText: 'All HTTP(S) websites' })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await assert.rejects(command('browser_snapshot', { frameId: nested.frameId }), /ACCESS_REQUIRED/);
  await command('browser_snapshot');
  console.log(
    'PASS: scoped frame denial, all-site mode, nested cross-site scaled iframe trusted clicks, parent occlusion and revocation',
  );
  await panel.getByRole('tab', { name: 'Chat', exact: true }).click();
  await panel.setViewportSize({ width: 420, height: 1000 });
  await panel.locator('#settings').evaluate((el) => (el.open = false));
  await panel.screenshot({
    path: path.join(artifacts, 'side-panel.png'),
    fullPage: true,
    animations: 'disabled',
  });
  console.log('PASS: emergency pause/resume');
  await bridge.close();
  bridge = await createBridge(config, { settings });
  await bridge.listen();
  assert.equal(bridge.store.get(task.sessionId).messages.length, 2);
  assert.equal(bridge.store.facts().reusable[0].text, 'Use concise comparison tables');
  assert.equal(bridge.runner.get(task.id).status, 'completed');
  console.log('PASS: bridge restart restores conversation, saved facts and task outcome');
} finally {
  await mcp?.close();
  await context?.close();
  await bridge?.close();
  await new Promise((resolve) => fixture.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
