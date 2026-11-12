import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRunner } from '../server/agent.mjs';
import { defaults } from '../server/config.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (name, args = {}) => ({
  text: '',
  calls: [{ id: 'test-call', name, arguments: args }],
});
const finished = (success = true, evidence = 'Saved request') =>
  call('finish_task', { summary: 'Saved the requested form', evidence, success });

function harness(turns, overrides = {}) {
  const commands = [];
  const snapshots = [
    { url: 'https://example.com', title: 'Test form', text: 'Fill this form', elements: [] },
    { url: 'https://example.com', title: 'Test form', text: 'Saved request', elements: [] },
  ];
  let snapshotIndex = 0;
  const browser = {
    connected: true,
    command: async (command) => {
      commands.push(command);
      if (command.name === 'browser_snapshot')
        return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
      return { ok: true };
    },
  };
  const runner = new TaskRunner({
    config: { ...defaults, agent: { ...defaults.agent, maxSteps: 8 }, ...overrides.config },
    browser,
    jev: { enabled: false, observation: async () => ({ accepted: false }) },
    getKey: () => 'key',
    sessionFactory: () => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      observe() {},
      contextSize: () => 100,
      results() {},
      next: async () => turns.shift() || finished(false, 'Incomplete'),
    }),
    ...overrides,
  });
  return { runner, browser, commands };
}

async function outcome(runner, id) {
  for (let i = 0; i < 100; i++) {
    const task = runner.get(id);
    if (task.status !== 'running') return task;
    await pause(10);
  }
  throw new Error('Test task did not finish');
}

test('task observes after a mutation and requires observed success evidence', async () => {
  const { runner, commands } = harness([
    call('browser_click', { tabId: 1, x: 10, y: 10 }),
    finished(),
  ]);
  const task = await outcome(runner, (await runner.start({ goal: 'save form', tabId: 1 })).id);
  assert.equal(task.status, 'completed');
  assert.equal(task.evidence, 'Saved request');
  assert.deepEqual(
    commands.map((c) => c.name),
    [
      'browser_wait',
      'browser_snapshot',
      'browser_click',
      'browser_wait',
      'browser_snapshot',
      'browser_snapshot',
    ],
  );
});

test('unobserved evidence is rejected and agent can report blocked honestly', async () => {
  const { runner } = harness([
    finished(true, 'Invented success'),
    finished(false, 'Unable to verify'),
  ]);
  const task = await outcome(runner, (await runner.start({ goal: 'save form', tabId: 1 })).id);
  assert.equal(task.status, 'blocked');
  assert.equal(
    task.events.some((e) => e.type === 'tool_error' && /EVIDENCE_REQUIRED/.test(e.message)),
    true,
  );
});

test('a timeout stops the task and the mutation is never replayed', async () => {
  const { runner, browser, commands } = harness([
    call('browser_click', { tabId: 1, x: 10, y: 10 }),
    finished(),
  ]);
  const original = browser.command;
  browser.command = async (command) => {
    if (command.name === 'browser_click') {
      commands.push(command);
      throw new Error('COMMAND_TIMEOUT: unknown outcome');
    }
    return original(command);
  };
  const task = await outcome(runner, (await runner.start({ goal: 'save form', tabId: 1 })).id);
  assert.equal(task.status, 'failed');
  assert.equal(commands.filter((c) => c.name === 'browser_click').length, 1);
});

test('cancellation waits for a dispatched action and prevents the next action', async () => {
  let release;
  const { runner, browser, commands } = harness([
    call('browser_click', { tabId: 1, x: 10, y: 10 }),
    call('browser_type', { tabId: 1, selector: 'input', text: 'bad' }),
  ]);
  const original = browser.command;
  browser.command = async (command) => {
    if (command.name === 'browser_click') {
      commands.push(command);
      await new Promise((resolve) => {
        release = resolve;
      });
      return {};
    }
    return original(command);
  };
  const task = await runner.start({ goal: 'fill form', tabId: 1 });
  while (!release) await pause(5);
  await assert.rejects(() => runner.start({ goal: 'other task', tabId: 1 }), /BUSY/);
  runner.cancel(task.id);
  release();
  assert.equal((await outcome(runner, task.id)).status, 'cancelled');
  assert.equal(
    commands.some((c) => c.name === 'browser_type'),
    false,
  );
});

