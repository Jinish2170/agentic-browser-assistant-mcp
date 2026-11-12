import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForState } from '../extension/wait.mjs';
import { parseCommand } from '../shared/tools.mjs';

function fixture(overrides = {}) {
  let clock = 0;
  const sleeps = [];
  return {
    now: () => clock,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    check: async () => ({ status: 'complete' }),
    navigation: () => null,
    inspect: async () => ({ ready: clock >= 120 }),
    ...overrides,
  };
}
test('wait responds to early state updates and bounds every sleep by its deadline', async () => {
  const deps = fixture();
  const result = await waitForState({ timeoutMs: 1000 }, deps);
  assert.equal(result.elapsedMs, 150);
  assert.equal(result.polls, 4);
  assert.deepEqual(deps.sleeps, [50, 50, 50]);
  const timeout = fixture({ inspect: async () => ({ ready: false }) });
  await assert.rejects(waitForState({ timeoutMs: 125 }, timeout), /WAIT_TIMEOUT/);
  assert.equal(timeout.now(), 125);
  assert.deepEqual(timeout.sleeps, [50, 50, 25]);
});
test('wait backs off, preserves navigation commit guards and stops when access is revoked', async () => {
  const timeout = fixture({
    navigation: () => ({ committed: false }),
    inspect: async () => {
      throw new Error('Premature observation');
    },
  });
  await assert.rejects(waitForState({ timeoutMs: 1000 }, timeout), /WAIT_TIMEOUT/);
  assert(timeout.sleeps.includes(200));
  let probes = 0;
  const revoked = fixture({
    check: async () => {
      if (probes++ > 0) throw new Error('PAUSED');
      return {};
    },
    inspect: async () => ({ ready: false }),
  });
  await assert.rejects(waitForState({ timeoutMs: 1000 }, revoked), /PAUSED/);
  assert.equal(revoked.now(), 50);
});
test('invalid compound wait/image arguments fail before any action can dispatch', () => {
  assert.throws(
    () =>
      parseCommand({
        name: 'browser_step',
        args: {
          tabId: 1,
          action: { name: 'browser_click', args: { selector: '#save' } },
          wait: { condition: 'detached' },
        },
      }),
    /WAIT_ARGUMENTS/,
  );
  assert.throws(
    () => parseCommand({ name: 'browser_screenshot', args: { tabId: 1, quality: 80 } }),
    /SCREENSHOT_ARGUMENTS/,
  );
  assert.equal(
    parseCommand({
      name: 'browser_wait',
      args: { tabId: 1, selector: '#spinner', condition: 'hidden' },
    }).args.condition,
    'hidden',
  );
});
