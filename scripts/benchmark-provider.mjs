// Local CPU benchmark only: fixture key and request function; zero provider calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { definitions, ProviderSession } from '../server/provider.mjs';
import { root, defaults } from '../server/config.mjs';

const label = process.argv[2] || 'current';
assert(/^[a-z0-9-]+$/.test(label));
const session = new ProviderSession(
  { ...defaults.provider, model: 'fixture' },
  'fixture-key',
  'Fixture system',
  'Read a page',
  async () => {
    throw new Error('No network call permitted in this benchmark');
  },
);
for (let i = 0; i < 200; i++) session.appendUser(`Fixture message ${i}: ${'context '.repeat(200)}`);
const measure = (action) => {
  for (let i = 0; i < 10; i++) action();
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const began = performance.now();
    for (let iteration = 0; iteration < 5; iteration++) action();
    samples.push((performance.now() - began) / 5);
  }
  samples.sort((a, b) => a - b);
  return { samples: 100, medianMs: +samples[50].toFixed(4), p95Ms: +samples[94].toFixed(4) };
};
const result = {
  label,
  measuredAt: new Date().toISOString(),
  node: process.version,
  modelCalls: 0,
  historyMessages: session.history.length,
  textCharacters: session.contextSize(),
  metrics: {
    coreDefinitions: measure(() => definitions(false, ['core'])),
    fullDefinitions: measure(() => definitions(false)),
    contextSize: measure(() => session.contextSize()),
  },
};
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(
  path.join(root, 'artifacts', `provider-benchmark-${label}.json`),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
