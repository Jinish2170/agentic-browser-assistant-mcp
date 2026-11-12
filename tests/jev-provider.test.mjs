import test from 'node:test';
import assert from 'node:assert/strict';
import { JevClient } from '../server/jev.mjs';
import { ProviderSession } from '../server/provider.mjs';
import { postJson } from '../server/http-client.mjs';

const jevConfig = {
  enabled: true,
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  confidenceThreshold: 0.8,
};
const response = (confidence = 0.9) => ({
  model: 'jev-1.13.0',
  answers: {
    decision: {
      type: 'choice',
      choice: 'dom',
      confidence,
      probabilities: { dom: 0.95, vision: 0.05 },
    },
  },
});

test('Jev uses the official typed-question wire format and confidence gating', async () => {
  let requestBody;
  const client = new JevClient(jevConfig, 'test-key', async (url, body, headers) => {
    assert.equal(url, jevConfig.endpoint);
    assert.equal(headers.Authorization, 'Bearer test-key');
    requestBody = body;
    return response();
  });
  const result = await client.choose({ goal: 'read page' }, 'Select observation', {
    dom: 'DOM',
    vision: 'Screenshot',
  });
  assert.equal(result.accepted, true);
  assert.equal(requestBody.questions.decision.type, 'choice');
  assert.equal(requestBody.model, 'jev-latest');
  client.request = async () => response(0.4);
  assert.equal((await client.choose({}, '', { dom: '', vision: '' })).accepted, false);
});

test('Jev rejects out-of-set answers and malformed probabilities; disabled mode does not call API', async () => {
  const client = new JevClient(jevConfig, 'key', async () => ({
    answers: { decision: { ...response().answers.decision, choice: 'execute-secret-code' } },
  }));
  await assert.rejects(client.choose({}, '', { dom: '', vision: '' }), /invalid option/);
  client.request = async () => ({
    answers: {
      decision: { ...response().answers.decision, probabilities: { dom: 0.9, vision: 0.9 } },
    },
  });
  await assert.rejects(client.choose({}, '', { dom: '', vision: '' }), /invalid probability/);
  client.apiKey = '';
  assert.equal((await client.choose({}, '', {})).accepted, false);
});

test('Responses adapter preserves reasoning items and correlates tool results', async () => {
  const bodies = [];
  const session = new ProviderSession(
    { kind: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'configured-model' },
    'key',
    'system',
    'goal',
    async (_url, body) => {
      bodies.push(structuredClone(body));
      return {
        output: [
          { type: 'reasoning', id: 'r1', summary: [] },
          { type: 'function_call', call_id: 'c1', name: 'browser_tabs', arguments: '{}' },
        ],
        usage: { input_tokens: 10, output_tokens: 3 },
      };
    },
  );
  const turn = await session.next();
  session.results([{ call: turn.calls[0], result: { tabs: [] } }]);
  await session.next();
  assert.equal(bodies[1].input[1].type, 'reasoning');
  assert.equal(bodies[1].input[3].call_id, 'c1');
  assert.equal(bodies[0].parallel_tool_calls, false);
  assert.equal(bodies[0].store, false);
  assert.equal(session.usage.inputTokens, 20);
});

test('Anthropic tool results immediately follow assistant tool_use, including image results', async () => {
  const session = new ProviderSession(
    { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'configured-model' },
    'key',
    'system',
    'goal',
    async (_url, _body, headers) => {
      assert.equal(headers['anthropic-version'], '2023-06-01');
      return {
        content: [{ type: 'tool_use', id: 'c1', name: 'browser_screenshot', input: { tabId: 1 } }],
        stop_reason: 'tool_use',
      };
    },
  );
  const turn = await session.next();
  session.results([
    { call: turn.calls[0], result: { image: { mimeType: 'image/png', data: 'abc' } } },
  ]);
  assert.equal(session.history.at(-2).role, 'assistant');
  assert.equal(session.history.at(-1).content[0].tool_use_id, 'c1');
  assert.equal(session.history.at(-1).content[0].content[1].type, 'image');
});

test('Chat adapter correlates results; truncated calls never execute', async () => {
  const session = new ProviderSession(
    { kind: 'chat', baseUrl: 'https://gateway.example/v1', model: 'configured-model' },
    'key',
    'system',
    'goal',
    async () => ({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'browser_tabs', arguments: '{}' } },
            ],
          },
        },
      ],
    }),
  );
  const turn = await session.next();
  session.results([{ call: turn.calls[0], result: { tabs: [] } }]);
  assert.equal(session.history.at(-1).tool_call_id, 'c1');
  session.request = async () => ({ choices: [{ finish_reason: 'length', message: {} }] });
  await assert.rejects(session.next(), /truncated/);
});

test('HTTP provider retries only retryable statuses and rejects redirects', async () => {
  let attempts = 0;
  const result = await postJson(
    'https://provider.example',
    {},
    {},
    {
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, 'error');
        attempts++;
        return attempts === 1 ? new Response('', { status: 429 }) : Response.json({ ok: true });
      },
    },
  );
  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
  await assert.rejects(
    postJson(
      'https://provider.example',
      {},
      {},
      { fetchImpl: async () => new Response('private prompt body', { status: 401 }) },
    ),
    /HTTP 401/,
  );
});
