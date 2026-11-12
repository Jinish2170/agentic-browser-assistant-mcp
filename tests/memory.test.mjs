import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { SessionStore } from '../server/session-store.mjs';
import { SkillLibrary } from '../server/skills.mjs';
import { ProviderSession } from '../server/provider.mjs';
import { splitImages } from '../server/tool-results.mjs';

test('conversation checkpoints survive restart, concurrent updates retain facts, and interrupted actions do not resume', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-memory-'));
  const store = new SessionStore(directory);
  await store.load();
  const conversation = await store.create('Research project');
  await Promise.all(
    Array.from({ length: 8 }, (_, index) => store.saveFact(`Preference ${index}`, conversation.id)),
  );
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.saveFact(`Reusable ${index}`)));
  await store.update(conversation.id, (session) => {
    session.summary = 'Compared two sources; the submission result is unknown.';
    session.modelState = {
      identity: 'fixture',
      history: [{ role: 'user', content: 'Original goal' }],
    };
  });
  const id = randomUUID();
  await store.update(conversation.id, (session) => session.taskIds.push(id));
  await store.saveTask({
    id,
    status: 'running',
    events: [],
    goal: 'Save draft',
    ledger: { inFlight: { name: 'browser_click', state: 'dispatched' } },
  });
  const restarted = new SessionStore(directory);
  await restarted.load();
  assert.equal(restarted.get(conversation.id).facts.length, 8);
  assert.equal(restarted.facts().reusable.length, 8);
  assert.equal(restarted.task(id).status, 'interrupted');
  assert.equal(restarted.task(id).ledger.inFlight.state, 'unconfirmed');
  assert.match(restarted.task(id).error, /unknown outcome/);
  assert.equal(restarted.get(conversation.id).modelState, undefined);
  assert.equal(restarted.get(conversation.id, true).modelState.history[0].content, 'Original goal');
  assert.equal(
    (await stat(path.join(directory, 'sessions', `${conversation.id}.json`))).mode & 0o777,
    0o600,
  );
  await assert.rejects(restarted.update('../escape', () => {}));
  const fact = restarted.facts().reusable[0];
  await restarted.forgetFact(fact.id);
  await restarted.remove(conversation.id);
  assert.equal(restarted.list().length, 0);
  assert.equal(restarted.facts().reusable.length, 7);
  await assert.rejects(readFile(path.join(directory, 'tasks', `${id}.json`)), { code: 'ENOENT' });
});

test('skill reads are restricted to the local library and reject symlink escapes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-skills-'));
  await mkdir(path.join(directory, 'safe'));
  await writeFile(path.join(directory, 'safe/SKILL.md'), '# Safe workflow\n\nInspect then verify.');
  const library = new SkillLibrary(directory);
  assert.equal((await library.list())[0].id, 'safe');
  assert.match((await library.read('safe')).content, /verify/);
  await assert.rejects(library.read('../private'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'jev-external-'));
  await writeFile(path.join(external, 'SKILL.md'), 'private');
  await symlink(external, path.join(directory, 'escape'));
  await assert.rejects(library.read('escape'), /outside/);
});

const config = { kind: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'fixture' };

test('provider checkpoint restores paired tool history without persisting screenshot bytes', async () => {
  const session = new ProviderSession(config, 'key', 'system', 'goal', async () => ({
    output: [
      { type: 'reasoning', encrypted_content: 'opaque' },
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'browser_screenshot',
        arguments: '{"tabId":1}',
      },
    ],
  }));
  const turn = await session.next();
  session.results([
    {
      call: turn.calls[0],
      result: { image: { mimeType: 'image/png', data: 'SECRET_IMAGE_BYTES' } },
    },
  ]);
  const checkpoint = session.checkpoint();
  assert.equal(JSON.stringify(checkpoint).includes('SECRET_IMAGE_BYTES'), false);
  const restored = new ProviderSession(
    config,
    'key',
    'system',
    'follow-up',
    async () => ({}),
    checkpoint,
  );
  assert(
    restored.history.some((item) => item.type === 'function_call_output' && item.call_id === 'c1'),
  );
  assert(restored.history.some((item) => item.encrypted_content === 'opaque'));
  assert.equal(restored.history.at(-1).content, 'follow-up');
  const changedModel = new ProviderSession(
    { ...config, model: 'other' },
    'key',
    'system',
    'follow-up',
    async () => ({}),
    checkpoint,
  );
  assert.equal(changedModel.history.length, 1);
});

