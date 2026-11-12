// Durable execution facts. This is not model-written memory or a permission grant.
export class TaskLedger {
  constructor(task) {
    this.value = task.ledger = {
      goal: task.goal,
      updates: [],
      observations: [],
      actions: [],
      inFlight: null,
    };
  }

  update(text) {
    this.value.updates.push({ text, at: new Date().toISOString() });
    this.value.updates = this.value.updates.slice(-20);
  }

  observed(tabId, snapshot) {
    if (!snapshot?.url) return;
    let url;
    try {
      const parsed = new URL(snapshot.url);
      parsed.search = '';
      parsed.hash = '';
      parsed.username = '';
      parsed.password = '';
      url = parsed.href;
    } catch {
      url = '[unavailable]';
    }
    this.value.observations = this.value.observations.filter((entry) => entry.tabId !== tabId);
    this.value.observations.push({
      tabId,
      url,
      title: String(snapshot.title || '').slice(0, 240),
      at: new Date().toISOString(),
      trust: 'UNTRUSTED_WEBPAGE_DATA',
    });
    this.value.observations = this.value.observations.slice(-12);
  }

  dispatch(command) {
    const action = {
      name: command.name,
      tabId: command.args.tabId,
      ...(command.name === 'browser_batch'
        ? { tabs: command.args.commands.map((entry) => entry.args.tabId) }
        : {}),
      state: 'dispatched',
      at: new Date().toISOString(),
    };
    // Deliberately omit arguments: a form action may contain passwords or payment details.
    this.value.inFlight = action;
    this.value.actions.push(action);
    this.value.actions = this.value.actions.slice(-40);
    return action;
  }

  settle(action, result, error) {
    if (error) {
      action.state = error.mutationOutcome === 'not_dispatched' ? 'not_dispatched' : 'unconfirmed';
      // Do not persist raw error text; gateways/sites can reflect input values.
      action.errorCode =
        error.message
          .split(':', 1)[0]
          .replace(/[^A-Z_]/g, '')
          .slice(0, 80) || 'ACTION_ERROR';
    } else {
      action.state =
        result?.action?.mutationOutcome === 'not_dispatched'
          ? 'not_dispatched'
          : result?.action?.mutationOutcome === 'unconfirmed' ||
              result?.mutationOutcome === 'unconfirmed'
            ? 'unconfirmed'
            : 'returned';
      action.outcome = result?.outcome || (result?.pendingDialog ? 'pending_dialog' : 'returned');
    }
    action.finishedAt = new Date().toISOString();
    this.value.inFlight = null;
  }

  pinned() {
    return {
      updates: this.value.updates
        .slice(-5)
        .map((entry) => ({ ...entry, text: entry.text.slice(0, 1000) })),
      observations: this.value.observations,
      actions: this.value.actions.slice(-15),
      inFlight: this.value.inFlight,
    };
  }
}
