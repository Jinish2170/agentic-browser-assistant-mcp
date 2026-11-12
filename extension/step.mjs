// One mutation, followed only by reads. The outer tab queue stays held throughout.
export async function executeStep(args, run) {
  const began = performance.now();
  const result = { outcome: 'action_error', action: { name: args.action.name }, timings: {} };
  const timed = async (stage, command) => {
    const started = performance.now();
    try {
      return await run(command);
    } finally {
      result.timings[stage] = +(performance.now() - started).toFixed(2);
    }
  };
  const finish = () => ({ ...result, elapsedMs: +(performance.now() - began).toFixed(2) });
  if (args.foreground) {
    try {
      result.activation = await timed('activationMs', {
        name: 'browser_tab',
        args: { tabId: args.tabId, operation: 'activate' },
      });
    } catch (error) {
      result.outcome = 'activation_error';
      result.error = error.message;
      result.action.mutationOutcome = 'not_dispatched';
      return finish();
    }
  }
  try {
    result.action.result = await timed('actionMs', {
      name: args.action.name,
      args: { ...args.action.args, tabId: args.tabId },
    });
  } catch (error) {
    // A command may have failed after input was dispatched. Never infer rollback.
    result.action.error = error.message;
    result.action.mutationOutcome =
      error.mutationOutcome === 'not_dispatched' ? 'not_dispatched' : 'unconfirmed';
    result.error = error.message;
    if (result.action.mutationOutcome === 'not_dispatched') {
      result.outcome = 'action_blocked';
      try {
        result.snapshot = await timed('observationMs', {
          name: 'browser_snapshot',
          args: { ...args.observation, tabId: args.tabId },
        });
      } catch (readError) {
        result.observationError = readError.message;
      }
    }
    return finish();
  }
  if (result.action.result?.pendingDialog) {
    result.outcome = 'pending_dialog';
    result.pendingDialog = result.action.result.pendingDialog;
    return finish();
  }
  if (args.wait) {
    try {
      result.wait = await timed('waitMs', {
        name: 'browser_wait',
        args: { ...args.wait, tabId: args.tabId },
      });
    } catch (error) {
      result.wait = { ready: false, error: error.message };
      result.error = error.message;
      // Only an unmet predicate permits a subsequent read; access/connection errors stop.
      if (!error.message.startsWith('WAIT_TIMEOUT:')) {
        result.outcome = 'wait_error';
        return finish();
      }
    }
  }
  try {
    result.snapshot = await timed('observationMs', {
      name: 'browser_snapshot',
      args: { ...args.observation, tabId: args.tabId },
    });
    result.outcome = result.wait?.ready === false ? 'condition_not_met' : 'observed';
  } catch (error) {
    result.outcome = 'observation_error';
    result.observationError = error.message;
    result.error ||= error.message;
  }
  return finish();
}