test('universal context compaction retains a bounded summary and reports usage', async () => {
  for (const kind of ['responses', 'anthropic', 'chat']) {
    let requestBody;
    const session = new ProviderSession(
      { ...config, kind },
      'key',
      'system',
      'goal',
      async (_url, body) => {
        requestBody = body;
        const text =
          'Goal: compare sources. Tab 1 remains open. Submission outcome unknown; inspect before acting.';
        return kind === 'responses'
          ? {
              output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
              usage: { input_tokens: 25, output_tokens: 15 },
            }
          : kind === 'anthropic'
            ? { content: [{ type: 'text', text }], usage: { input_tokens: 25, output_tokens: 15 } }
            : {
                choices: [{ message: { content: text } }],
                usage: { prompt_tokens: 25, completion_tokens: 15 },
              };
      },
    );
    session.observe('large page'.repeat(500));
    const before = session.contextSize();
    await session.compact();
    assert.match(session.summary, /outcome unknown/);
    assert.equal(session.compactions, 1);
    assert.equal(session.usage.inputTokens, 25);
    assert.equal(requestBody.tools, undefined);
    assert(session.contextSize() < before - 3000);
    assert(JSON.stringify(session.history).length < 1000);
  }
});

test('native Responses compaction preserves the entire canonical output', async () => {
  const canonical = [
    { role: 'user', content: 'Original instruction' },
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,canonical-image' }],
    },
    { type: 'compaction', encrypted_content: 'opaque-checkpoint' },
  ];
  const session = new ProviderSession(
    { ...config, nativeCompaction: true },
    'key',
    'system',
    'goal',
    async (url, body) => {
      assert(url.endsWith('/responses/compact'));
      assert.equal(body.model, 'fixture');
      return { output: structuredClone(canonical) };
    },
  );
  await session.compact();
  assert.deepEqual(session.history, canonical);
  assert.deepEqual(session.checkpoint().history, canonical);
  session.observe('Fresh screenshot', { mimeType: 'image/png', data: 'new-image' });
  assert.deepEqual(session.checkpoint().history.slice(0, canonical.length), canonical);
});

test('failed compaction leaves the original context available and stops safely', async () => {
  const session = new ProviderSession(config, 'key', 'system', 'goal', async () => ({
    status: 'incomplete',
    output: [],
  }));
  const original = structuredClone(session.history);
  await assert.rejects(session.compact(), /COMPACTION_FAILED/);
  assert.deepEqual(session.history, original);
});

test('batch screenshots remain separate image inputs and never become base64 text', async () => {
  const result = {
    results: [
      { tabId: 1, result: { image: { mimeType: 'image/png', data: 'IMAGE_ONE' } } },
      { tabId: 2, result: { image: { mimeType: 'image/jpeg', data: 'IMAGE_TWO' } } },
    ],
  };
  assert.equal(splitImages(result).images.length, 2);
  assert.equal(JSON.stringify(splitImages(result).value).includes('IMAGE_ONE'), false);
  for (const kind of ['responses', 'anthropic', 'chat']) {
    const session = new ProviderSession(
      { ...config, kind },
      'key',
      'system',
      'goal',
      async () => ({}),
    );
    session.results([{ call: { id: 'batch', name: 'browser_batch' }, result }]);
    const images = JSON.stringify(session.history);
    assert(images.includes('IMAGE_ONE') && images.includes('IMAGE_TWO'));
    assert.equal(JSON.stringify(session.checkpoint()).includes('IMAGE_ONE'), false);
  }
});

test('workspace view bounds the transcript, omits model state and tracks monotonic revisions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-view-'));
  const store = new SessionStore(directory);
  await store.load();
  const conversation = await store.create('Long conversation');
  await store.update(conversation.id, (session) => {
    session.modelState = { history: 'private model data' };
    session.messages = Array.from({ length: 100 }, (_, i) => ({
      role: 'user',
      text: `Message ${i}`,
      at: new Date().toISOString(),
    }));
  });
  const first = store.view(conversation.id);
  assert.equal(first.messageCount, 100);
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages[0].text, 'Message 50');
  assert.equal(first.modelState, undefined);
  const unchanged = store.view(conversation.id, first.revision);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.messages, undefined);
  await store.update(conversation.id, (session) => (session.summary = 'Updated context'));
  assert.equal(store.view(conversation.id, first.revision).unchanged, false);
  assert.equal(store.view(conversation.id).revision, first.revision + 1);
  assert.equal(store.get(conversation.id).messages.length, 100);
});
