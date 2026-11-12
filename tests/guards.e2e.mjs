import assert from 'node:assert/strict';
import { withBrowserFixture } from './browser-fixture.mjs';
let clicked = 0;
await withBrowserFixture(
  (req, res) => {
    if (req.url === '/receipt') {
      clicked++;
      res.end('ok');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<title>Target guards</title><main><h1>Original row</h1><label>Name <input value="Original"></label><button onclick="fetch(\'/receipt\',{method:\'POST\'})">Save</button></main>',
    );
  },
  async ({ call, context, origin }) => {
    const tab = await call('browser_open', { url: origin, active: true });
    await call('browser_wait', { tabId: tab.tabId, state: 'domcontentloaded' });
    const page = context.pages().find((p) => p.url().startsWith(origin));
    for (const mutation of ['name', 'context', 'value']) {
      await page.evaluate(() => {
        document.querySelector('button').textContent = 'Save';
        document.querySelector('h1').textContent = 'Original row';
        document.querySelector('input').value = 'Original';
      });
      const observation = await call('browser_snapshot', {
        tabId: tab.tabId,
        includeContext: true,
      });
      const button = observation.elements.find((e) => e.name === 'Save');
      const input = observation.elements.find((e) => e.name === 'Name');
      await page.evaluate((m) => {
        if (m === 'name') document.querySelector('button').textContent = 'Delete';
        else if (m === 'context') document.querySelector('h1').textContent = 'Different row';
        else document.querySelector('input').value = 'Unexpected';
      }, mutation);
      await assert.rejects(
        call('browser_click', {
          tabId: tab.tabId,
          ref: button.ref,
          expected: { name: button.name, contextText: button.context.text },
          preconditions: [{ ref: input.ref, expected: { name: input.name, value: 'Original' } }],
        }),
        /TARGET_CHANGED/,
      );
      assert.equal(clicked, 0);
    }
    await page.evaluate(() => {
      document.querySelector('input').value = 'Original';
    });
    const observation = await call('browser_snapshot', { tabId: tab.tabId, includeContext: true });
    const input = observation.elements.find((e) => e.name === 'Name');
    const result = await call('browser_fill_form', {
      tabId: tab.tabId,
      foreground: true,
      fields: [
        {
          kind: 'text',
          ref: input.ref,
          value: 'Changed',
          expected: { name: input.name, value: 'Original', contextText: input.context.text },
        },
      ],
    });
    assert.equal(result.outcome, 'filled');
    assert.equal(result.snapshot.elements.find((e) => e.name === 'Name').value, 'Changed');
    assert.equal(clicked, 0);
    console.log(
      'PASS: changed target name, row context and related field values block input; guarded form verification accepts its new value',
    );
  },
);
