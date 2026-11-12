// Independent form fields only; no submit action or mutation replay.
export async function fillForm(args, run, inspect) {
  if (args.foreground)
    await run({ name: 'browser_tab', args: { tabId: args.tabId, operation: 'activate' } });
  const plan = await inspect('form_preflight', { fields: args.fields });
  const result = { outcome: 'filled', fields: [] };
  for (let index = 0; index < args.fields.length; index++) {
    const field = { ...args.fields[index], ...plan.targets[index], selector: undefined };
    let dispatched = false;
    try {
      const before = await inspect('form_validate', field);
      const unchanged =
        field.kind === 'check'
          ? before.checked === field.value
          : args.skipUnchanged !== false && before.matches === true;
      if (!unchanged) {
        const common = {
          tabId: args.tabId,
          frameId: args.frameId,
          ref: field.ref,
          expected: field.expected,
        };
        const command =
          field.kind === 'text'
            ? { name: 'browser_type', args: { ...common, text: field.value, replace: true } }
            : field.kind === 'select'
              ? { name: 'browser_select', args: { ...common, value: field.value } }
              : { name: 'browser_click', args: common };
        dispatched = true;
        const action = await run(command);
        if (action.pendingDialog) {
          result.outcome = 'pending_dialog';
          result.pendingDialog = action.pendingDialog;
          result.stoppedAt = index;
          return result;
        }
      }
      if (!(await inspect('form_verify', { ...field, expected: undefined })).matches)
        throw new Error(
          'FORM_VERIFY_FAILED: Field did not retain the requested value. Inspect before retrying.',
        );
      result.fields.push({ index, kind: field.kind, status: unchanged ? 'unchanged' : 'filled' });
    } catch (error) {
      result.outcome = 'partial';
      result.stoppedAt = index;
      result.mutationOutcome =
        !dispatched || error.mutationOutcome === 'not_dispatched'
          ? 'not_dispatched'
          : 'unconfirmed';
      result.error = error.message;
      result.note =
        'Earlier fields may have changed. No fields were retried; inspect state before continuing.';
      break;
    }
  }
  try {
    result.snapshot = await run({
      name: 'browser_snapshot',
      args: {
        ...args.observation,
        tabId: args.tabId,
      },
    });
  } catch (error) {
    result.observationError = error.message;
    result.error ||= error.message;
    if (result.outcome === 'filled') result.outcome = 'observation_error';
  }
  return result;
}
