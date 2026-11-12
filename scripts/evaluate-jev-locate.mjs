// Live, metered Jev locator evaluation against independent disposable fixtures.
// Never runs against a user's signed-in tabs or sends a provider key to the page.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, root } from '../server/config.mjs';
import { Settings } from '../server/settings.mjs';
import { withBrowserFixture } from '../tests/browser-fixture.mjs';

const label = process.argv[2] || 'current';
assert(/^[a-z0-9-]+$/.test(label));
const config = await loadConfig();
const settings = new Settings(config);
await settings.load();
const key = settings.key(config.jev.apiKeyEnv, 'jev');
assert(key, 'Configure the TypeSafe key in the private secret store first.');
const cases = [];
for (let i = 0; i < 8; i++) {
  cases.push({ family: 'exact', target: `Open Atlas ${i}`, expected: 'target', reverse: i % 2 });
  cases.push({
    family: 'duplicate-row',
    target: `Open the record for Aurora ${i}`,
    expected: 'target',
    reverse: i % 2,
  });
  cases.push({
    family: 'no-match',
    target: 'Open the billing report',
    expected: null,
    reverse: i % 2,
  });
  if (i < 4)
    cases.push({
      family: 'disabled',
      target: 'Open the disabled archive',
      expected: null,
      reverse: i % 2,
    });
  if (i < 4)
    cases.push({
      family: 'shadow',
      target: 'Open shadow help',
      expected: 'target',
      reverse: i % 2,
    });
}
const receipts = new Map();
const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function controls(test, index) {
  const button = (id, name, disabled = false) =>
    `<button ${disabled ? 'disabled' : ''} data-receipt="${id}">${escape(name)}</button>`;
  const list =
    test.family === 'duplicate-row'
      ? [
          `<section><h2>Aurora ${Math.floor(index / 4)}</h2>${button('target', 'Open')}</section>`,
          `<section><h2>Luna</h2>${button('distractor', 'Open')}</section>`,
        ]
      : test.family === 'exact'
        ? [button('target', test.target), button('distractor', 'Account settings')]
        : test.family === 'disabled'
          ? [
              button('disabled', 'Open the disabled archive', true),
              button('distractor', 'Open recent files'),
            ]
          : [button('distractor', 'Help center'), button('another', 'Account settings')];
  if (test.reverse) list.reverse();
  return list.join('');
}
const report = {
  label,
  reviewDate: '2026-10-06',
  measuredAt: new Date().toISOString(),
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cases: [],
};
await withBrowserFixture(
  async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname.startsWith('/receipt/')) {
      const [, , caseId, control] = url.pathname.split('/');
      const values = receipts.get(caseId) || [];
      values.push(control);
      receipts.set(caseId, values);
      res.end('ok');
      return;
    }
    const index = Number(url.pathname.slice(1));
    const test = cases[index];
    if (!test) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    const html = controls(test, index).replace(
      /Aurora \d+/g,
      test.target.replace('Open the record for ', ''),
    );
    res.end(`<!doctype html><title>Locator fixture</title><style>body{font:16px system-ui;margin:30px}button{padding:12px;margin:8px}section{margin:20px}</style><main>${html}<div id="shadow"></div></main><script>
    ${test.family === 'shadow' ? "document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button data-receipt=target>Open shadow help</button>';" : ''}
    for(const root of [document,document.querySelector('#shadow').shadowRoot].filter(Boolean))
      for(const b of root.querySelectorAll('button')) b.onclick=e=>fetch('/receipt/${index}/'+b.dataset.receipt,{method:'POST'});
  </script>`);
  },
  async ({ call, origin, context, config: fixtureConfig }) => {
    report.browser = context.browser().version();
    const { apiKeyEnv: providerEnv, ...provider } = fixtureConfig.provider;
    const response = await fetch(`http://127.0.0.1:${fixtureConfig.port}/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${fixtureConfig.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider,
        jev: {
          enabled: true,
          endpoint: config.jev.endpoint,
          model: config.jev.model,
          confidenceThreshold: config.jev.confidenceThreshold,
          apiKey: key,
        },
      }),
    });
    assert.equal(response.status, 200, 'Fixture bridge configuration failed');
    for (const [index, test] of cases.entries()) {
      const tab = await call('browser_open', { url: `${origin}/${index}`, active: true });
      try {
        await call('browser_wait', { tabId: tab.tabId, state: 'domcontentloaded' });
        const began = performance.now();
        const result = await call('browser_locate', { tabId: tab.tabId, target: test.target });
        report.modelCalls += result.modelCalls ?? 1;
        report.inputTokens += result.usage?.input_tokens || 0;
        report.outputTokens += result.usage?.output_tokens || 0;
        const row = {
          family: test.family,
          index,
          elapsedMs: +(performance.now() - began).toFixed(2),
          model: result.model,
          source: result.source || 'jev',
          modelCalls: result.modelCalls ?? 1,
          confidence: result.confidence,
          accepted: result.accepted,
          selected: !!result.ref,
          probabilities: result.probabilities,
        };
        if (result.ref) {
          try {
            await call('browser_step', {
              tabId: tab.tabId,
              foreground: true,
              action: { name: 'browser_click', args: { ref: result.ref } },
              observation: { scopeSelector: 'main' },
            });
          } catch {
            row.executorRejected = true;
          }
        }
        // The private server-side receipt is independent of Jev's completion claim.
        const received = receipts.get(String(index)) || [];
        row.receipts = received;
        row.passed =
          test.expected === null
            ? !result.ref && received.length === 0
            : received.length === 1 && received[0] === test.expected;
        row.abstained = test.expected !== null && !result.ref;
        report.cases.push(row);
      } finally {
        await call('browser_tab', { tabId: tab.tabId, operation: 'close' });
      }
      if ((index + 1) % 8 === 0)
        console.log(`Evaluated ${index + 1}/${cases.length} live locator cases`);
    }
  },
);
const times = report.cases.map((r) => r.elapsedMs).sort((a, b) => a - b);
report.passed = report.cases.filter((r) => r.passed).length;
report.failed = report.cases.length - report.passed;
report.medianMs = times[Math.floor(times.length / 2)];
report.p95Ms = times[Math.ceil(times.length * 0.95) - 1];
report.estimatedJevInputCostUSD = (report.inputTokens * 0.042) / 1e6;
report.families = Object.fromEntries(
  [...new Set(cases.map((c) => c.family))].map((family) => {
    const rows = report.cases.filter((c) => c.family === family);
    return [
      family,
      {
        passed: rows.filter((r) => r.passed).length,
        total: rows.length,
        abstained: rows.filter((r) => r.abstained).length,
      },
    ];
  }),
);
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const output = path.join(root, 'artifacts', `jev-locate-${label}.json`);
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    passed: report.passed,
    failed: report.failed,
    modelCalls: report.modelCalls,
    medianMs: report.medianMs,
    p95Ms: report.p95Ms,
    estimatedJevInputCostUSD: report.estimatedJevInputCostUSD,
    families: report.families,
    output,
  }),
);
