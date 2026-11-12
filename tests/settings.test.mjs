import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults } from '../server/config.mjs';
import { Settings } from '../server/settings.mjs';

test('settings persist keys privately and return configuration without secrets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-settings-'));
  const config = { ...structuredClone(defaults), token: 'test-token'.repeat(8) };
  const settings = new Settings(
    config,
    path.join(dir, 'secrets.json'),
    path.join(dir, 'config.json'),
  );
  await settings.load();
  const { apiKeyEnv: providerEnv, ...provider } = config.provider;
  const { apiKeyEnv: jevEnv, ...jev } = config.jev;
  const view = await settings.save({
    provider: { ...provider, apiKey: 'private-llm-key', model: 'model' },
    jev: { ...jev, apiKey: 'private-jev-key' },
    agent: { ...config.agent, maxSteps: 500, maxDurationMs: 7200000 },
  });
  assert.equal(JSON.stringify(view).includes('private-'), false);
  assert.equal(view.provider.apiKeyConfigured, true);
  assert.equal(view.agent.maxSteps, 500);
  assert.equal(view.agent.maxDurationMs, 7200000);
  assert.equal(settings.key('UNDEFINED_TEST_ENV', 'jev'), 'private-jev-key');
  assert.equal((await readFile(path.join(dir, 'config.json'), 'utf8')).includes('private-'), false);
  if (process.platform !== 'win32')
    assert.equal((await stat(path.join(dir, 'secrets.json'))).mode & 0o777, 0o600);
});

test('stored credentials remain bound to their provider destination through endpoint changes and restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-key-binding-'));
  const config = { ...structuredClone(defaults), token: 'fixture-token'.repeat(8) };
  const settings = new Settings(
    config,
    path.join(dir, 'secrets.json'),
    path.join(dir, 'config.json'),
  );
  await settings.load();
  const { apiKeyEnv: pe, ...provider } = config.provider;
  const { apiKeyEnv: je, ...jev } = config.jev;
  await settings.save({ provider: { ...provider, apiKey: 'original-provider-key' }, jev });
  assert.equal(settings.key(pe, 'llm'), 'original-provider-key');
  const changed = await settings.save({
    provider: { ...provider, baseUrl: 'https://another.example/v1' },
    jev,
  });
  assert.equal(changed.provider.apiKeyConfigured, false);
  assert.equal(settings.key(pe, 'llm'), '');
  const resumed = new Settings(
    config,
    path.join(dir, 'secrets.json'),
    path.join(dir, 'config.json'),
  );
  await resumed.load();
  assert.equal(resumed.key(pe, 'llm'), '');
  await resumed.save({
    provider: { ...provider, baseUrl: 'https://another.example/v1', apiKey: 'new-destination-key' },
    jev,
  });
  assert.equal(resumed.key(pe, 'llm'), 'new-destination-key');
  await resumed.save({ provider, jev });
  assert.equal(resumed.key(pe, 'llm'), '');
});
