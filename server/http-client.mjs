import { setTimeout as delay } from 'node:timers/promises';

export async function postJson(
  url,
  body,
  headers,
  { signal, timeoutMs = 90000, totalTimeoutMs, fetchImpl = fetch, retries = 2, onAttempt } = {},
) {
  if (totalTimeoutMs !== undefined) {
    const deadline = AbortSignal.timeout(totalTimeoutMs);
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  }
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    onAttempt?.(attempt);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if ([429, 502, 503, 529].includes(response.status) && attempt < retries) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      await delay(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(10000, retryAfter * 1000)
          : 500 * 2 ** attempt,
        undefined,
        { signal },
      );
      continue;
    }
    // Avoid logging provider error bodies, which may echo prompts or credentials.
    if (!response.ok)
      throw new Error(
        `Provider request failed (HTTP ${response.status}). Check endpoint, model, key and quota.`,
      );
    return response.json();
  }
}
