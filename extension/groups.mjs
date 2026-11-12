import { assertGrant } from '../shared/tools.mjs';

const defaultTitle = 'JEV Browser';
const details = ({ id, windowId, title, color, collapsed }) => ({
  id,
  windowId,
  title,
  color,
  collapsed,
});

function authorizeTab(tab, grants, write) {
  assertGrant(grants, /^https?:\/\//.test(tab.url || '') ? tab.url : tab.pendingUrl, write);
  if (tab.pendingUrl) assertGrant(grants, tab.pendingUrl, write);
}

export async function checkedGroup(groupId, grants, write = true) {
  const group = await chrome.tabGroups.get(groupId);
  const tabs = await chrome.tabs.query({ groupId });
  if (!tabs.length) throw new Error('GROUP_NOT_FOUND: The group has no tabs.');
  for (const tab of tabs) authorizeTab(tab, grants, write);
  return { ...details(group), tabIds: tabs.map((tab) => tab.id) };
}

export async function listGroups(grants, windowId) {
  const groups = [];
  for (const group of await chrome.tabGroups.query(windowId ? { windowId } : {})) {
    try {
      groups.push(await checkedGroup(group.id, grants, false));
    } catch {
      /* Omit groups containing blocked or browser-owned tabs. */
    }
  }
  return { groups };
}

async function defaultGroup(windowId, grants) {
  const { jevGroups = {} } = await chrome.storage.session.get('jevGroups');
  const candidates = [
    jevGroups[windowId],
    ...(await chrome.tabGroups.query({ windowId, title: defaultTitle }))
      .filter((group) => group.title === defaultTitle)
      .map((group) => group.id),
  ];
  for (const id of new Set(candidates.filter((id) => id !== undefined))) {
    try {
      const group = await checkedGroup(id, grants);
      if (group.windowId === windowId) return group;
    } catch {
      /* Closed, moved or inaccessible groups cannot be reused. */
    }
  }
}

export async function groupTabs(args, grants, useDefault = false) {
  const tabs = await Promise.all(args.tabIds.map((id) => chrome.tabs.get(id)));
  for (const tab of tabs) {
    authorizeTab(tab, grants, true);
    if (tab.pinned) throw new Error('PINNED_TAB: Unpin the tab before grouping it.');
  }
  const windowId = tabs[0].windowId;
  if (tabs.some((tab) => tab.windowId !== windowId))
    throw new Error('GROUP_WINDOW: Move the tabs into the same window before grouping.');
  const existing =
    args.groupId !== undefined
      ? await checkedGroup(args.groupId, grants)
      : useDefault
        ? await defaultGroup(windowId, grants)
        : undefined;
  if (existing && existing.windowId !== windowId)
    throw new Error('GROUP_WINDOW: The target group belongs to another window.');
  const id = await chrome.tabs.group({
    tabIds: args.tabIds,
    ...(existing ? { groupId: existing.id } : { createProperties: { windowId } }),
  });
  // Grouping has already happened. Later metadata/storage failures must return
  // the known group ID, rather than suggesting that the mutation can be retried.
  const result = { groupId: id, tabIds: args.tabIds };
  try {
    const changes = existing ? {} : { title: defaultTitle, color: 'purple', collapsed: false };
    for (const key of ['title', 'color', 'collapsed'])
      if (args[key] !== undefined) changes[key] = args[key];
    if (Object.keys(changes).length) await chrome.tabGroups.update(id, changes);
    result.group = details(await chrome.tabGroups.get(id));
    if (useDefault) {
      const { jevGroups = {} } = await chrome.storage.session.get('jevGroups');
      jevGroups[windowId] = id;
      await chrome.storage.session.set({ jevGroups });
    }
  } catch (error) {
    result.warning = `Tabs were grouped, but group metadata could not be fully saved: ${error.message}`;
  }
  return result;
}

export async function updateGroup(args, grants) {
  const changes = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'groupId'));
  if (!Object.keys(changes).length) throw new Error('Specify a title, color or collapsed state.');
  await checkedGroup(args.groupId, grants);
  const group = await chrome.tabGroups.update(args.groupId, changes);
  return { group: details(group) };
}
