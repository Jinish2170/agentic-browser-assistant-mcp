// Deterministic expert policies test browser contracts; they do not score an LLM.
// Submission grades read fixture server state independently of agent-visible text.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withBrowserFixture } from '../tests/browser-fixture.mjs';
import { root } from '../server/config.mjs';
import { definitions } from '../server/provider.mjs';

const label = process.argv[2] || 'current';
assert(/^[a-z0-9-]+$/.test(label));
const rounds = Number(process.env.JEV_EVAL_ROUNDS || 40);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 500);
const seed = Number(process.env.JEV_EVAL_SEED || 20261005);
assert(Number.isInteger(seed));
const activeTabs = process.env.JEV_EVAL_ACTIVE === '1';
const foregroundSteps = process.env.JEV_EVAL_FOREGROUND === '1';
const records = new Map();
const inventory = Array.from({ length: 25 }, (_, index) => [
  `Product ${index + 1}`,
  String((seed + index * 13) % 100),
  index % 2 ? 'Available' : 'Backorder',
]);
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq0AAAAASUVORK5CYII=';

async function serve(request, response) {
  const url = new URL(request.url, 'http://fixture');
  if (url.pathname.startsWith('/commit/')) {
    let body = '';
    for await (const chunk of request) body += chunk;
    const id = url.pathname.split('/').at(-1);
    const record = JSON.parse(body);
    records.set(id, { ...record, commits: (records.get(id)?.commits || 0) + 1 });
    await new Promise((resolve) => setTimeout(resolve, 25 + ((Number(id) * 17 + seed) % 200)));
    response.setHeader('Content-Type', 'application/json');
    response.end('{"saved":true}');
    return;
  }
  if (url.pathname.startsWith('/grade/')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(records.get(url.pathname.split('/').at(-1)) || null));
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  if (url.pathname === '/inventory') {
    response.end(
      `<!doctype html><title>Inventory</title><main><table id="inventory"><caption>Stock list</caption><thead><tr><th>Product</th><th>Count</th><th>Status</th></tr></thead><tbody>${inventory.map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table><div id="shadow"></div></main><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<table><tr><td>Shadow record</td><td>17</td></tr></table>';</script>`,
    );
    return;
  }
  if (url.pathname === '/popup') {
    response.end(
      "<title>Popup fixture</title><button onclick=\"window.open('/help?source=popup','_blank')\">Open help</button>",
    );
    return;
  }
  if (url.pathname === '/help') {
    response.end('<title>Help destination</title><main>Help page opened successfully</main>');
    return;
  }
  const id = url.pathname.split('/').at(-1);
  response.end(`<!doctype html><title>Request ${id}</title><style>body{font:16px system-ui;margin:30px}label{display:block;margin:10px}input,select,button{padding:10px}</style>
    <main><h1>Create request ${id}</h1><form>
    <label>Project <input id="project"></label><label>Owner <input id="owner"></label>
    <label>Plan <select id="plan"><option value="normal">Normal</option><option value="urgent">Urgent</option></select></label>
    <label><input id="remember" type="checkbox">Remember request</label><button>Save request</button></form>
    <output></output><a href="/help">Documentation</a><img alt="Fixture pixel" src="data:image/png;base64,${pixel}"></main>
    <script>document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();document.querySelector('output').textContent='Saving';await fetch('/commit/${id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:document.querySelector('#project').value,owner:document.querySelector('#owner').value,plan:document.querySelector('#plan').value,remember:document.querySelector('#remember').checked,trusted:e.isTrusted})});document.querySelector('output').textContent='Saved record: ${id}';};</script>`);
}

const report = {
  measuredAt: new Date().toISOString(),
  seed,
  rounds,
  activeTabs,
  foregroundSteps,
  type: 'browser-contract evaluation with deterministic expert policies; no model benchmark',
  cases: [],
  modelCalls: 0,
  metrics: {},
};
async function grade(name, action) {
  const began = performance.now();
  try {
    await action();
    report.cases.push({ name, passed: true, durationMs: Math.round(performance.now() - began) });
  } catch (error) {
    report.cases.push({
      name,
      passed: false,
      error: error.message.slice(0, 2000),
      durationMs: Math.round(performance.now() - began),
    });
  }
}