test('step budget bounds an agent that keeps reading', async () => {
  const { runner } = harness(
    Array.from({ length: 9 }, () => call('browser_tabs')),
    { config: { ...defaults, agent: { ...defaults.agent, maxSteps: 2 } } },
  );
  const task = await outcome(runner, (await runner.start({ goal: 'read', tabId: 1 })).id);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /STEP_BUDGET/);
});

test('user updates arriving during a provider turn are applied before finishing', async () => {
  const messages = [];
  let release;
  let turn = 0;
  const { runner } = harness([], {
    sessionFactory: () => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      observe() {},
      contextSize: () => 100,
      results() {},
      appendUser: (text) => messages.push(text),
      next: async () => {
        if (turn++ === 0) {
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return finished(false, 'Stopped as requested');
      },
    }),
  });
  const task = await runner.start({ goal: 'Research choices', tabId: 1 });
  while (!release) await pause(5);
  await runner.message(task.id, 'Stop research and summarize what you saw');
  release();
  const result = await outcome(runner, task.id);
  assert.equal(result.status, 'blocked');
  assert(messages.some((text) => text.includes('Stop research')));
  assert(
    result.events.some(
      (event) => event.type === 'tool_error' && /TASK_UPDATED/.test(event.message),
    ),
  );
});

test('long context is compacted before the next model turn and the active goal remains pinned', async () => {
  let size = 9000;
  let compactions = 0;
  const pinned = [];
  const { runner } = harness([], {
    config: { ...defaults, agent: { ...defaults.agent, maxInputChars: 10000 } },
    sessionFactory: () => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      observe() {},
      contextSize: () => size,
      results() {},
      appendUser: (text) => pinned.push(text),
      compact: async () => {
        size = 500;
        compactions++;
      },
      next: async () => finished(false, 'Summary only'),
    }),
  });
  const task = await outcome(
    runner,
    (await runner.start({ goal: 'Compare details across tabs', tabId: 1 })).id,
  );
  assert.equal(compactions, 1);
  assert(pinned[0].includes('Compare details across tabs'));
  assert(task.events.some((event) => event.type === 'compaction'));
});

test('compound action snapshot is reused without an extra wait/observation turn', async () => {
  const { runner, browser, commands } = harness([
    call('browser_step', {
      tabId: 1,
      action: { name: 'browser_click', args: { selector: '#save' } },
      wait: { text: 'Saved request' },
    }),
    finished(),
  ]);
  const original = browser.command;
  browser.command = async (command) => {
    if (command.name === 'browser_step') {
      commands.push(command);
      return {
        outcome: 'observed',
        snapshot: { title: 'Test form', text: 'Saved request', url: 'https://example.com' },
      };
    }
    return original(command);
  };
  const task = await outcome(runner, (await runner.start({ goal: 'save form', tabId: 1 })).id);
  assert.equal(task.status, 'completed');
  assert.equal(commands.filter((c) => c.name === 'browser_wait').length, 1);
  // Initial snapshot plus independent fresh finish verification.
  assert.equal(commands.filter((c) => c.name === 'browser_snapshot').length, 2);
  assert(task.timings.modelMs >= 0);
});

test('progress is readable while the planner response is pending', async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const { runner } = harness([], {
    sessionFactory: () => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      observe() {},
      contextSize: () => 100,
      results() {},
      next: () => waiting,
    }),
  });
  const started = await runner.start({ goal: 'inspect current page', tabId: 1 });
  for (let i = 0; i < 30 && runner.get(started.id).progress.stage !== 'planning'; i++)
    await pause(5);
  const pending = runner.get(started.id);
  assert.equal(pending.status, 'running');
  assert.equal(pending.progress.stage, 'planning');
  assert(pending.events.some((event) => event.stage === 'observing'));
  release(finished(false));
  await outcome(runner, started.id);
});

test('a compound explicit URL opens before the first planner request and retargets observation', async () => {
  const order = [];
  const { runner } = harness([], {
    browser: {
      connected: true,
      command: async (command) => {
        order.push(command);
        return command.name === 'browser_open'
          ? { tabId: 22 }
          : { url: 'https://example.com/', title: 'Example page', text: 'Ready', elements: [] };
      },
    },
    sessionFactory: () => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      observe() {},
      appendUser(text) {
        order.push({ name: 'receipt', text });
      },
      contextSize: () => 100,
      results() {},
      next: async () => {
        order.push({ name: 'planner' });
        return finished(false);
      },
    }),
  });
  const task = await outcome(
    runner,
    (await runner.start({ goal: 'open https://example.com/ and sign in', tabId: 1 })).id,
  );
  assert.equal(order[0].name, 'browser_open');
  assert.equal(order.find((entry) => entry.name === 'browser_snapshot').args.tabId, 22);
  assert(
    order.findIndex((entry) => entry.name === 'browser_open') <
      order.findIndex((entry) => entry.name === 'planner'),
  );
  assert.equal(task.ledger.actions.length, 1);
});

