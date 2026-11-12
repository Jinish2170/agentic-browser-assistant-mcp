import test from 'node:test';
import assert from 'node:assert/strict';
import { fillForm } from '../extension/form.mjs';

const args = {
  tabId: 7,
  frameId: 3,
  fields: [
    { kind: 'text', selector: '#name', value: 'A name' },
    { kind: 'select', selector: '#plan', value: 'normal' },
    { kind: 'check', selector: '#agree', value: true },
  ],
  observation: {},
};

test('form preflight failure dispatches no inputs', async () => {
  let dispatched = 0;
  await assert.rejects(
    fillForm(
      args,
      async () => {
        dispatched++;
      },
      async () => {
        throw new Error('FORM_DUPLICATE');
      },
    ),
    /FORM_DUPLICATE/,
  );
  assert.equal(dispatched, 0);
});

test('form stops at an unconfirmed field, preserves earlier results and never retries', async () => {
  const calls = [];
  const result = await fillForm(
    args,
    async (command) => {
      calls.push(command);
      if (command.name === 'browser_select') throw new Error('Frame disappeared');
      return {};
    },
    async (operation) =>
      operation === 'form_preflight'
        ? { targets: args.fields.map((_, i) => ({ ref: `field:${i}` })) }
        : operation === 'form_verify'
          ? { matches: true }
          : {},
  );
  assert.equal(result.outcome, 'partial');
  assert.equal(result.mutationOutcome, 'unconfirmed');
  assert.equal(result.stoppedAt, 1);
  assert.deepEqual(result.fields, [{ index: 0, kind: 'text', status: 'filled' }]);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['browser_type', 'browser_select', 'browser_snapshot'],
  );
  assert.equal(calls[0].args.frameId, 3);
  assert(!JSON.stringify(result).includes('A name'));
});

test('already checked control is verified without toggling it', async () => {
  const calls = [];
  const result = await fillForm(
    { ...args, fields: [args.fields[2]] },
    async (command) => {
      calls.push(command.name);
      return {};
    },
    async (operation) =>
      operation === 'form_preflight'
        ? { targets: [{ ref: 'check' }] }
        : operation === 'form_validate'
          ? { checked: true }
          : { matches: true },
  );
  assert.equal(result.outcome, 'filled');
  assert.equal(result.fields[0].status, 'unchanged');
  assert.deepEqual(calls, ['browser_snapshot']);
});

test('matching text/select fields avoid input unless explicitly forced', async () => {
  for (const skipUnchanged of [true, false]) {
    const calls = [];
    const result = await fillForm(
      { ...args, skipUnchanged, fields: args.fields.slice(0, 2) },
      async (command) => {
        calls.push(command.name);
        return {};
      },
      async (operation) =>
        operation === 'form_preflight'
          ? { targets: [{ ref: 'a' }, { ref: 'b' }] }
          : { matches: true },
    );
    assert.equal(result.outcome, 'filled');
    assert.deepEqual(
      calls,
      skipUnchanged ? ['browser_snapshot'] : ['browser_type', 'browser_select', 'browser_snapshot'],
    );
    assert(
      result.fields.every((field) => field.status === (skipUnchanged ? 'unchanged' : 'filled')),
    );
  }
});
