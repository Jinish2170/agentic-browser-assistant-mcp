import { parseCommand, tools, assertGrant, originOf } from '../shared/tools.mjs';
import { pageOperation } from './dom.mjs';
import { frameOperation } from './frames.mjs';
import { executeStep } from './step.mjs';
import { fillForm } from './form.mjs';
import { readDownloads } from './downloads.mjs';
import { waitForState } from './wait.mjs';
import { getGrants, revokeWebsite } from './access.mjs';
import { checkedGroup, listGroups, groupTabs, updateGroup } from './groups.mjs';

let stopped = false;
const attached = new Set();
const events = new Map();
const dialogs = new Map();
const dialogWaiters = new Map();
const navigations = new Map();
const diagnostics = new Map();
const safeUrl = (value) => {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return '[unavailable URL]';
  }
};
const bounded = (value) => String(value ?? '').slice(0, 2000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const session = getGrants;
let auditWrites = Promise.resolve();
export async function record(name, tabId, outcome) {
  const write = auditWrites
    .catch(() => {})
    .then(async () => {
      const { audit = [] } = await chrome.storage.session.get('audit');
      audit.push({ at: new Date().toISOString(), name, tabId, outcome });
      await chrome.storage.session.set({ audit: audit.slice(-150) });
    });
  auditWrites = write;
  return write;
}
async function check(tabId, def, frameId = 0) {
  const { paused } = await chrome.storage.session.get('paused');
  if (paused || stopped) throw new Error('PAUSED: Resume in the side panel.');
  const tab = await chrome.tabs.get(tabId);
  const grants = await session();
  // Newly created tabs can still be about:blank while their approved URL loads.
  const currentUrl = /^https?:\/\//.test(tab.url || '') ? tab.url : tab.pendingUrl;
  assertGrant(grants, currentUrl, def.write, def.advanced);
  if (tab.pendingUrl) assertGrant(grants, tab.pendingUrl, def.write, def.advanced);
  if (frameId) {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
    if (!frame?.url) throw new Error('FRAME_NOT_FOUND');
    assertGrant(grants, frame.url, def.write, def.advanced);
  }
  return tab;
}
async function dom(tabId, frameId, op, args) {
  // Recheck immediately before injection, including pending cross-origin navigations.
  await check(tabId, { write: !['snapshot', 'extract', 'wait', 'point'].includes(op) }, frameId);
  const result = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId ?? 0] },
    func: pageOperation,
    args: [op, args],
  });
  const data = result[0]?.result;
  if (!data) throw new Error('Frame is unavailable');
  if (data.error) throw new Error(data.error);
  return data;
}
async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
}
async function cdp(tabId, method, params = {}, write = true, advanced = false) {
  await check(tabId, { write, advanced });
  await attach(tabId);
  if (!method.startsWith('Input.') && method !== 'Runtime.evaluate') {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
  // Input commands can remain unresolved while a JavaScript dialog is open.
  // Return the dialog as an observation so the next tool can handle it.
  let release;
  const dialogOpened = new Promise((resolve) => {
    release = resolve;
  });
  dialogWaiters.set(tabId, release);
  try {
    return await Promise.race([
      chrome.debugger.sendCommand({ tabId }, method, params),
      dialogOpened,
    ]);
  } finally {
    if (dialogWaiters.get(tabId) === release) dialogWaiters.delete(tabId);
  }
}
chrome.debugger.onDetach.addListener((source, reason) => {
  const wasAttached = attached.delete(source.tabId);
  diagnostics.delete(source.tabId);
  if (wasAttached && reason === 'canceled_by_user') {
    stopped = true;
    chrome.storage.session.set({ paused: true });
  }
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  const capture = diagnostics.get(source.tabId);
  if (capture) {
    if (method === 'Runtime.consoleAPICalled')
      capture.console.push({
        type: params.type,
        text: params.args
          .map((arg) => bounded(arg.value ?? arg.description))
          .join(' ')
          .slice(0, 4000),
        at: Date.now(),
      });
    if (method === 'Runtime.exceptionThrown')
      capture.console.push({
        type: 'exception',
        text: bounded(
          params.exceptionDetails.exception?.description || params.exceptionDetails.text,
        ),
        at: Date.now(),
      });
    if (method === 'Log.entryAdded')
      capture.console.push({
        type: params.entry.level,
        text: bounded(params.entry.text),
        at: Date.now(),
      });
    if (method === 'Network.requestWillBeSent') {
      capture.network.set(params.requestId, {
        requestId: params.requestId,
        url: safeUrl(params.request.url),
        origin: (() => {
          try {
            return originOf(params.request.url);
          } catch {
            return null;
          }
        })(),
        method: params.request.method,
        type: params.type,
        at: Date.now(),
        complete: false,
      });
    }
    if (method === 'Network.responseReceived') {
      const request = capture.network.get(params.requestId);
      if (request)
        Object.assign(request, {
          status: params.response.status,
          mimeType: params.response.mimeType,
        });
    }
    if (method === 'Network.loadingFinished') {
      const request = capture.network.get(params.requestId);
      if (request)
        Object.assign(request, { complete: true, encodedDataLength: params.encodedDataLength });
    }
    if (method === 'Network.loadingFailed') {
      const request = capture.network.get(params.requestId);
      if (request) Object.assign(request, { error: bounded(params.errorText) });
    }
    capture.console = capture.console.slice(-100);
    while (capture.network.size > 150) capture.network.delete(capture.network.keys().next().value);
  }
  if (method === 'Page.javascriptDialogClosed') {
    dialogs.delete(source.tabId);
    return;
  }
  if (
    !['Page.javascriptDialogOpening', 'Page.downloadWillBegin', 'Page.downloadProgress'].includes(
      method,
    )
  )
    return;
  if (method === 'Page.javascriptDialogOpening') {
    const dialog = {
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPrompt,
    };
    dialogs.set(source.tabId, dialog);
    dialogWaiters.get(source.tabId)?.({ pendingDialog: dialog });
  }
  const list = events.get(source.tabId) || [];
  list.push({ method, params, at: Date.now() });
  events.set(source.tabId, list.slice(-50));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  events.delete(tabId);
  dialogs.delete(tabId);
  navigations.delete(tabId);
  diagnostics.delete(tabId);
});
chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  if (frameId === 0) navigations.set(tabId, { committed: false });
});
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) navigations.set(tabId, { committed: true });
});
chrome.webNavigation.onErrorOccurred.addListener(({ tabId, frameId, error }) => {
  if (frameId === 0) navigations.set(tabId, { error });
});
for (const event of [
  chrome.webNavigation.onHistoryStateUpdated,
  chrome.webNavigation.onReferenceFragmentUpdated,
]) {
  event.addListener(({ tabId, frameId }) => {
    if (frameId === 0) navigations.set(tabId, { committed: true });
  });
}
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url || !attached.has(tabId)) return;
  try {
    assertGrant(await session(), change.url);
  } catch {
    attached.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
});

