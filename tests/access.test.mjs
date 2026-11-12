import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGrant } from '../shared/tools.mjs';

test('default all-site access and explicit revocation survive worker and browser restarts', async () => {
  const originalChrome = globalThis.chrome;
  let permitted = true;
  const local = {};
  const session = {};
  const storage = (values) => ({
    async get(query) {
      if (typeof query === 'string') return { [query]: structuredClone(values[query]) };
      return { ...structuredClone(query), ...structuredClone(values) };
    },
    async set(update) {
      Object.assign(values, structuredClone(update));
    },
  });
  globalThis.chrome = {
    storage: { local: storage(local), session: storage(session) },
    permissions: { contains: async () => permitted },
  };
  let sequence = 0;
  const restart = () => import(`../extension/access.mjs?test=${sequence++}`);
  try {
    let access = await restart();
    let grants = await access.getGrants();
    assert.equal(grants['*'].persistent, true);
    assertGrant(grants, 'https://new-site.example', true);
    assert.throws(() => assertGrant(grants, 'https://new-site.example', true, true), /ADVANCED/);
    await access.grantWebsite('https://read.example', 'read', false);
    await access.revokeWebsite('https://blocked.example');
    access = await restart();
    grants = await access.getGrants();
    assert.throws(() => assertGrant(grants, 'https://read.example', true), /READ_ONLY/);
    assert.throws(() => assertGrant(grants, 'https://blocked.example'), /blocked/);

    // A browser restart clears session storage, unlike worker suspension.
    for (const key of Object.keys(session)) delete session[key];
    access = await restart();
    grants = await access.getGrants();
    assertGrant(grants, 'https://another-site.example', true);
    assert.throws(() => assertGrant(grants, 'https://blocked.example'), /blocked/);
    await access.grantWebsite('https://blocked.example', 'interact', false);
    assertGrant(await access.getGrants(), 'https://blocked.example', true);
    assert.deepEqual(local.websiteAccess.blockedOrigins, []);

    await access.revokeWebsite('*');
    access = await restart();
    grants = await access.getGrants();
    assert.throws(() => assertGrant(grants, 'https://another-site.example'), /ACCESS_REQUIRED/);
    assertGrant(grants, 'https://blocked.example', true);
    await access.grantAllWebsites(true);
    access = await restart();
    assertGrant(await access.getGrants(), 'https://another-site.example', true, true);

    permitted = false;
    access = await restart();
    assert.equal((await access.getGrants())['*'], undefined);
    await assert.rejects(access.grantAllWebsites(false), /Chrome/);
    permitted = true;
    access = await restart();
    assertGrant(await access.getGrants(), 'https://another-site.example', true, true);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});
