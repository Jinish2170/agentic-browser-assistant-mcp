import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskLedger } from '../server/task-ledger.mjs';

test('ledger retains action boundaries and user updates without secret arguments or URL queries', () => {
  const task = { goal: 'Complete this form' };
  const ledger = new TaskLedger(task);
  ledger.update('Use the normal plan');
  ledger.observed(1, { url: 'https://example.com/setup?token=private#code', title: 'Setup' });
  const action = ledger.dispatch({
    name: 'browser_type',
    args: { tabId: 1, text: 'secret-password' },
  });
  assert.equal(ledger.pinned().inFlight.state, 'dispatched');
  assert(!JSON.stringify(task.ledger).includes('secret-password'));
  assert(!JSON.stringify(task.ledger).includes('private'));
  ledger.settle(action, undefined, new Error('COMMAND_TIMEOUT: secret-password'));
  assert.equal(task.ledger.inFlight, null);
  assert.equal(task.ledger.actions[0].state, 'unconfirmed');
  assert.equal(task.ledger.actions[0].errorCode, 'COMMAND_TIMEOUT');
  assert(!JSON.stringify(task.ledger).includes('secret-password'));
});