test('a pure explicit URL opening completes with a fresh page read and no provider call', async () => {
  let requests = 0;
  const { runner } = harness([], {
    browser: {
      connected: true,
      command: async (command) =>
        command.name === 'browser_open'
          ? { tabId: 22 }
          : { url: 'https://example.com/', title: 'Example page', text: 'Ready', elements: [] },
    },
    sessionFactory: () => {
      requests++;
      throw new Error('Provider must not be needed');
    },
  });
  const task = await outcome(
    runner,
    (await runner.start({ goal: 'open https://example.com/', tabId: 1 })).id,
  );
  assert.equal(task.status, 'completed');
  assert.equal(requests, 0);
  assert.equal(task.evidence, 'Example page');
});

test('a known pre-input block can recover with fresh DOM and vision without unconfirmed replay', async () => {
  let writes = 0,
    images = 0;
  const { runner } = harness(
    [
      call('browser_step', {
        tabId: 1,
        action: { name: 'browser_click', args: { selector: '#login' } },
      }),
      finished(false),
    ],
    {
      browser: {
        connected: true,
        command: async (command) => {
          if (command.name === 'browser_step') {
            writes++;
            return {
              outcome: 'action_blocked',
              action: {
                mutationOutcome: 'not_dispatched',
                error: 'ELEMENT_OCCLUDED: cookie dialog',
              },
              error: 'ELEMENT_OCCLUDED: cookie dialog',
              snapshot: { url: 'https://example.com', text: 'Cookie choices', elements: [] },
            };
          }
          if (command.name === 'browser_screenshot') {
            images++;
            return { image: 'image' };
          }
          return {
            url: 'https://example.com',
            title: 'Test form',
            text: 'Cookie choices',
            elements: [],
          };
        },
      },
    },
  );
  const task = await outcome(runner, (await runner.start({ goal: 'log in', tabId: 1 })).id);
  assert.equal(task.status, 'blocked');
  assert.equal(writes, 1);
  assert.equal(images, 1);
  assert.equal(task.ledger.actions[0].state, 'not_dispatched');
});

test('direct input errors cannot be replayed without a proven pre-input receipt', async () => {
  for (const proven of [false, true]) {
    let clicks = 0;
    const { runner } = harness(
      [call('browser_click', { tabId: 1, selector: '#login' }), finished(false)],
      {
        browser: {
          connected: true,
          command: async (command) => {
            if (command.name === 'browser_click') {
              clicks++;
              throw Object.assign(
                new Error('ELEMENT_OCCLUDED: dialog'),
                proven ? { mutationOutcome: 'not_dispatched' } : {},
              );
            }
            if (command.name === 'browser_screenshot') return { image: 'image' };
            return {
              url: 'https://example.com',
              title: 'Login',
              text: 'Cookie choices',
              elements: [],
            };
          },
        },
      },
    );
    const task = await outcome(runner, (await runner.start({ goal: 'log in', tabId: 1 })).id);
    assert.equal(task.status, proven ? 'blocked' : 'failed');
    assert.equal(task.ledger.actions[0].state, proven ? 'not_dispatched' : 'unconfirmed');
    assert.equal(clicks, 1);
  }
});

test('unknown startup outcome never opens another tab or invokes the planner', async () => {
  let opens = 0,
    planners = 0;
  const { runner } = harness([], {
    browser: {
      connected: true,
      command: async () => {
        opens++;
        throw new Error('COMMAND_TIMEOUT: opening outcome unknown');
      },
    },
    sessionFactory: () => {
      planners++;
    },
  });
  const task = await outcome(
    runner,
    (await runner.start({ goal: 'open https://example.com/', tabId: 1 })).id,
  );
  assert.equal(task.status, 'failed');
  assert.equal(task.ledger.actions[0].state, 'unconfirmed');
  assert.equal(opens, 1);
  assert.equal(planners, 0);
});
