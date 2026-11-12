import { BROWSER_PROTOCOL } from '../shared/protocol.mjs';
import { execute, record, stopBrowser, revokeOrigin } from './browser.mjs';
import { getGrants, grantWebsite, grantAllWebsites } from './access.mjs';

let socket;
let connecting = false;
let bridgeReady = false;
const queues = new Map();
const panelUrl = chrome.runtime.getURL('panel.html');

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.alarms.create('jev-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect().catch(() => {}));
chrome.runtime.onStartup.addListener(() => connect().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => connect().catch(() => {}));

async function connect() {
  if (
    connecting ||
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  )
    return;
  connecting = true;
  try {
    await getGrants();
    const { connection } = await chrome.storage.local.get('connection');
    if (!connection?.token) return;
    const parsed = new URL(connection.url);
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    )
      throw new Error('Bridge URL must be http://127.0.0.1:PORT');
    const ws = new WebSocket(
      `${connection.url.replace(/^http/, 'ws').replace(/\/$/, '')}/extension`,
    );
    socket = ws;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'auth',
          token: connection.token,
          extensionId: chrome.runtime.id,
          protocol: BROWSER_PROTOCOL,
          version: chrome.runtime.getManifest().version,
        }),
      );
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'ready') {
        bridgeReady = true;
        return;
      }
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (message.type !== 'command') return;
      const key = message.command?.args?.tabId ?? 'global';
      const serial = (queues.get(key) || Promise.resolve())
        .catch(() => {})
        .then(async () => {
          try {
            if (socket !== ws || ws.readyState !== WebSocket.OPEN || !bridgeReady)
              throw new Error('DISCONNECTED: Command was not executed.');
            if (Date.now() > message.deadline)
              throw new Error('EXPIRED: Command was not executed.');
            const result = await execute(message.command);
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
          } catch (error) {
            await record(message.command?.name, message.command?.args?.tabId, 'error');
            if (ws.readyState === WebSocket.OPEN)
              ws.send(
                JSON.stringify({
                  type: 'result',
                  id: message.id,
                  error: error.message,
                  ...(error.mutationOutcome === 'not_dispatched'
                    ? { mutationOutcome: 'not_dispatched' }
                    : {}),
                }),
              );
          }
        });
      queues.set(key, serial);
      serial.finally(() => {
        if (queues.get(key) === serial) queues.delete(key);
      });
    };
    ws.onclose = () => {
      if (socket === ws) {
        socket = undefined;
        bridgeReady = false;
      }
    };
    ws.onerror = () => ws.close();
  } finally {
    connecting = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== panelUrl) return false;
  (async () => {
    if (message.type === 'pair') {
      await chrome.storage.local.set({ connection: message.connection });
      socket?.close();
      socket = undefined;
      bridgeReady = false;
      await connect();
      return { paired: true };
    }
    if (message.type === 'status') {
      await getGrants();
      return {
        connected: socket?.readyState === WebSocket.OPEN && bridgeReady,
        extensionId: chrome.runtime.id,
        ...(await chrome.storage.session.get({ grants: {}, paused: false, audit: [] })),
      };
    }
    if (message.type === 'grant') {
      await grantWebsite(message.origin, message.mode, message.advanced);
      return { granted: message.origin };
    }
    if (message.type === 'revoke') {
      await revokeOrigin(message.origin);
      return { revoked: true };
    }
    if (message.type === 'grant-all') {
      await grantAllWebsites(message.advanced);
      return { granted: 'All HTTP(S) websites', persistent: true };
    }
    if (message.type === 'revoke-all') {
      await revokeOrigin('*');
      return { revoked: 'All-websites grant' };
    }
    if (message.type === 'pause') {
      await stopBrowser(!!message.paused);
      return { paused: !!message.paused };
    }
    throw new Error('Unknown panel message');
  })()
    .then((result) => respond({ result }))
    .catch((error) => respond({ error: error.message }));
  return true;
});
connect().catch(() => {});
