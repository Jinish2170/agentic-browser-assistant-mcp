// Metered API evaluation against disposable extension-driven browser workflows.
// Ground truth stays in private fixture-server receipts, not model-visible HTML.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, root } from '../server/config.mjs';
import { Settings } from '../server/settings.mjs';
import { withBrowserFixture } from '../tests/browser-fixture.mjs';

const mode = process.argv[2] || 'fast';
assert(['fast', 'planner'].includes(mode));
const caseLimit = Number(process.argv[3] || 13);
assert(Number.isInteger(caseLimit) && caseLimit >= 1 && caseLimit <= 13);
const runLabel = process.argv[4] || 'final';
assert(/^[a-z0-9-]+$/.test(runLabel));
const config = await loadConfig();
const settings = new Settings(config);
await settings.load();
const key = settings.key(config.jev.apiKeyEnv, 'jev');
assert(key, 'Configure Jev in the private secret store first.');
const providerKey = mode === 'planner' ? settings.key(config.provider.apiKeyEnv, 'llm') : undefined;
if (mode === 'planner') assert(providerKey, 'Configure an LLM planner key first.');
const cases = [
  ...Array.from({ length: 8 }, (_, i) => ({
    family: 'native-form',
    name: `Orion ${i}`,
    plan: i % 2 ? 'pro' : 'basic',
    check: i % 2 === 0,
    reversed: i % 2 === 1,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({ family: 'duplicate-row', reversed: i % 2 === 1 })),
  ...Array.from({ length: 2 }, () => ({
    family: 'shadow-form',
    name: 'Shadow profile',
    plan: 'pro',
    check: true,
  })),
  { family: 'already-complete' },
].slice(0, caseLimit);
const receipts = new Map();
const report = {
  mode,
  runLabel,
  planner:
    mode === 'planner'
      ? {
          kind: config.provider.kind,
          baseUrl: config.provider.baseUrl,
          model: config.provider.model,
        }
      : undefined,
  reviewDate: '2026-10-06',
  measuredAt: new Date().toISOString(),
  cases: [],
};
await withBrowserFixture(
  async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname.startsWith('/receipt/')) {
      const id = url.pathname.split('/')[2];
      let body = '';
      for await (const chunk of req) body += chunk;
      const values = receipts.get(id) || [];
      values.push(JSON.parse(body));
      receipts.set(id, values);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const index = Number(url.pathname.slice(1));
    const c = cases[index];
    if (!c) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    const fields = [
      '<label>Name <input id="name"></label>',
      '<label>Plan <select id="plan"><option value="basic">Basic</option><option value="pro">Pro</option></select></label>',
      '<label><input id="check" type="checkbox">Updates</label>',
    ];
    if (c.reversed) fields.reverse();
    const form = `<form>${fields.join('')}<button>Save profile</button></form><p id="status"></p>`;
    const rows = [
      '<section><h2>Aurora project</h2><button data-record="aurora">Open</button></section>',
      '<section><h2>Luna project</h2><button data-record="luna">Open</button></section>',
    ];
    if (c.reversed) rows.reverse();
    const html =
      c.family === 'duplicate-row'
        ? rows.join('') + '<p id="status"></p>'
        : c.family === 'already-complete'
          ? '<p>Profile saved successfully</p>'
          : c.family === 'shadow-form'
            ? '<div id="host"></div>'
            : form;
    res.end(`<!doctype html><title>Fast engine fixture</title><style>body{font:16px system-ui;padding:30px}label{display:block;margin:20px}input,select,button{padding:10px}section{margin:20px}</style><main>${html}</main><script>
  let root=document;
  ${c.family === 'shadow-form' ? `root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML=${JSON.stringify(form)};` : ''}
  const record=async data=>{await fetch('/receipt/${index}',{method:'POST',body:JSON.stringify(data)});root.querySelector('#status').textContent=${JSON.stringify(c.family === 'duplicate-row' ? 'Aurora opened successfully' : 'Profile saved successfully')};};
  const form=root.querySelector('form');
  if(form){let trusted=false;form.querySelector('button').onclick=e=>trusted=e.isTrusted;form.onsubmit=e=>{e.preventDefault();record({name:root.querySelector('#name').value,plan:root.querySelector('#plan').value,check:root.querySelector('#check').checked,trusted});};}
  for(const b of root.querySelectorAll('[data-record]'))b.onclick=e=>record({record:b.dataset.record,trusted:e.isTrusted});
  </script>`);
  },
  async ({ call, origin, context, config: fixtureConfig }) => {
    report.browser = context.browser().version();
    const { apiKeyEnv, ...provider } = fixtureConfig.provider;
    const response = await fetch(`http://127.0.0.1:${fixtureConfig.port}/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${fixtureConfig.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider:
          mode === 'planner'
            ? {
                kind: config.provider.kind,
                baseUrl: config.provider.baseUrl,
                model: config.provider.model,
                apiKey: providerKey,
              }
            : provider,
        jev: {
          enabled: true,
          endpoint: config.jev.endpoint,
          model: config.jev.model,
          confidenceThreshold: config.jev.confidenceThreshold,
          apiKey: key,
        },
      }),
    });
    assert.equal(response.status, 200);
    for (const [index, c] of cases.entries()) {
      const tab = await call('browser_open', { url: `${origin}/${index}`, active: true });
      try {
        await call('browser_wait', { tabId: tab.tabId, state: 'domcontentloaded' });
        const text =
          c.family === 'duplicate-row'
            ? 'Aurora opened successfully'
            : 'Profile saved successfully';
        const began = performance.now();
        const goal =
          c.family === 'duplicate-row'
            ? 'Open the Aurora project record.'
            : c.family === 'already-complete'
              ? 'Verify the profile is saved.'
              : `Fill Name with ${JSON.stringify(c.name)}, select the Plan option with value ${JSON.stringify(c.plan)}, set Updates checkbox to ${c.check}, then click Save profile. Verify Profile saved successfully.`;
        const task = await call(
          mode === 'planner' ? 'browser_run' : 'browser_fast_run',
          mode === 'planner'
            ? { tabId: tab.tabId, goal }
            : {
                tabId: tab.tabId,
                goal,
                fields: ['native-form', 'shadow-form'].includes(c.family)
                  ? [
                      { label: 'Name', kind: 'text', value: c.name },
                      { label: 'Plan', kind: 'select', value: c.plan },
                      { label: 'Updates', kind: 'check', value: c.check },
                    ]
                  : [],
                clickLabels: [c.family === 'duplicate-row' ? 'Open' : 'Save profile'],
                success: [{ kind: 'text', text }],
                maxSteps: 5,
                maxRequests: 5,
                timeoutMs: 20000,
              },
        );
        let finished;
        for (let poll = 0; poll < (mode === 'planner' ? 2400 : 450); poll++) {
          const data = await call('browser_task', { id: task.id });
          if (data.status !== 'running') {
            finished = data;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert(finished, 'Task did not finish within the evaluation poll budget');
        // Task status may become final before its durable checkpoint releases ownership.
        for (let i = 0; (await call('browser_status')).taskRunning && i < 100; i++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        const received = receipts.get(String(index)) || [];
        const correct =
          c.family === 'already-complete'
            ? received.length === 0
            : received.length === 1 &&
              received[0].trusted &&
              (c.family === 'duplicate-row'
                ? received[0].record === 'aurora'
                : received[0].name === c.name &&
                  received[0].plan === c.plan &&
                  received[0].check === c.check);
        report.cases.push({
          index,
          family: c.family,
          passed:
            (mode === 'planner'
              ? finished.status === 'completed'
              : finished.outcome === 'verified') && correct,
          elapsedMs: +(performance.now() - began).toFixed(2),
          outcome: finished.outcome,
          status: finished.status,
          summary: finished.summary,
          jev: finished.jev || {
            requests: finished.events.filter((e) => e.type === 'jev').length,
            inputTokens: finished.events.reduce(
              (sum, e) => sum + (e.type === 'jev' ? e.usage?.input_tokens || 0 : 0),
              0,
            ),
            outputTokens: finished.events.reduce(
              (sum, e) => sum + (e.type === 'jev' ? e.usage?.output_tokens || 0 : 0),
              0,
            ),
          },
          plannerUsage: finished.usage,
          timings: finished.timings,
          decisions: finished.events.filter((e) => ['jev_decision', 'jev'].includes(e.type)),
          actions: finished.ledger.actions,
          receipts: received,
          verification: finished.verification,
        });
        console.log(
          `${mode} workflow ${index + 1}/${cases.length}: ${finished.outcome || finished.status}, independently graded ${correct ? 'correct' : 'incomplete'}`,
        );
      } finally {
        await call('browser_tab', { tabId: tab.tabId, operation: 'close' });
      }
    }
  },
);
report.passed = report.cases.filter((c) => c.passed).length;
report.failed = report.cases.length - report.passed;
const times = report.cases.map((c) => c.elapsedMs).sort((a, b) => a - b);
report.medianMs = times[Math.floor(times.length / 2)];
report.p95Ms = times[Math.ceil(times.length * 0.95) - 1];
report.modelCalls = report.cases.reduce((sum, c) => sum + c.jev.requests, 0);
report.inputTokens = report.cases.reduce((sum, c) => sum + c.jev.inputTokens, 0);
report.outputTokens = report.cases.reduce((sum, c) => sum + c.jev.outputTokens, 0);
report.estimatedJevInputCostUSD = (report.inputTokens * 0.042) / 1e6;
report.plannerInputTokens = report.cases.reduce(
  (sum, c) => sum + (c.plannerUsage?.inputTokens || 0),
  0,
);
report.plannerOutputTokens = report.cases.reduce(
  (sum, c) => sum + (c.plannerUsage?.outputTokens || 0),
  0,
);
report.families = Object.fromEntries(
  [...new Set(cases.map((c) => c.family))].map((family) => {
    const rows = report.cases.filter((c) => c.family === family);
    return [family, { passed: rows.filter((c) => c.passed).length, total: rows.length }];
  }),
);
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const output = path.join(root, `artifacts/jev-${mode}-${runLabel}-2026-10-06.json`);
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
