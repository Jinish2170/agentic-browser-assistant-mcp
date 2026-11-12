import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fastInput,
  compileCandidates,
  verifyPredicates,
  executeFastTask,
} from '../server/fast-engine.mjs';
import { TaskLedger } from '../server/task-ledger.mjs';
import { TaskRunner } from '../server/agent.mjs';
import { defaults } from '../server/config.mjs';

const snapshot = (
  text = 'Pending form',
  elements = [{ ref: 'b:1', name: 'Save', tag: 'button', role: 'button' }],
) => ({ url: 'https://fixture.example/', title: 'Fixture', text, elements });
const spec = (extra = {}) =>
  fastInput.parse({
    goal: 'Save supplied details',
    tabId: 1,
    clickLabels: ['Save'],
    success: [{ kind: 'text', text: 'Saved request' }],
    ...extra,
  });
function harness(overrides = {}) {
  const task = { goal: 'Save supplied details' };
  const ledger = new TaskLedger(task);
  const commands = [];
  let saved = false;
  const browser = {
    command: async (command) => {
      commands.push(command);
      if (command.name === 'browser_step' || command.name === 'browser_fill_form') {
        saved = true;
        return { outcome: 'observed' };
      }
      return command.name === 'browser_snapshot'
        ? snapshot(saved ? 'Saved request' : 'Pending form')
        : {};
    },
  };
  const jev = {
    enabled: true,
    metrics: { requests: 0, attempts: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 },
    choose: async () => {
      jev.metrics.requests++;
      jev.metrics.attempts++;
      return { choice: 'a1', confidence: 0.99, topProbability: 0.99, model: 'fixture' };
    },
  };
  const args = {
    spec: spec(),
    task,
    ledger,
    browser,
    jev,
    signal: new AbortController().signal,
    ...overrides,
  };
  return { task, commands, args, jev, run: () => executeFastTask(args) };
}

test('caller fields gate submission; unique writable targets retain pre-input guards', () => {
  const field = {
    ref: 'f:1',
    name: 'Name',
    tag: 'input',
    type: 'text',
    value: '',
    context: { text: 'Profile' },
  };
  const parsed = spec({ fields: [{ kind: 'text', label: 'Name', value: 'Darius' }] });
  const compiled = compileCandidates(snapshot('Form', [field, ...snapshot().elements]), parsed);
  assert.equal(compiled.candidates.length, 1);
  assert.equal(compiled.candidates[0].command.name, 'browser_fill_form');
  assert.deepEqual(compiled.candidates[0].command.args.fields[0].expected, {
    name: 'Name',
    value: '',
    contextText: 'Profile',
  });
  assert.equal(
    compileCandidates(
      snapshot('Form', [{ ...field, value: 'Darius' }, ...snapshot().elements]),
      parsed,
    ).candidates[0].command.name,
    'browser_step',
  );
  for (const invalid of [
    { ...field, readOnly: true },
    { ...field, disabled: true },
    { ...field, value: '[REDACTED]' },
  ]) {
    assert.equal(compileCandidates(snapshot('Form', [invalid]), parsed).fieldsSupported, false);
  }
  assert.equal(
    compileCandidates(snapshot('Form', [field, { ...field, ref: 'f:2' }]), parsed).fieldsSupported,
    false,
  );
  assert.throws(() =>
    spec({
      fields: [
        { label: 'Name', kind: 'text', value: 'a' },
        { label: ' name ', kind: 'text', value: 'b' },
      ],
    }),
  );
});

test('verification requires all exact caller predicates and rejects duplicate labels', () => {
  const page = snapshot('Saved request', [{ name: 'Name', value: 'Darius' }]);
  assert(
    verifyPredicates(page, [
      { kind: 'text', text: 'Saved request' },
      { kind: 'field', label: 'Name', value: 'Darius' },
    ]).passed,
  );
  page.elements.push({ name: 'Name', value: 'Darius' });
  assert(!verifyPredicates(page, [{ kind: 'field', label: 'Name', value: 'Darius' }]).passed);
});

test('exact caller value bindings execute without inference and protect fields before later clicks', async () => {
  const field = { ref: 'field:1', name: 'Name', tag: 'input', type: 'text', value: '' };
  let filled = false;
  const h = harness({
    spec: spec({
      fields: [{ kind: 'text', label: 'Name', value: 'Darius' }],
      success: [{ kind: 'field', label: 'Name', value: 'Darius' }],
    }),
    browser: {
      command: async (c) => {
        if (c.name === 'browser_fill_form') {
          filled = true;
          return { outcome: 'filled' };
        }
        return c.name === 'browser_snapshot'
          ? snapshot('Profile', [{ ...field, value: filled ? 'Darius' : '' }])
          : {};
      },
    },
  });
  h.jev.choose = async () => {
    throw new Error('Unnecessary inference');
  };
  assert.equal((await h.run()).outcome, 'verified');
  assert.equal(h.task.jev.requests, 0);
  const compiled = compileCandidates(
    snapshot('Profile', [{ ...field, value: 'Darius' }, ...snapshot().elements]),
    spec({ fields: [{ kind: 'text', label: 'Name', value: 'Darius' }] }),
  );
  assert.deepEqual(compiled.candidates[0].command.args.action.args.preconditions, [
    { ref: 'field:1', expected: { name: 'Name', value: 'Darius' } },
  ]);
});

