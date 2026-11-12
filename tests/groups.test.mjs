import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTabs, listGroups, updateGroup } from '../extension/groups.mjs';
import { parseCommand } from '../shared/tools.mjs';

test('group preflight rejects inaccessible members, pinned tabs and cross-window changes before mutation', async () => {
  const originalChrome = globalThis.chrome;
  let mutations = 0;
  const tabs = [
    { id: 1, url: 'https://allowed.example', windowId: 10, groupId: -1 },
    { id: 2, url: 'https://blocked.example', windowId: 10, groupId: 5 },
    { id: 3, url: 'https://allowed.example', windowId: 11, groupId: -1 },
    { id: 4, url: 'https://allowed.example', windowId: 10, groupId: -1, pinned: true },
  ];
  const grants = {
    '*': { mode: 'interact', expiresAt: Number.MAX_SAFE_INTEGER },
    'https://blocked.example': { denied: true, expiresAt: Number.MAX_SAFE_INTEGER },
  };
  globalThis.chrome = {
    tabs: {
      get: async (id) => tabs.find((tab) => tab.id === id),
      query: async ({ groupId }) => tabs.filter((tab) => tab.groupId === groupId),
      group: async () => {
        mutations++;
        return 6;
      },
    },
    tabGroups: {
      get: async () => ({
        id: 5,
        title: 'Private group',
        windowId: 10,
        color: 'blue',
        collapsed: false,
      }),
      query: async () => [{ id: 5 }],
      update: async () => {
        mutations++;
        throw new Error('fixture metadata failure');
      },
    },
  };
  try {
    await assert.rejects(groupTabs({ tabIds: [1], groupId: 5 }, grants), /blocked/);
    await assert.rejects(updateGroup({ groupId: 5, collapsed: true }, grants), /blocked/);
    assert.deepEqual(await listGroups(grants), { groups: [] });
    await assert.rejects(groupTabs({ tabIds: [1, 3] }, grants), /GROUP_WINDOW/);
    await assert.rejects(groupTabs({ tabIds: [4] }, grants), /PINNED_TAB/);
    await assert.rejects(updateGroup({ groupId: 5 }, grants), /Specify/);
    grants['https://blocked.example'] = { mode: 'read', expiresAt: Number.MAX_SAFE_INTEGER };
    await assert.rejects(updateGroup({ groupId: 5, title: 'Changed' }, grants), /READ_ONLY/);
    assert.equal(mutations, 0);
    const result = await groupTabs({ tabIds: [1] }, grants);
    assert.equal(result.groupId, 6);
    assert.match(result.warning, /Tabs were grouped/);
    assert.equal(
      mutations,
      2,
      'Known grouping success is returned despite a later metadata failure',
    );
    for (const name of ['browser_groups', 'browser_group_tabs', 'browser_group_update'])
      assert.throws(() =>
        parseCommand({ name: 'browser_batch', args: { commands: [{ name, args: {} }] } }),
      );
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});
