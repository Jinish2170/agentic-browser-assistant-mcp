import { originOf } from '../shared/tools.mjs';

const forever = Number.MAX_SAFE_INTEGER;
const defaultPolicy = () => ({ enabled: true, advanced: false, blockedOrigins: [] });
let initialized;
let writes = Promise.resolve();

// Persistent preferences are separate from temporary site overrides. Only the
// trusted side panel can change them; browser commands cannot grant access.
async function restore() {
  const { websiteAccess = defaultPolicy() } = await chrome.storage.local.get('websiteAccess');
  const { grants = {} } = await chrome.storage.session.get('grants');
  const permitted = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  if (websiteAccess.enabled && permitted) {
    grants['*'] = {
      mode: 'interact',
      advanced: !!websiteAccess.advanced,
      expiresAt: forever,
      persistent: true,
    };
  } else delete grants['*'];
  for (const origin of websiteAccess.blockedOrigins) {
    grants[origin] = { denied: true, expiresAt: forever, persistent: true };
  }
  await chrome.storage.local.set({ websiteAccess });
  await chrome.storage.session.set({ grants });
}

export async function getGrants() {
  initialized ??= restore().catch((error) => {
    initialized = undefined;
    throw error;
  });
  await initialized;
  return (await chrome.storage.session.get({ grants: {} })).grants;
}

function update(change) {
  const write = writes
    .catch(() => {})
    .then(async () => {
      const grants = await getGrants();
      const { websiteAccess = defaultPolicy() } = await chrome.storage.local.get('websiteAccess');
      await change(grants, websiteAccess);
      await chrome.storage.local.set({ websiteAccess });
      await chrome.storage.session.set({ grants });
      return grants;
    });
  writes = write;
  return write;
}

export function grantWebsite(origin, mode, advanced) {
  origin = originOf(origin);
  if (!['read', 'interact'].includes(mode)) throw new Error('Invalid access mode');
  return update(async (grants, policy) => {
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] })))
      throw new Error('Enable this website in Chrome extension site access');
    policy.blockedOrigins = policy.blockedOrigins.filter((entry) => entry !== origin);
    grants[origin] = {
      mode,
      advanced: mode === 'interact' && !!advanced,
      expiresAt: Date.now() + 3600000,
    };
  });
}

export function grantAllWebsites(advanced) {
  return update(async (grants, policy) => {
    if (!(await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })))
      throw new Error('Set Chrome extension Site access to On all sites');
    policy.enabled = true;
    policy.advanced = !!advanced;
    grants['*'] = { mode: 'interact', advanced: !!advanced, expiresAt: forever, persistent: true };
  });
}

export function revokeWebsite(origin) {
  if (origin !== '*') origin = originOf(origin);
  return update((grants, policy) => {
    if (origin === '*') {
      policy.enabled = false;
      delete grants['*'];
    } else if (grants['*']?.expiresAt > Date.now()) {
      policy.blockedOrigins = [...new Set([...policy.blockedOrigins, origin])];
      grants[origin] = { denied: true, expiresAt: forever, persistent: true };
    } else delete grants[origin];
  });
}
