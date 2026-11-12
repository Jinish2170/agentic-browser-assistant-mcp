import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, batchCommands } from '../shared/tools.mjs';
import { executeStep } from '../extension/step.mjs';

const args = () =>
  parseCommand({
    name: 'browser_step',
    args: {
      tabId: 1,
      action: { name: 'browser_click', args: { selector: '#save' } },
      wait: { text: 'Saved', timeoutMs: 1000 },
      observation: { scopeSelector: 'main' },
    },
  }).args;

test('step validates every stage before dispatch and forbids arbitrary action tools', () => {
  assert.throws(() =>
    parseCommand({
      name: 'browser_step',
      args: {
        ...args(),
        action: { name: 'browser_evaluate', args: { expression: 'bad()' } },
      },
    }),
  );
  assert.throws(() =>
    parseCommand({ name: 'browser_step', args: { ...args(), wait: { timeoutMs: -1 } } }),
  );
  assert.throws(() =>
    parseCommand({
      name: 'browser_step',
      args: {
        ...args(),
        action: { name: 'browser_click', args: { tabId: 2, selector: '#save' } },
      },
    }),
  );
});

test('step returns an observed result after exactly one mutation and the explicit wait', async () => {
  const calls = [];
  const result = await executeStep(args(), async (command) => {
    calls.push(command);
    return command.name === 'browser_wait' ? { ready: true } : { text: 'Saved' };
  });
  assert.equal(result.outcome, 'observed');
  assert.equal(result.snapshot.text, 'Saved');
  assert.deepEqual(Object.keys(result.timings), ['actionMs', 'waitMs', 'observationMs']);
  assert(Object.values(result.timings).every((value) => Number.isFinite(value) && value >= 0));
  assert.deepEqual(
    calls.map((c) => c.name),
    ['browser_click', 'browser_wait', 'browser_snapshot'],
  );
  assert(calls.every((c) => c.args.tabId === 1));
});

test('unmet condition preserves successful action and fresh state without replay', async () => {
  const calls = [];
  const result = await executeStep(args(), async (command) => {
    calls.push(command.name);
    if (command.name === 'browser_wait') throw new Error('WAIT_TIMEOUT: Condition was not met');
    return { text: 'Still saving' };
  });
  assert.equal(result.outcome, 'condition_not_met');
  assert.equal(result.snapshot.text, 'Still saving');
  assert.equal(result.wait.ready, false);
  assert.equal(calls.filter((c) => c === 'browser_click').length, 1);
});

test('unconfirmed action or revoked access stops the compound operation immediately', async () => {
  for (const stage of ['browser_click', 'browser_wait']) {
    const calls = [];
    const result = await executeStep(args(), async (command) => {
      calls.push(command.name);
      if (command.name === stage) throw new Error('ACCESS_REQUIRED: revoked');
      return {};
    });
    assert.equal(result.outcome, stage === 'browser_click' ? 'action_error' : 'wait_error');
    assert(!calls.includes('browser_snapshot'));
  }
});

test('pending dialogs stop before waits so the agent can handle them', async () => {
  let calls = 0;
  const result = await executeStep(args(), async () => {
    calls++;
    return { pendingDialog: { type: 'confirm', message: 'Continue?' } };
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'pending_dialog');
});

test('foreground step activates before one action and refuses shared-state parallel batches', async () => {
  const foreground = { ...args(), foreground: true };
  const calls = [];
  const result = await executeStep(foreground, async (command) => {
    calls.push(command);
    return command.name === 'browser_wait' ? { ready: true } : { text: 'Saved' };
  });
  assert.equal(result.outcome, 'observed');
  assert.deepEqual(
    calls.map((call) => call.name),
    ['browser_tab', 'browser_click', 'browser_wait', 'browser_snapshot'],
  );
  assert.equal(calls[0].args.operation, 'activate');
  assert.throws(
    () => batchCommands({ commands: [{ name: 'browser_step', args: foreground }] }),
    /BATCH_SHARED_STATE/,
  );
  assert.throws(
    () =>
      batchCommands({
        commands: [
          {
            name: 'browser_fill_form',
            args: {
              tabId: 1,
              foreground: true,
              fields: [{ kind: 'text', selector: '#name', value: 'Fixture' }],
            },
          },
        ],
      }),
    /BATCH_SHARED_STATE/,
  );
});

test('failed activation never dispatches the goal action', async () => {
  const calls = [];
  const result = await executeStep({ ...args(), foreground: true }, async (command) => {
    calls.push(command.name);
    throw new Error('ACCESS_REQUIRED: revoked');
  });
  assert.equal(result.outcome, 'activation_error');
  assert.equal(result.action.mutationOutcome, 'not_dispatched');
  assert.deepEqual(calls, ['browser_tab']);
});

test('proven pre-input occlusion returns a fresh read without retrying input', async () => {
  const calls = [];
  const result = await executeStep(args(), async (command) => {
    calls.push(command.name);
    if (command.name === 'browser_click')
      throw Object.assign(new Error('ELEMENT_OCCLUDED: Cookie dialog'), {
        mutationOutcome: 'not_dispatched',
      });
    return { text: 'Cookie choices', elements: [] };
  });
  assert.equal(result.outcome, 'action_blocked');
  assert.equal(result.action.mutationOutcome, 'not_dispatched');
  assert.equal(result.snapshot.text, 'Cookie choices');
  assert.deepEqual(calls, ['browser_click', 'browser_snapshot']);
});

test('an occlusion-looking error after input remains uncertain without an explicit boundary receipt', async () => {
  const calls = [];
  const result = await executeStep(args(), async (command) => {
    calls.push(command.name);
    throw new Error('ELEMENT_OCCLUDED: late error');
  });
  assert.equal(result.outcome, 'action_error');
  assert.equal(result.action.mutationOutcome, 'unconfirmed');
  assert.deepEqual(calls, ['browser_click']);
});
