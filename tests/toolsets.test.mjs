import test from 'node:test';
import assert from 'node:assert/strict';
import { toolsets } from '../shared/toolsets.mjs';
import { tools } from '../shared/tools.mjs';
import { definitions, ProviderSession } from '../server/provider.mjs';

test('progressive registry covers every browser tool and loading never grants advanced access', () => {
  assert.deepEqual(new Set(Object.values(toolsets).flat()), new Set(Object.keys(tools)));
  const core = definitions(false, ['core']);
  assert(core.some((tool) => tool.name === 'browser_toolset'));
  assert(!core.some((tool) => tool.name === 'browser_diagnostics'));
  assert(!definitions(false, ['all']).some((tool) => tool.name === 'browser_evaluate'));
  assert(definitions(true, ['all']).some((tool) => tool.name === 'browser_evaluate'));
  assert(JSON.stringify(core).length < JSON.stringify(definitions(false)).length);
});

test('selected tool definitions expand on the next request and survive a checkpoint', async () => {
  const bodies = [];
  const config = { kind: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'fixture' };
  const request = async (_url, body) => {
    bodies.push(body);
    return { output: [] };
  };
  const session = new ProviderSession(config, 'key', 'system', 'Review a page', request);
  await session.next();
  assert(!bodies[0].tools.some((tool) => tool.name === 'browser_diagnostics'));
  const loaded = session.enableTools('inspect');
  assert.equal(loaded.permissionsChanged, false);
  await session.next();
  assert(bodies[1].tools.some((tool) => tool.name === 'browser_diagnostics'));
  assert(!bodies[1].tools.some((tool) => tool.name === 'browser_response'));
  const resumed = new ProviderSession(
    config,
    'key',
    'system',
    'Continue',
    request,
    session.checkpoint(),
  );
  await resumed.next();
  assert(bodies[2].tools.some((tool) => tool.name === 'browser_diagnostics'));
  assert(session.contextSize() > JSON.stringify(session.history).length);
  assert.throws(() => session.enableTools('arbitrary-tool-set'));
});

test('cached schemas are immutable and cannot contaminate another capability profile', () => {
  const core = definitions(false, ['core']);
  assert.equal(core, definitions(false, ['core', 'core']));
  assert.throws(() => core.push({ name: 'browser_evaluate' }));
  const click = core.find((tool) => tool.name === 'browser_click');
  assert.throws(() => {
    click.parameters.properties.tabId.type = 'string';
  });
  assert(!definitions(false, ['all']).some((tool) => tool.name === 'browser_evaluate'));
  assert(definitions(true, ['all']).some((tool) => tool.name === 'browser_evaluate'));
});
