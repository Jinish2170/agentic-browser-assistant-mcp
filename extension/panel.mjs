import { initializeWorkspace } from './workspace.mjs';
const $ = (id) => document.getElementById(id);
let connection;
let currentTaskId;
let lastTask;
let status;
let refreshing = false;
let settingsLoaded = false;
let currentSessionId;
let transcriptVersion;
let modelReady = false;
let submitting = false;
let pollTimer;
let pendingStartedAt;

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !message;
}

async function message(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (response.error) throw new Error(response.error);
  return response.result;
}

async function bridge(path, method = 'GET', body) {
  if (!connection?.token) throw new Error('Connect the local bridge first');
  const response = await fetch(`${connection.url.replace(/\/$/, '')}${path}`, {
    method,
    redirect: 'error',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Bridge HTTP ${response.status}`);
  return data;
}

function listen(id, event, handler) {
  $(id).addEventListener(event, async (event) => {
    try {
      await handler(event);
    } catch (error) {
      notice(error.message, true);
    }
  });
}

async function activeOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = new URL(tab.url);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Open a normal website tab first');
  $('origin').value = url.origin;
}

function showSettings(data) {
  $('agent-steps').value = data.agent.maxSteps;
  $('agent-minutes').value = Math.ceil(data.agent.maxDurationMs / 60000);
  $('agent-context').value = data.agent.maxInputChars;
  modelReady = !!data.provider.apiKeyConfigured && !!data.provider.model;
  $('setup-model').hidden = modelReady;
  $('provider-kind').value = data.provider.kind;
  $('tool-profile').value = data.provider.toolProfile || 'auto';
  $('provider-url').value = data.provider.baseUrl;
  $('provider-model').value = data.provider.model;
  $('provider-key-status').textContent = data.provider.apiKeyConfigured ? 'configured' : '';
  $('agent-advanced').checked = !!data.provider.advancedTools;
  $('native-compaction').checked = !!data.provider.nativeCompaction;
  $('jev-enabled').checked = data.jev.enabled;
  $('jev-endpoint').value = data.jev.endpoint;
  $('jev-model').value = data.jev.model;
  $('jev-threshold').value = data.jev.confidenceThreshold;
  $('jev-key-status').textContent = data.jev.apiKeyConfigured ? 'configured' : '';
}

function renderProgress(task) {
  const working = submitting || task?.status === 'running';
  $('task-progress').hidden = !working;
  if (!working) return;
  $('progress-title').textContent = submitting
    ? 'Starting your task'
    : task.progress?.message || 'Working in your browser';
  const began = submitting ? pendingStartedAt : Date.parse(task.startedAt);
  $('progress-elapsed').textContent =
    `${Math.max(0, Math.floor((Date.now() - began) / 1000))}s elapsed`;
  const assistant = task?.events?.filter((event) => event.type === 'assistant').at(-1);
  $('progress-detail').textContent = submitting
    ? 'Connecting to the browser…'
    : task.progress?.stage === 'planning'
      ? 'Waiting for the model response. Browser actions appear here as they happen.'
      : assistant?.text || 'Your browser task is running.';
  const stages = (task?.events || []).filter((event) => event.type === 'progress').slice(-3);
  $('progress-steps').replaceChildren(
    ...stages.map((event) => {
      const row = document.createElement('li');
      row.textContent = event.message;
      return row;
    }),
  );
  $('progress-steps').hidden = !stages.length;
}

function wakePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, 100);
}

function renderTask(task) {
  lastTask = task;
  renderProgress(task);
  $('task-output').hidden = false;
  $('activity-empty').hidden = true;
  $('task-inline').hidden = false;
  $('task-inline-status').textContent =
    task.status === 'running'
      ? task.progress?.message || 'Working in your browser'
      : task.status === 'completed'
        ? 'Task completed'
        : task.status === 'blocked'
          ? 'Needs your attention'
          : 'Task stopped';
  $('task-status').textContent =
    {
      running: 'Working through your task',
      completed: 'Completed · evidence captured',
      blocked: 'Needs your attention',
      failed: 'Task stopped',
      cancelled: 'Stopped by you',
    }[task.status] || task.status;
  $('task-steps').textContent = `${task.steps} steps`;
  $('task-summary').textContent = task.summary || task.error || '';
  if (task.persistenceError) notice(`Conversation storage failed: ${task.persistenceError}`, true);
  $('task-evidence').hidden = !task.evidence;
  $('task-evidence').textContent = task.evidence || '';
  const entries = task.events.slice(-40).map((event) => {
    const el = document.createElement('li');
    el.textContent =
      event.type === 'tool'
        ? `→ ${event.name.replace('browser_', '')}${event.tabId ? ` · tab ${event.tabId}` : ''}`
        : ['jev', 'jev_decision'].includes(event.type)
          ? `Jev: ${event.choice || event.reason || 'LLM fallback'}${event.confidence !== undefined ? ` · ${Math.round(event.confidence * 100)}% confidence` : ''}`
          : event.type === 'bound_action'
            ? 'Fill supplied fields · verified label bindings'
            : event.text || event.message || event.type;
    return el;
  });
  $('trace').replaceChildren(...entries);
  const running = task.status === 'running';
  $('cancel').hidden = !running;
  $('run').hidden = false;
  $('run').textContent = running ? 'Send update' : 'Run task ↗';
  if (task.mode === 'jev-fast') {
    $('task-meta').textContent =
      `Jev fast · ${task.jev.requests} requests · ${task.jev.inputTokens.toLocaleString()} input tokens · ${(task.jev.elapsedMs / 1000).toFixed(2)}s decisions${task.timings?.totalMs ? ` · ${(task.timings.totalMs / 1000).toFixed(2)}s total` : ''}`;
    return;
  }
  $('task-meta').textContent =
    `${task.usage.inputTokens.toLocaleString()} input · ${task.usage.outputTokens.toLocaleString()} output tokens${task.timings ? ` · ${(task.timings.modelMs / 1000).toFixed(1)}s model` : ''}`;
}

function exportJson(value, filename) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refreshConversation() {
  const query = new URLSearchParams();
  if (currentSessionId) query.set('sessionId', currentSessionId);
  if (currentTaskId) query.set('taskId', currentTaskId);
  if (transcriptVersion !== undefined) query.set('revision', transcriptVersion);
  if (!$('view-memory').hidden) query.set('memory', 'true');
  const { sessions, conversation, memory, task } = await bridge(`/workspace?${query}`);
  if (task) renderTask(task);
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'New conversation';
  $('conversation').replaceChildren(
    placeholder,
    ...sessions.map((session) => {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = session.title;
      option.selected = session.id === currentSessionId;
      return option;
    }),
  );
  $('chat-empty').hidden = !!conversation?.messageCount;
  if (!conversation?.unchanged) {
    $('transcript').replaceChildren(
      ...(conversation?.messages.slice(-50) || []).map((message) => {
        const row = document.createElement('div');
        row.className = `chat-message ${message.role}`;
        const label = document.createElement('small');
        label.textContent = message.role === 'user' ? 'YOU' : 'JEV BROWSER';
        const text = document.createElement('p');
        text.textContent = message.text;
        row.append(label, text);
        return row;
      }),
    );
    transcriptVersion = conversation?.revision;
  }
  $('memory-summary').textContent = conversation
    ? `${conversation.messageCount} messages · ${conversation.compactions} context compactions\n${conversation.summary || 'Conversation context is retained for follow-up tasks.'}`
    : 'Start a task to create a conversation.';
  if (memory)
    $('facts').replaceChildren(
      ...[
        ...memory.reusable.map((fact) => ({ ...fact, reusable: true })),
        ...memory.conversation,
      ].map((fact) => {
        const row = document.createElement('li');
        const text = document.createElement('span');
        text.textContent = `${fact.reusable ? 'Reusable' : 'Conversation'} · ${fact.text}`;
        const button = document.createElement('button');
        button.className = 'secondary';
        button.textContent = 'Forget';
        button.addEventListener('click', () =>
          bridge(
            `/memory/${fact.id}${fact.reusable ? '' : `?sessionId=${currentSessionId}`}`,
            'DELETE',
          )
            .then(refreshConversation)
            .catch((error) => notice(error.message, true)),
        );
        row.append(text, button);
        return row;
      }),
    );
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    status = await message('status');
    $('extension-id').textContent = `Extension ID: ${status.extensionId}`;
    $('pause').textContent = status.paused ? 'Resume' : 'Pause';
    const live = status.connected && !status.paused;
    $('connection-dot').classList.toggle('live', live);
    $('connection-status').textContent = status.paused
      ? 'Browser access paused'
      : status.connected
        ? 'Connected to local bridge'
        : 'Bridge disconnected';
    const granted = Object.entries(status.grants).filter(
      ([, grant]) => grant.expiresAt > Date.now(),
    );
    const rows = granted.map(([origin, grant]) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = `${origin === '*' ? 'All HTTP(S) websites' : origin} · ${grant.denied ? 'blocked' : grant.mode === 'interact' ? 'interact' : 'read'} · ${grant.persistent ? 'until revoked' : `${Math.ceil((grant.expiresAt - Date.now()) / 60000)}m`}`;
      const revoke = document.createElement('button');
      revoke.textContent = 'Revoke';
      revoke.disabled = !!grant.denied;
      revoke.className = 'secondary';
      revoke.addEventListener('click', () =>
        message(origin === '*' ? 'revoke-all' : 'revoke', { origin })
          .then(refresh)
          .catch((error) => notice(error.message, true)),
      );
      li.append(span, revoke);
      return li;
    });
    $('grants').replaceChildren(...rows);
    const tabs = (await chrome.tabs.query({})).filter((tab) => {
      try {
        const url = new URL(tab.url);
        if (!['http:', 'https:'].includes(url.protocol)) return false;
        const exact = status.grants[url.origin];
        if (exact?.denied && exact.expiresAt > Date.now()) return false;
        return granted.some(([origin]) => origin === '*' || origin === url.origin);
      } catch {
        return false;
      }
    });
    const selected = $('target-tab').value;
    const options = tabs.map((tab) => {
      const option = document.createElement('option');
      option.value = tab.id;
      option.textContent = `${tab.title || tab.url}`;
      option.selected = String(tab.id) === selected || (!selected && tab.active);
      return option;
    });
    if (!options.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = granted.length
        ? 'Open a website to choose a tab'
        : 'Enable website access in Settings';
      options.push(option);
    }
    $('target-tab').replaceChildren(...options);
    $('run').disabled = !live || !tabs.length;
    const actions = status.audit
      .slice(-15)
      .reverse()
      .map((entry) => {
        const row = document.createElement('li');
        const time = new Date(entry.at).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        row.textContent = `${time} · ${entry.name?.replace('browser_', '') || 'Browser action'} · ${entry.outcome}`;
        return row;
      });
    $('browser-audit').replaceChildren(...actions);
    if (connection?.token && status.connected) {
      if (!settingsLoaded) {
        showSettings(await bridge('/settings'));
        settingsLoaded = true;
      }
      await refreshConversation();
    }
    if (lastTask?.status !== 'running') $('run').disabled ||= !modelReady;
  } catch (error) {
    $('connection-status').textContent = 'Bridge unavailable';
    $('connection-dot').classList.remove('live');
    $('run').disabled = true;
  } finally {
    refreshing = false;
  }
}

listen('current-origin', 'click', activeOrigin);
listen('pair-form', 'submit', async (event) => {
  event.preventDefault();
  const url = new URL($('bridge-url').value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Use http://127.0.0.1:PORT for the local bridge');
  const candidate = { url: url.origin, token: $('pair-token').value.trim() };
  if (candidate.token.length < 32) throw new Error('Pairing token is too short');
  await message('pair', { connection: candidate });
  connection = candidate;
  settingsLoaded = false;
  await bridge('/status');
  $('pair-token').value = '';
  notice(
    'Extension connected. MCP control is ready. Configure a model only for the built-in task runner.',
  );
  await refresh();
});
listen('grant', 'click', async () => {
  const origin = new URL($('origin').value).origin;
  if (!/^https?:\/\//.test(origin)) throw new Error('Use an HTTP(S) website origin');
  await message('grant', { origin, mode: $('mode').value, advanced: $('advanced').checked });
  notice(`Access granted for ${origin}.`);
  await refresh();
});
listen('grant-all', 'click', async () => {
  await message('grant-all', { advanced: $('advanced').checked });
  notice('All HTTP(S) websites enabled until revoked.');
  await refresh();
});
listen('pause', 'click', async () => {
  await message('pause', { paused: !status?.paused });
  if (!status?.paused && currentTaskId && lastTask?.status === 'running')
    await bridge(`/tasks/${currentTaskId}`, 'DELETE').catch(() => {});
  await refresh();
});
listen('provider-kind', 'change', () => {
  $('provider-url').value =
    $('provider-kind').value === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : 'https://api.openai.com/v1';
});
listen('model-form', 'submit', async (event) => {
  event.preventDefault();
  const data = await bridge('/settings', 'PUT', {
    agent: {
      maxSteps: Number($('agent-steps').value),
      maxDurationMs: Number($('agent-minutes').value) * 60000,
      maxInputChars: Number($('agent-context').value),
    },
    provider: {
      kind: $('provider-kind').value,
      toolProfile: $('tool-profile').value,
      baseUrl: $('provider-url').value.trim(),
      model: $('provider-model').value.trim(),
      advancedTools: $('agent-advanced').checked,
      nativeCompaction: $('native-compaction').checked,
      ...($('provider-key').value ? { apiKey: $('provider-key').value.trim() } : {}),
    },
    jev: {
      enabled: $('jev-enabled').checked,
      endpoint: $('jev-endpoint').value.trim(),
      model: $('jev-model').value.trim(),
      confidenceThreshold: Number($('jev-threshold').value),
      ...($('jev-key').value ? { apiKey: $('jev-key').value.trim() } : {}),
    },
  });
  $('provider-key').value = '';
  $('jev-key').value = '';
  showSettings(data);
  notice('Model settings saved in the local bridge.');
});
listen('run', 'click', async () => {
  const goal = $('goal').value.trim();
  if (!goal) throw new Error('Describe the task first');
  if (lastTask?.status === 'running') {
    await bridge(`/tasks/${currentTaskId}/message`, 'POST', { text: goal });
    $('goal').value = '';
    notice('Update queued for the next turn.');
    await refreshConversation();
    return;
  }
  if (submitting) return;
  submitting = true;
  pendingStartedAt = Date.now();
  $('run').disabled = true;
  renderProgress();
  notice('');
  try {
    const task = await bridge('/tasks', 'POST', {
      goal,
      tabId: Number($('target-tab').value),
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
    });
    currentTaskId = task.id;
    currentSessionId = task.sessionId;
    submitting = false;
    renderTask(task);
    wakePoll();
    await chrome.storage.local.set({ currentSessionId });
    await chrome.storage.session.set({ currentTaskId });
    $('goal').value = '';
    await refreshConversation();
  } finally {
    submitting = false;
    $('run').disabled = false;
    renderProgress(lastTask);
  }
});
listen('conversation', 'change', async () => {
  if (lastTask?.status === 'running')
    throw new Error('Stop or finish the task before changing conversations.');
  currentSessionId = $('conversation').value || undefined;
  currentTaskId = undefined;
  lastTask = undefined;
  transcriptVersion = undefined;
  $('task-output').hidden = true;
  $('task-inline').hidden = true;
  $('task-progress').hidden = true;
  $('activity-empty').hidden = false;
  $('cancel').hidden = true;
  $('run').textContent = 'Run task ↗';
  await chrome.storage.local.set({ currentSessionId: currentSessionId || null });
  await chrome.storage.session.remove('currentTaskId');
  await refreshConversation();
});
listen('new-conversation', 'click', async () => {
  if (lastTask?.status === 'running')
    throw new Error('Stop or finish the task before starting a conversation.');
  $('conversation').value = '';
  $('conversation').dispatchEvent(new Event('change'));
});
listen('save-fact', 'click', async () => {
  const text = $('fact-text').value.trim();
  if (!text) throw new Error('Enter a fact to save.');
  const inConversation = $('fact-scope').value === 'conversation';
  if (inConversation && !currentSessionId) throw new Error('Start a conversation first.');
  await bridge('/memory', 'POST', {
    text,
    ...(inConversation ? { sessionId: currentSessionId } : {}),
  });
  $('fact-text').value = '';
  await refreshConversation();
  notice('Fact saved locally.');
});
listen('export-conversation', 'click', async () => {
  if (!currentSessionId) throw new Error('Select a conversation first.');
  exportJson(
    await bridge(`/sessions/${currentSessionId}`),
    `jev-conversation-${currentSessionId}.json`,
  );
});
listen('delete-conversation', 'click', async () => {
  if (!currentSessionId) throw new Error('Select a conversation first.');
  await bridge(`/sessions/${currentSessionId}`, 'DELETE');
  $('conversation').value = '';
  $('conversation').dispatchEvent(new Event('change'));
});
listen('cancel', 'click', async () => {
  await bridge(`/tasks/${currentTaskId}`, 'DELETE');
  notice('Stopping. An already dispatched action may finish.');
});
listen('export-task', 'click', () => {
  if (!lastTask) return;
  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(
    new Blob([JSON.stringify(lastTask, null, 2)], { type: 'application/json' }),
  );
  link.href = objectUrl;
  link.download = `jev-task-${lastTask.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
});

({ connection } = await chrome.storage.local.get('connection'));
({ currentTaskId } = await chrome.storage.session.get('currentTaskId'));
({ currentSessionId } = await chrome.storage.local.get('currentSessionId'));
if (connection) $('bridge-url').value = connection.url;
await initializeWorkspace(!!connection);
await activeOrigin().catch(() => {});
await refresh();
document.addEventListener('workspace-view', () => refresh());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && (changes.grants || changes.paused)) refresh();
});
async function poll() {
  await refresh();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(
    poll,
    lastTask?.status === 'running' ? 800 : document.hidden ? 15000 : 6000,
  );
}
pollTimer = setTimeout(poll, 1000);
setInterval(() => renderProgress(lastTask), 1000);
