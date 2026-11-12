import test from 'node:test';
import assert from 'node:assert/strict';
import { questionsSchema, validateAnswers } from '../server/jev-contract.mjs';
import { JevClient } from '../server/jev.mjs';
import { postJson } from '../server/http-client.mjs';

const questions = questionsSchema.parse({
  next: { type: 'choice', instructions: 'Next', criteria: { save: 'Save', none: null } },
  done: { type: 'noul', instructions: 'Done' },
  ready: { type: 'score', instructions: 'Ready', criteria: ['No', 'Yes'] },
});
const response = () => ({
  answers: {
    next: {
      type: 'choice',
      choice: 'save',
      confidence: 0.9,
      probabilities: { save: 0.97, none: 0.03 },
    },
    done: { type: 'noul', noul: 0.99 },
    ready: {
      type: 'score',
      score: 1,
      confidence: 0.9,
      probabilities: { 0: 0, 1: 1 },
      legend: { 0: 'No', 1: 'Yes' },
    },
  },
});

test('mixed Jev primitives preserve their distinct semantics', () => {
  const answers = validateAnswers(response(), questions);
  assert.equal(answers.next.topProbability, 0.97);
  assert.equal(answers.next.margin, 0.94);
  assert.equal(answers.done.noul, 0.99);
  assert(!('confidence' in answers.done));
  assert.equal(answers.ready.score, 1);
});

test('question coverage, probability keys, argmax and score levels fail closed', () => {
  const mutations = [
    (r) => {
      delete r.answers.done;
    },
    (r) => {
      r.answers.extra = {};
    },
    (r) => {
      r.answers.next.probabilities = { save: 0.97, injected: 0.03 };
    },
    (r) => {
      r.answers.next.choice = 'none';
    },
    (r) => {
      r.answers.next.probabilities.save = NaN;
    },
    (r) => {
      r.answers.ready.score = 2;
    },
    (r) => {
      delete r.answers.ready.legend[0];
    },
  ];
  for (const mutate of mutations) {
    const r = response();
    mutate(r);
    assert.throws(() => validateAnswers(r, questions));
  }
  assert.throws(() =>
    questionsSchema.parse({ next: { type: 'choice', instructions: '', criteria: { only: '' } } }),
  );
});

test('paid malformed replies still count reported usage and total deadline bounds retry backoff', async () => {
  const client = new JevClient(
    {
      enabled: true,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'fixture',
      confidenceThreshold: 0.8,
    },
    'fixture',
    async () => ({ answers: {}, usage: { input_tokens: 42, output_tokens: 3 } }),
  );
  await assert.rejects(client.evaluate({}, questions));
  assert.equal(client.metrics.inputTokens, 42);
  assert.equal(client.metrics.failures, 1);
  await assert.rejects(
    client.evaluate({}, questions, undefined, { totalTimeoutMs: -1 }),
    /positive integer/,
  );
  let attempts = 0;
  const began = performance.now();
  await assert.rejects(
    postJson(
      'https://fixture.example',
      {},
      {},
      {
        totalTimeoutMs: 50,
        fetchImpl: async () => {
          attempts++;
          return new Response('', { status: 429, headers: { 'retry-after': '10' } });
        },
      },
    ),
    /abort|timeout/i,
  );
  assert.equal(attempts, 1);
  assert(performance.now() - began < 1000);
});