async function point(args) {
  if (args.ref || args.selector) {
    let p = await dom(args.tabId, args.frameId, 'point', args);
    let frameId = args.frameId || 0;
    for (let depth = 0; frameId && depth < 20; depth++) {
      const frame = await chrome.webNavigation.getFrame({ tabId: args.tabId, frameId });
      if (!frame || frame.parentFrameId < 0) throw new Error('FRAME_NOT_FOUND');
      const parentId = frame.parentFrameId;
      const nonce = crypto.randomUUID();
      const relay = async (id, operation) => {
        await check(args.tabId, { write: true }, id);
        const [data] = await chrome.scripting.executeScript({
          target: { tabId: args.tabId, frameIds: [id] },
          func: frameOperation,
          args: [operation, { nonce, point: p }],
        });
        if (!data?.result || data.result.error)
          throw new Error(data?.result?.error || 'Frame unavailable');
        return data.result;
      };
      await relay(parentId, 'prepare');
      try {
        await relay(frameId, 'send');
        p = await relay(parentId, 'result');
      } finally {
        await relay(parentId, 'cancel').catch(() => {});
      }
      frameId = parentId;
    }
    if (frameId) throw new Error('FRAME_DEPTH_LIMIT');
    return p;
  }
  if (args.x === undefined || args.y === undefined)
    throw new Error('Provide ref, selector, or both x and y');
  return { x: args.x, y: args.y };
}
// This wrapper ends before the first native input command. Errors after that boundary
// remain uncertain even if their message resembles a preflight failure.
async function beforeInput(prepare) {
  try {
    return await prepare();
  } catch (error) {
    error.mutationOutcome = 'not_dispatched';
    throw error;
  }
}
async function inputPoint(args) {
  let p = await point(args);
  if (args.frameId) {
    // A freshly navigated OOP iframe can have DOM geometry before Viz publishes its
    // hit-test surface. Synchronize with a rendered frame before dispatching input.
    // This is a read, never a second click; discard the image and recheck geometry.
    await cdp(
      args.tabId,
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      false,
    );
    p = await point(args);
  }
  return p;
}
async function press(tabId, shortcut) {
  const parts = shortcut.split('+');
  const key = parts.pop();
  let modifiers = 0;
  for (const mod of parts) {
    const value = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }[mod];
    if (!value) throw new Error(`Unsupported modifier: ${mod}`);
    modifiers |= value;
  }
  const special = {
    Enter: [13, 'Enter', '\r'],
    Tab: [9, 'Tab'],
    Escape: [27, 'Escape'],
    Backspace: [8, 'Backspace'],
    Delete: [46, 'Delete'],
    ArrowLeft: [37, 'ArrowLeft'],
    ArrowUp: [38, 'ArrowUp'],
    ArrowRight: [39, 'ArrowRight'],
    ArrowDown: [40, 'ArrowDown'],
    Home: [36, 'Home'],
    End: [35, 'End'],
    PageUp: [33, 'PageUp'],
    PageDown: [34, 'PageDown'],
    Space: [32, 'Space', ' '],
  };
  if (!special[key] && key.length !== 1) throw new Error(`Unsupported key: ${key}`);
  const [code, codeName, text] = special[key] || [
    key.toUpperCase().charCodeAt(0),
    `Key${key.toUpperCase()}`,
    key,
  ];
  const params = {
    key: key === 'Space' ? ' ' : key,
    code: codeName,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    modifiers,
  };
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    ...params,
    type: text && !modifiers ? 'keyDown' : 'rawKeyDown',
    ...(text && !modifiers ? { text, unmodifiedText: text } : {}),
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
}

