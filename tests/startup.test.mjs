import test from 'node:test';
import assert from 'node:assert/strict';
import { startupTarget } from '../server/startup.mjs';

test('startup routes explicit user URLs and NVIDIA dashboard before inference', () => {
  assert.deepEqual(startupTarget('Please open https://example.com/a?x=1'), {
    url: 'https://example.com/a?x=1',
    label: 'example.com',
    onlyOpen: true,
  });
  assert.equal(
    startupTarget('now open the nvidia nim dashboard login with email verification').url,
    'https://build.nvidia.com/settings/api-keys',
  );
  assert.equal(startupTarget('open https://example.com and fill my form').onlyOpen, false);
});

test('startup does not invent URLs from page data, negations, ambiguous targets or credentials', () => {
  for (const goal of [
    "don't open https://example.com",
    'explain how to open https://example.com',
    'open the link on this page',
    'open nvidia dashboard-example',
    'open https://user:secret@example.com',
    'open chrome://settings',
    'open https://',
  ])
    assert.equal(startupTarget(goal), null, goal);
});
