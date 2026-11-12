// Read-only polling remains in the worker, avoiding background page timer clamps.
export async function waitForState(args, { check, inspect, navigation, sleep, now = Date.now }) {
  const started = now();
  const deadline = started + args.timeoutMs;
  let polls = 0;
  do {
    const tab = await check();
    const current = navigation();
    if (current?.error) throw new Error(`NAVIGATION_FAILED: ${current.error}`);
    const pending =
      tab.pendingUrl ||
      (current && !current.committed) ||
      (args.expectedUrl && tab.url !== args.expectedUrl) ||
      (!args.selector && !args.text && args.state === 'complete' && tab.status !== 'complete');
    if (!pending) {
      try {
        polls++;
        const result = await inspect();
        if (result.ready) return { ...result, polls, elapsedMs: now() - started };
      } catch (error) {
        // A navigation can replace the document between the state check and injection.
        if (!/removed|frame|Cannot access|No document/i.test(error.message)) throw error;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(remaining, now() - started < 500 ? 50 : 200));
  } while (now() <= deadline);
  throw new Error('WAIT_TIMEOUT: Condition was not met');
}