export async function execute(command) {
  const { name, args } = parseCommand(command);
  const def = tools[name];
  if (name === 'browser_capabilities') {
    await getGrants();
    const { paused, grants = {} } = await chrome.storage.session.get({ paused: false, grants: {} });
    const permissions = await chrome.permissions.getAll();
    return {
      browser: navigator.userAgent,
      paused: !!paused || stopped,
      allWebsites: grants['*']?.expiresAt > Date.now() ? grants['*'] : null,
      permissions: permissions.permissions,
      hostPermissions: permissions.origins,
      tools: Object.keys(tools),
      apiDetected: {
        debugger: !!chrome.debugger,
        windows: !!chrome.windows,
        downloads: !!chrome.downloads,
        frames: !!chrome.webNavigation,
        tabGroups: !!chrome.tabGroups,
      },
      alternatives: [
        {
          surface: 'Native file chooser',
          path: 'browser_upload attaches files directly; no chooser required.',
        },
        {
          surface: 'Save dialog',
          path: 'browser_download starts an authorized URL download with saveAs:false.',
        },
        {
          surface: 'Nested/cross-site frames',
          path: 'Use frameId plus a fresh DOM ref; screenshot coordinates cover unsupported transforms.',
        },
        {
          surface: 'Browser settings/permissions/security UI',
          path: 'Use named Chrome APIs where exposed; otherwise user interaction through Chrome UI is required.',
        },
        {
          surface: 'Login, 2FA, CAPTCHA',
          path: 'Keep the tab and conversation; user completes the challenge, then continue in the same conversation.',
        },
      ],
      note: 'Detected APIs are not proof that enterprise policies permit attachment to every target. No external LLM/Jev API key is required for direct MCP commands.',
    };
  }
  if ((await chrome.storage.session.get('paused')).paused || stopped) throw new Error('PAUSED');
  const grants = await session();
  if (name === 'browser_tabs') {
    return {
      tabs: (await chrome.tabs.query({}))
        .filter((tab) => {
          try {
            assertGrant(grants, tab.url);
            return true;
          } catch {
            return false;
          }
        })
        .map((tab) => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          active: tab.active,
          openerTabId: tab.openerTabId,
          status: tab.status,
          windowId: tab.windowId,
          groupId: tab.groupId,
          access: assertGrant(grants, tab.url).mode,
        })),
    };
  }
  if (name === 'browser_open') {
    assertGrant(grants, args.url, true);
    if (args.groupId !== undefined && !args.grouped)
      throw new Error('groupId requires grouped:true.');
    const targetGroup =
      args.groupId !== undefined ? await checkedGroup(args.groupId, grants) : undefined;
    const tab = await chrome.tabs.create({
      url: args.url,
      active: args.active,
      ...(targetGroup ? { windowId: targetGroup.windowId } : {}),
    });
    const result = { tabId: tab.id, url: args.url, groupId: -1 };
    if (args.grouped) {
      try {
        Object.assign(
          result,
          await groupTabs(
            { tabIds: [tab.id], groupId: args.groupId, collapsed: false },
            grants,
            args.groupId === undefined,
          ),
        );
      } catch (error) {
        result.warning = `Tab was opened but grouping did not complete: ${error.message}. Inspect the tab; do not reopen it.`;
      }
    }
    return result;
  }
  if (name === 'browser_groups') return listGroups(grants, args.windowId);
  if (name === 'browser_group_tabs') return groupTabs(args, grants);
  if (name === 'browser_group_update') return updateGroup(args, grants);
  await check(args.tabId, def, args.frameId);
  let result;
  switch (name) {
    case 'browser_extract':
      result = await dom(args.tabId, args.frameId, 'extract', args);
      break;
    case 'browser_fill_form':
      result = await fillForm(args, execute, (operation, fields) =>
        dom(args.tabId, args.frameId, operation, fields),
      );
      break;
    case 'browser_step':
      result = await executeStep(args, execute);
      break;
    case 'browser_navigate':
      assertGrant(grants, args.url, true);
      navigations.set(args.tabId, { committed: false });
      {
        const navigation = await cdp(args.tabId, 'Page.navigate', { url: args.url });
        if (navigation.errorText) throw new Error(`NAVIGATION_FAILED: ${navigation.errorText}`);
      }
      result = { navigating: args.url };
      break;
    case 'browser_tab':
      if (args.operation === 'activate') await chrome.tabs.update(args.tabId, { active: true });
      if (['reload', 'back', 'forward'].includes(args.operation))
        navigations.set(args.tabId, { committed: false });
      if (args.operation === 'reload') await chrome.tabs.reload(args.tabId);
      if (args.operation === 'close') await chrome.tabs.remove(args.tabId);
      if (['back', 'forward'].includes(args.operation)) {
        const history = await cdp(args.tabId, 'Page.getNavigationHistory');
        const entry = history.entries[history.currentIndex + (args.operation === 'back' ? -1 : 1)];
        if (!entry) {
          navigations.delete(args.tabId);
          throw new Error('NO_HISTORY_ENTRY: No page in that direction.');
        }
        assertGrant(grants, entry.url, true);
        await cdp(args.tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
      }
      result = { operation: args.operation };
      break;
    case 'browser_snapshot': {
      result = await dom(args.tabId, args.frameId, 'snapshot', args);
      if (args.includeFrames)
        result.frames = (
          (await chrome.webNavigation.getAllFrames({ tabId: args.tabId })) || []
        ).map((frame) => ({
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          url: frame.url,
          authorized: (() => {
            try {
              assertGrant(grants, frame.url);
              return true;
            } catch {
              return false;
            }
          })(),
        }));
      break;
    }
    case 'browser_screenshot': {
      const data = await cdp(
        args.tabId,
        'Page.captureScreenshot',
        {
          format: args.format,
          ...(args.format === 'jpeg' ? { quality: args.quality ?? 80 } : {}),
          captureBeyondViewport: false,
        },
        false,
      );
      result = {
        image: { mimeType: args.format === 'jpeg' ? 'image/jpeg' : 'image/png', data: data.data },
        coordinateSpace: 'CSS viewport pixels',
        trust: 'UNTRUSTED_WEBPAGE_DATA',
      };
      break;
    }
    case 'browser_accessibility': {
      const tree = await cdp(args.tabId, 'Accessibility.getFullAXTree', {}, false);
      const visible = tree.nodes.filter((node) => !node.ignored);
      result = {
        nodes: visible.slice(0, args.maxNodes).map((node) => ({
          id: node.nodeId,
          parentId: node.parentId,
          children: node.childIds,
          role: node.role?.value,
          name: bounded(node.name?.value),
          ...(node.role?.value === 'textbox' ? {} : { value: bounded(node.value?.value) }),
          properties: (node.properties || [])
            .filter((property) =>
              ['checked', 'disabled', 'expanded', 'selected', 'required', 'focusable'].includes(
                property.name,
              ),
            )
            .map((property) => ({ name: property.name, value: property.value.value })),
        })),
        truncated: visible.length > args.maxNodes,
        trust: 'UNTRUSTED_WEBPAGE_DATA',
      };
      break;
    }
    case 'browser_diagnostics': {
      if (args.operation === 'start') {
        diagnostics.set(args.tabId, { console: [], network: new Map() });
        await cdp(args.tabId, 'Runtime.enable', {}, false);
        await cdp(args.tabId, 'Log.enable', {}, false);
      }
      if (args.operation === 'clear' && diagnostics.has(args.tabId))
        diagnostics.set(args.tabId, { console: [], network: new Map() });
      const capture = diagnostics.get(args.tabId);
      result = {
        recording: !!capture,
        console: capture?.console || [],
        network: capture ? [...capture.network.values()].map(({ origin, ...entry }) => entry) : [],
        trust: 'UNTRUSTED_WEBPAGE_DATA',
      };
      break;
    }
    case 'browser_response': {
      const request = diagnostics.get(args.tabId)?.network.get(args.requestId);
      const tab = await check(args.tabId, def);
      if (!request?.complete || request.origin !== originOf(tab.url))
        throw new Error(
          'RESPONSE_ACCESS_DENIED: Only recorded completed same-origin responses are available.',
        );
      const data = await cdp(
        args.tabId,
        'Network.getResponseBody',
        { requestId: args.requestId },
        false,
        true,
      );
      if (data.base64Encoded) throw new Error('BINARY_RESPONSE_UNSUPPORTED');
      result = {
        requestId: args.requestId,
        body: data.body.slice(0, args.maxChars),
        truncated: data.body.length > args.maxChars,
        trust: 'UNTRUSTED_WEBPAGE_DATA',
      };
      break;
    }
    case 'browser_metrics':
      await cdp(args.tabId, 'Performance.enable', {}, false);
      result = await cdp(args.tabId, 'Performance.getMetrics', {}, false);
      break;
    case 'browser_emulate':
      await cdp(
        args.tabId,
        args.operation === 'reset'
          ? 'Emulation.clearDeviceMetricsOverride'
          : 'Emulation.setDeviceMetricsOverride',
        args.operation === 'reset'
          ? {}
          : {
              width: args.width,
              height: args.height,
              deviceScaleFactor: args.deviceScaleFactor,
              mobile: args.mobile,
            },
      );
      result = { operation: args.operation, width: args.width, height: args.height };
      break;
    case 'browser_click': {
      const p = await beforeInput(() => inputPoint(args));
      await cdp(args.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await cdp(args.tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        buttons: args.button === 'right' ? 2 : 1,
        x: p.x,
        y: p.y,
        button: args.button,
        clickCount: args.clickCount,
      });
      await cdp(args.tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        buttons: 0,
        x: p.x,
        y: p.y,
        button: args.button,
        clickCount: args.clickCount,
      });
      result = { clicked: p };
      break;
    }
    case 'browser_type': {
      // Framed typing still validates ancestor geometry/access before focus.
      const prepared = await beforeInput(async () => {
        if (args.frameId) await point(args);
        return dom(args.tabId, args.frameId, 'focus', args);
      });
      if (args.replace && !prepared.empty)
        await press(args.tabId, /Mac/.test(navigator.platform) ? 'Meta+A' : 'Control+A');
      await cdp(args.tabId, 'Input.insertText', { text: args.text });
      result = { typedCharacters: args.text.length };
      break;
    }
    case 'browser_select':
      result = await dom(args.tabId, args.frameId, 'select', args);
      break;
    case 'browser_press':
      await press(args.tabId, args.key);
      result = { pressed: args.key };
      break;
    case 'browser_scroll':
      if (args.ref || args.selector) result = await dom(args.tabId, args.frameId, 'scroll', args);
      else {
        await cdp(args.tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 100,
          y: 100,
          deltaX: args.deltaX,
          deltaY: args.deltaY,
        });
        result = { scrolled: args.deltaY };
      }
      break;
    case 'browser_hover': {
      const p = await beforeInput(() => inputPoint(args));
      await cdp(args.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      result = { hovered: p };
      break;
    }
    case 'browser_drag':
      await cdp(args.tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: args.fromX,
        y: args.fromY,
      });
      await cdp(args.tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: args.fromX,
        y: args.fromY,
        button: 'left',
        clickCount: 1,
      });
      for (let i = 1; i <= 12; i++)
        await cdp(args.tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: args.fromX + ((args.toX - args.fromX) * i) / 12,
          y: args.fromY + ((args.toY - args.fromY) * i) / 12,
          button: 'left',
          buttons: 1,
        });
      await cdp(args.tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: args.toX,
        y: args.toY,
        button: 'left',
        clickCount: 1,
      });
      result = { dragged: true };
      break;
    case 'browser_wait': {
      result = await waitForState(args, {
        check: () => check(args.tabId, def, args.frameId),
        inspect: () => dom(args.tabId, args.frameId, 'wait', args),
        navigation: () => navigations.get(args.tabId),
        sleep,
      });
      navigations.delete(args.tabId);
      break;
    }
    case 'browser_dialog':
      await cdp(args.tabId, 'Page.handleJavaScriptDialog', {
        accept: args.accept,
        ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
      });
      result = { handled: true };
      break;
    case 'browser_downloads':
      result = await readDownloads(args, events.get(args.tabId) || [], () =>
        check(args.tabId, def),
      );
      break;
    case 'browser_download': {
      const { managedDownloads = {} } = await chrome.storage.session.get('managedDownloads');
      let id = args.id;
      let trackingWarning;
      if (args.operation === 'start') {
        if (!args.url) throw new Error('Provide the download URL');
        assertGrant(grants, args.url, true);
        if (Object.keys(managedDownloads).length >= 200)
          throw new Error(
            'DOWNLOAD_LIMIT: Restart the browser session to clear old managed download records.',
          );
        id = await chrome.downloads.download({
          url: args.url,
          ...(args.filename ? { filename: args.filename } : {}),
          saveAs: false,
        });
        managedDownloads[id] = { tabId: args.tabId, url: args.url };
        try {
          await chrome.storage.session.set({ managedDownloads });
        } catch {
          trackingWarning =
            'Download started but its management record could not be saved. Inspect Chrome downloads; do not retry start.';
        }
      } else {
        if (id === undefined || managedDownloads[id]?.tabId !== args.tabId)
          throw new Error(
            'DOWNLOAD_NOT_OWNED: This tool can only manage downloads it started in this tab.',
          );
        assertGrant(grants, managedDownloads[id].url, true);
        await chrome.downloads[args.operation](id);
      }
      result = {
        id,
        operation: args.operation,
        ...(trackingWarning ? { warning: trackingWarning } : {}),
      };
      break;
    }
    case 'browser_window': {
      const tab = await chrome.tabs.get(args.tabId);
      const state = {
        minimize: 'minimized',
        maximize: 'maximized',
        fullscreen: 'fullscreen',
        restore: 'normal',
      }[args.operation];
      if (args.operation === 'resize' && (args.width === undefined || args.height === undefined))
        throw new Error('Resize requires width and height');
      const window = await chrome.windows.update(
        tab.windowId,
        state
          ? { state }
          : args.operation === 'focus'
            ? { focused: true }
            : { state: 'normal', width: args.width, height: args.height },
      );
      result = {
        windowId: window.id,
        state: window.state,
        width: window.width,
        height: window.height,
        focused: window.focused,
      };
      break;
    }
    case 'browser_tab_manage': {
      if (args.operation === 'ungroup') await chrome.tabs.ungroup(args.tabId);
      const tab =
        args.operation === 'move'
          ? await chrome.tabs.move(args.tabId, {
              index: args.index,
              ...(args.windowId ? { windowId: args.windowId } : {}),
            })
          : args.operation === 'ungroup'
            ? await chrome.tabs.get(args.tabId)
            : await chrome.tabs.update(
                args.tabId,
                ['pin', 'unpin'].includes(args.operation)
                  ? { pinned: args.operation === 'pin' }
                  : { muted: args.operation === 'mute' },
              );
      result = {
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned,
        muted: tab.mutedInfo.muted,
        groupId: tab.groupId,
      };
      break;
    }
    case 'browser_evaluate': {
      const data = await cdp(
        args.tabId,
        'Runtime.evaluate',
        { expression: args.expression, returnByValue: true, awaitPromise: true, timeout: 10000 },
        true,
        true,
      );
      if (data.pendingDialog) {
        result = data;
        break;
      }
      if (data.exceptionDetails) throw new Error(data.exceptionDetails.text || 'Evaluation failed');
      result = { value: data.result.value, description: data.result.description };
      break;
    }
    case 'browser_upload': {
      const doc = await cdp(args.tabId, 'DOM.getDocument', {}, true, true);
      const nodes = await cdp(
        args.tabId,
        'DOM.querySelectorAll',
        { nodeId: doc.root.nodeId, selector: args.selector },
        true,
        true,
      );
      if (nodes.nodeIds.length !== 1)
        throw new Error('Upload selector must match exactly one input');
      const node = await cdp(
        args.tabId,
        'DOM.describeNode',
        { nodeId: nodes.nodeIds[0] },
        true,
        true,
      );
      const attrs = Object.fromEntries(
        Array.from({ length: node.node.attributes.length / 2 }, (_, i) =>
          node.node.attributes.slice(i * 2, i * 2 + 2),
        ),
      );
      if (node.node.nodeName !== 'INPUT' || attrs.type !== 'file')
        throw new Error('Upload target must be input[type=file]');
      await cdp(
        args.tabId,
        'DOM.setFileInputFiles',
        { nodeId: nodes.nodeIds[0], files: args.files },
        true,
        true,
      );
      result = { filesAttached: args.files.length };
      break;
    }
    default:
      throw new Error('Unknown tool');
  }
  if (dialogs.has(args.tabId)) result.pendingDialog = dialogs.get(args.tabId);
  try {
    await record(
      name,
      args.tabId,
      result.error ? result.outcome || 'error' : result.pendingDialog ? 'pending_dialog' : 'ok',
    );
  } catch {
    result.auditWarning = 'Action returned successfully; the local audit entry could not be saved.';
  }
  return result;
}

export async function stopBrowser(paused) {
  stopped = paused;
  await chrome.storage.session.set({ paused });
  if (paused) {
    for (const tabId of [...attached]) {
      attached.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }
}

export async function revokeOrigin(origin) {
  const grants = await revokeWebsite(origin);
  for (const tabId of [...attached]) {
    try {
      assertGrant(grants, (await chrome.tabs.get(tabId)).url);
    } catch {
      attached.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }
}
