const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readDownloads(args, events, checkAccess) {
  const { managedDownloads = {} } = await chrome.storage.session.get('managedDownloads');
  if (args.waitForId !== undefined && managedDownloads[args.waitForId]?.tabId !== args.tabId)
    throw new Error(
      'DOWNLOAD_NOT_OWNED: Only downloads started by this tool in this tab may be awaited.',
    );
  const deadline = Date.now() + args.timeoutMs;
  let downloads;
  do {
    await checkAccess();
    downloads = [];
    for (const [id, owner] of Object.entries(managedDownloads)) {
      if (owner.tabId !== args.tabId) continue;
      const [item] = await chrome.downloads.search({ id: Number(id) });
      if (item)
        downloads.push({
          id: item.id,
          filename: item.filename,
          state: item.state,
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          error: item.error,
          paused: item.paused,
          danger: item.danger,
          canResume: item.canResume,
          exists: item.exists,
        });
    }
    if (args.waitForId === undefined) break;
    const target = downloads.find((item) => item.id === args.waitForId);
    if (!target || target.state !== 'in_progress' || target.paused || target.danger !== 'safe')
      break;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(200, deadline - Date.now()));
  } while (true);
  const awaited =
    args.waitForId === undefined ? undefined : downloads.find((item) => item.id === args.waitForId);
  return {
    events: events.filter((event) => event.method.startsWith('Page.download')),
    downloads,
    ...(args.waitForId !== undefined
      ? { awaited, waitTimedOut: awaited?.state === 'in_progress' && Date.now() >= deadline }
      : {}),
  };
}