test('final permitted action receives fresh independent verification and zero LLM turns', async () => {
  const h = harness({ spec: spec({ maxSteps: 1 }) });
  const result = await h.run();
  assert.equal(result.outcome, 'verified');
  assert.equal(result.jev.requests, 1);
  assert.equal(result.ledger.actions[0].state, 'returned');
  assert.equal(h.commands.filter((c) => c.name === 'browser_snapshot').length, 2);
  const already = harness({ browser: { command: async () => snapshot('Saved request') } });
  assert.equal((await already.run()).jev.requests, 0);
});

test('confidence and probability gates stop input independently', async () => {
  for (const decision of [
    { confidence: 0.79, topProbability: 1 },
    { confidence: 1, topProbability: 0.84 },
  ]) {
    const h = harness();
    h.jev.choose = async () => ({ choice: 'a1', ...decision });
    assert.equal((await h.run()).outcome, 'low_confidence');
    assert(!h.commands.some((c) => c.name === 'browser_step'));
  }
});

test('unknown mutation, pending user update and incomplete candidate coverage never continue input', async () => {
  const h = harness();
  const original = h.args.browser.command;
  h.args.browser.command = async (c) => {
    if (c.name === 'browser_step') {
      h.commands.push(c);
      throw new Error('COMMAND_TIMEOUT');
    }
    return original(c);
  };
  assert.equal((await h.run()).outcome, 'unconfirmed');
  assert.equal(h.commands.filter((c) => c.name === 'browser_step').length, 1);
  assert.equal(h.task.ledger.actions[0].state, 'unconfirmed');
  let updated = false;
  const correction = harness({ hasUpdates: () => updated });
  correction.jev.choose = async () => {
    updated = true;
    return { choice: 'a1', confidence: 1, topProbability: 1 };
  };
  assert.equal((await correction.run()).outcome, 'needs_plan');
  assert(!correction.commands.some((c) => c.name === 'browser_step'));
  const truncated = harness({
    browser: {
      command: async (c) =>
        c.name === 'browser_snapshot' ? { ...snapshot(), totalElements: 101 } : {},
    },
  });
  assert.equal((await truncated.run()).outcome, 'needs_plan');
  assert.equal(truncated.task.jev.requests, 0);
});

test('fast tasks share controller ownership and cancel inference without provider construction', async () => {
  const h = harness();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  h.jev.choose = async (_s, _i, _c, signal) => {
    started();
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  };
  const runner = new TaskRunner({
    config: defaults,
    browser: { ...h.args.browser, connected: true },
    jev: h.jev,
    getKey: () => '',
    sessionFactory: () => {
      throw new Error('Must not construct an LLM provider');
    },
  });
  const task = await runner.start({ goal: 'Save', tabId: 1, fast: spec() });
  await ready;
  await assert.rejects(runner.start({ goal: 'Other', tabId: 1 }), /TASK_BUSY/);
  runner.cancel(task.id);
  for (let i = 0; runner.busy && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runner.get(task.id).status, 'cancelled');
  assert(!h.commands.some((c) => c.name === 'browser_step'));
});

test('transient inference failure refreshes refs and retries once without replaying browser input', async () => {
  const h = harness();
  let requests = 0;
  h.jev.choose = async () => {
    h.jev.metrics.requests++;
    if (++requests === 1) throw new DOMException('Inference deadline', 'TimeoutError');
    return { choice: 'a1', confidence: 1, topProbability: 1 };
  };
  const result = await h.run();
  assert.equal(result.outcome, 'verified');
  assert.equal(result.jev.inferenceRecoveries, 1);
  assert.equal(result.jev.usageUnconfirmedRequests, 1);
  assert.equal(h.commands.filter((c) => c.name === 'browser_step').length, 1);
  const failed = harness();
  failed.jev.choose = async () => {
    failed.jev.metrics.requests++;
    throw new DOMException('Timeout', 'TimeoutError');
  };
  assert.equal((await failed.run()).outcome, 'blocked');
  assert.equal(failed.task.jev.requests, 2);
  assert(!failed.commands.some((c) => c.name === 'browser_step'));
});

test('pre-input occlusion returns needs_plan with fresh evidence rather than an unknown mutation', async () => {
  const h = harness();
  const original = h.args.browser.command;
  h.args.browser.command = async (c) =>
    c.name === 'browser_step'
      ? {
          outcome: 'action_blocked',
          action: { mutationOutcome: 'not_dispatched' },
          error: 'ELEMENT_OCCLUDED',
          snapshot: snapshot('Cookie choices'),
        }
      : original(c);
  const task = await h.run();
  assert.equal(task.outcome, 'needs_plan');
  assert.equal(task.lastObservation.text, 'Cookie choices');
  assert.equal(task.ledger.actions[0].state, 'not_dispatched');
});