await withBrowserFixture(serve, async ({ call: invoke, origin, context }) => {
  const durations = new Map();
  const call = async (name, args = {}) => {
    const began = performance.now();
    try {
      const result = await invoke(name, args);
      if (name === 'browser_step' && result.timings)
        for (const [stage, elapsed] of Object.entries(result.timings)) {
          const key = `${name}.${stage}`;
          const samples = durations.get(key) || [];
          samples.push(elapsed);
          durations.set(key, samples);
        }
      return result;
    } finally {
      const samples = durations.get(name) || [];
      samples.push(performance.now() - began);
      durations.set(name, samples);
    }
  };
  report.browser = context.browser().version();
  report.node = process.version;
  const open = async (url) => {
    const tab = await call('browser_open', { url, active: activeTabs });
    await call('browser_wait', { tabId: tab.tabId, state: 'domcontentloaded' });
    return tab;
  };
  const close = (tab) => call('browser_tab', { tabId: tab.tabId, operation: 'close' });
  for (let round = 0; round < rounds; round++) {
    await grade(`form-${round}`, async () => {
      const tab = await open(`${origin}/app/${round}`);
      const tabId = tab.tabId;
      try {
        const before = await call('browser_snapshot', { tabId, scopeSelector: 'main' });
        const ref = (name) => {
          const element = before.elements.find((el) => el.name === name);
          assert(element, name);
          return element.ref;
        };
        const expected = {
          project: `Project ${seed}-${round}`,
          owner: `Owner ${round}`,
          plan: round % 2 ? 'urgent' : 'normal',
          remember: round % 3 === 0,
          trusted: true,
          commits: 1,
        };
        const filled = await call('browser_fill_form', {
          tabId,
          fields: [
            { kind: 'text', ref: ref('Project'), value: expected.project },
            { kind: 'text', ref: ref('Owner'), value: expected.owner },
            { kind: 'select', ref: ref('Plan'), value: expected.plan },
            { kind: 'check', ref: ref('Remember request'), value: expected.remember },
          ],
          observation: { scopeSelector: 'main' },
        });
        assert.equal(filled.outcome, 'filled');
        assert.equal(
          await (await fetch(`${origin}/grade/${round}`)).json(),
          null,
          'Filling must not submit',
        );
        const submitted = await call('browser_step', {
          tabId,
          foreground: foregroundSteps,
          action: {
            name: 'browser_click',
            args: { ref: filled.snapshot.elements.find((el) => el.name === 'Save request').ref },
          },
          wait: { text: `Saved record: ${round}`, timeoutMs: 3000 },
          observation: { scopeSelector: 'main' },
        });
        assert.equal(submitted.outcome, 'observed');
        assert.deepEqual(await (await fetch(`${origin}/grade/${round}`)).json(), expected);
        const links = await call('browser_extract', { tabId, kind: 'links' });
        assert(links.items.some((link) => link.url === `${origin}/help`));
        const images = await call('browser_extract', { tabId, kind: 'images' });
        assert(images.items.some((image) => image.loaded && image.width === 1));
        assert(
          !JSON.stringify(images).includes(pixel),
          'Metadata must not contain inline image bytes',
        );
      } finally {
        await close(tab);
      }
    });
    if (round % 10 === 9)
      console.log(`Evaluated ${round + 1}/${rounds} independent form workflows`);
  }
  await grade('structured-table-and-shadow-extraction', async () => {
    const tab = await open(`${origin}/inventory`);
    try {
      const extracted = await call('browser_extract', {
        tabId: tab.tabId,
        kind: 'tables',
        scopeSelector: '#inventory',
      });
      assert.deepEqual(extracted.tables[0].rows.slice(1), inventory);
      const shadow = await call('browser_extract', {
        tabId: tab.tabId,
        kind: 'tables',
        scopeSelector: '#shadow',
      });
      assert.deepEqual(shadow.tables[0].rows, [['Shadow record', '17']]);
      const bounded = await call('browser_extract', {
        tabId: tab.tabId,
        kind: 'tables',
        maxItems: 3,
      });
      assert(bounded.truncated);
      assert(bounded.tables.flatMap((table) => table.rows).length <= 3);
    } finally {
      await close(tab);
    }
  });
  await grade('six-tab-concurrent-observation', async () => {
    const tabs = [];
    try {
      for (let i = 0; i < 6; i++) tabs.push(await open(`${origin}/app/multi-${i}`));
      const result = await call('browser_batch', {
        commands: tabs.map((tab) => ({
          name: 'browser_snapshot',
          args: { tabId: tab.tabId, scopeSelector: 'main' },
        })),
      });
      assert.equal(result.results.length, 6);
      result.results.forEach((entry, index) => {
        assert(!entry.error);
        assert(entry.result.text.includes(`Create request multi-${index}`));
      });
      const groups = await call('browser_groups');
      assert(groups.groups.some((group) => group.tabIds.length >= 6));
    } finally {
      for (const tab of tabs) await close(tab);
    }
  });
  await grade('popup-discovery-and-explicit-group-ownership', async () => {
    const parent = await call('browser_open', { url: `${origin}/popup` });
    let popup;
    try {
      await call('browser_wait', { tabId: parent.tabId, selector: 'button' });
      await call('browser_click', { tabId: parent.tabId, selector: 'button' });
      for (let i = 0; !popup && i < 30; i++) {
        popup = (await call('browser_tabs')).tabs.find(
          (tab) => tab.openerTabId === parent.tabId && tab.url.startsWith(`${origin}/help`),
        );
        if (!popup) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(popup, 'The agent must be able to identify the new tab by opener');
      await call('browser_wait', { tabId: popup.id, text: 'Help page opened successfully' });
      await call('browser_group_tabs', { tabIds: [popup.id], groupId: parent.groupId });
      assert(
        (await call('browser_tabs')).tabs.find((tab) => tab.id === popup.id).groupId ===
          parent.groupId,
      );
    } finally {
      if (popup) await close({ tabId: popup.id });
      await close(parent);
    }
  });
  report.metrics.operationTimings = Object.fromEntries(
    [...durations].map(([name, samples]) => {
      samples.sort((a, b) => a - b);
      return [
        name,
        {
          samples: samples.length,
          medianMs: +samples[Math.floor(samples.length / 2)].toFixed(2),
          p95Ms:
            +samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)].toFixed(2),
        },
      ];
    }),
  );
});
report.passed = report.cases.filter((entry) => entry.passed).length;
report.failed = report.cases.length - report.passed;
for (const [profile, categories] of [
  ['core', ['core']],
  ['full', null],
]) {
  const tools = definitions(false, categories);
  report.metrics[`${profile}ToolDefinitions`] = {
    count: tools.length,
    bytes: Buffer.byteLength(JSON.stringify(tools)),
  };
}
const output = path.join(root, 'artifacts', `evaluation-${label}-${seed}-${rounds}.json`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    passed: report.passed,
    failed: report.failed,
    total: report.cases.length,
    modelCalls: report.modelCalls,
    output,
  }),
);
for (const failure of report.cases.filter((entry) => !entry.passed))
  console.error(`${failure.name}: ${failure.error}`);
if (report.failed) process.exitCode = 1;
