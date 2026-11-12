import { BROWSER_PROTOCOL } from '../shared/protocol.mjs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { BrowserLink } from './browser-link.mjs';
import { TaskRunner } from './agent.mjs';
import { JevClient } from './jev.mjs';
import { Settings } from './settings.mjs';
import { SessionStore } from './session-store.mjs';
import { SkillLibrary } from './skills.mjs';
import { root } from './config.mjs';
import path from 'node:path';
import { tokenMatches, validHost, extensionOrigin, readJson } from './security.mjs';
import { fastInput } from './fast-engine.mjs';

const taskInput = z
  .object({
    goal: z.string().min(1).max(12000),
    tabId: z.number().int().positive(),
    sessionId: z.string().uuid().optional(),
  })
  .strict();
const locateInput = z
  .object({
    target: z.string().min(1).max(1000),
    tabId: z.number().int().positive(),
    frameId: z.number().int().nonnegative().default(0),
  })
  .strict();

export async function createBridge(
  config,
  {
    settings = new Settings(config),
    store = new SessionStore(path.join(path.dirname(settings.configFile), 'memory')),
    skills = new SkillLibrary(path.join(root, 'skills')),
  } = {},
) {
  await settings.load();
  await store.load();
  const browser = new BrowserLink(config);
  let jev = new JevClient(config.jev, settings.key(config.jev.apiKeyEnv, 'jev'));
  const runner = new TaskRunner({
    config,
    browser,
    jev,
    getKey: (env, name) => settings.key(env, name),
    store,
    skills,
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 12 * 1024 * 1024,
    perMessageDeflate: false,
  });
  let extensionId;
  let settingsBusy = false;
  let externalBusy = false;

  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    try {
      if (!validHost(request.headers.host, config.port))
        return reply(403, { error: 'Invalid Host' });
      const origin = request.headers.origin;
      if (
        origin &&
        (!extensionOrigin(origin) ||
          (extensionId && origin !== `chrome-extension://${extensionId}`))
      )
        return reply(403, { error: 'Invalid Origin' });
      if (!tokenMatches(request.headers.authorization?.replace(/^Bearer /, ''), config.token))
        return reply(401, { error: 'Unauthorized' });
      const requestUrl = new URL(request.url, `http://127.0.0.1:${config.port}`);
      const pathname = requestUrl.pathname;
      if (request.method === 'GET' && pathname === '/status')
        return reply(200, {
          connected: browser.connected,
          extensionVersion: browser.extensionVersion || null,
          extensionNeedsReload: browser.connected && !browser.ready,
          taskRunning: runner.busy,
          version: '0.4.1',
          jevEnabled: jev.enabled,
        });
      if (request.method === 'GET' && pathname === '/settings')
        return reply(200, settings.publicView());
      if (request.method === 'GET' && pathname === '/skills')
        return reply(200, { skills: await skills.list() });
      if (request.method === 'GET' && pathname.startsWith('/skills/'))
        return reply(200, await skills.read(pathname.slice('/skills/'.length)));
      if (request.method === 'GET' && pathname === '/workspace') {
        const sessionId = requestUrl.searchParams.get('sessionId') || undefined;
        const taskId = requestUrl.searchParams.get('taskId') || undefined;
        const revision = requestUrl.searchParams.get('revision') ?? undefined;
        if (revision !== undefined)
          z.string()
            .regex(/^\d{1,12}$/)
            .parse(revision);
        return reply(200, {
          sessions: store.list(),
          conversation: sessionId ? store.view(sessionId, revision) : null,
          ...(taskId ? { task: runner.get(taskId) } : {}),
          ...(requestUrl.searchParams.get('memory') === 'true'
            ? { memory: store.facts(sessionId) }
            : {}),
        });
      }
      if (pathname === '/sessions') {
        if (request.method === 'GET') return reply(200, { sessions: store.list() });
        if (request.method === 'POST') {
          const { title } = z
            .object({ title: z.string().min(1).max(200).default('New conversation') })
            .strict()
            .parse(await readJson(request, 2000));
          return reply(201, await store.create(title));
        }
      }
      if (pathname.startsWith('/sessions/')) {
        const id = z.string().uuid().parse(pathname.slice('/sessions/'.length));
        if (request.method === 'GET') return reply(200, store.get(id));
        if (request.method === 'DELETE') {
          if (runner.busy)
            return reply(409, { error: 'Finish or stop the task before deleting a conversation.' });
          return reply(200, await store.remove(id));
        }
      }
      if (pathname === '/memory') {
        const sessionId = requestUrl.searchParams.get('sessionId') || undefined;
        if (request.method === 'GET') return reply(200, store.facts(sessionId));
        if (request.method === 'POST') {
          const fact = z
            .object({ text: z.string().min(1).max(4000), sessionId: z.string().uuid().optional() })
            .strict()
            .parse(await readJson(request, 18000));
          return reply(201, await store.saveFact(fact.text, fact.sessionId));
        }
      }
      if (request.method === 'DELETE' && pathname.startsWith('/memory/'))
        return reply(
          200,
          await store.forgetFact(
            pathname.slice('/memory/'.length),
            requestUrl.searchParams.get('sessionId') || undefined,
          ),
        );
      if (request.method === 'PUT' && pathname === '/settings') {
        if (runner.busy || externalBusy || settingsBusy)
          return reply(409, { error: 'Bridge is busy' });
        settingsBusy = true;
        try {
          const result = await settings.save(await readJson(request, 16000));
          jev = new JevClient(config.jev, settings.key(config.jev.apiKeyEnv, 'jev'));
          runner.jev = jev;
          return reply(200, result);
        } finally {
          settingsBusy = false;
        }
      }
      if (request.method === 'POST' && pathname === '/command') {
        if (runner.busy || externalBusy || settingsBusy)
          return reply(409, { error: 'BROWSER_BUSY: An agent or another client has control.' });
        externalBusy = true;
        try {
          return reply(200, { result: await browser.command(await readJson(request)) });
        } finally {
          externalBusy = false;
        }
      }
      if (request.method === 'POST' && pathname === '/locate') {
        if (runner.busy || externalBusy || settingsBusy)
          return reply(409, { error: 'BROWSER_BUSY' });
        externalBusy = true;
        const controller = new AbortController();
        const disconnected = () => {
          if (!response.writableEnded) controller.abort(new Error('CLIENT_DISCONNECTED'));
        };
        request.once('aborted', disconnected);
        response.once('close', disconnected);
        try {
          const args = locateInput.parse(await readJson(request));
          const snapshot = await browser.command(
            {
              name: 'browser_snapshot',
              args: { tabId: args.tabId, frameId: args.frameId, includeContext: true },
            },
            { signal: controller.signal },
          );
          return reply(200, { result: await jev.locate(args.target, snapshot, controller.signal) });
        } finally {
          request.off('aborted', disconnected);
          response.off('close', disconnected);
          externalBusy = false;
        }
      }
      if (request.method === 'POST' && pathname === '/tasks') {
        if (externalBusy || settingsBusy) return reply(409, { error: 'BROWSER_BUSY' });
        return reply(202, await runner.start(taskInput.parse(await readJson(request, 52000))));
      }
      if (request.method === 'POST' && pathname === '/fast-tasks') {
        if (externalBusy || settingsBusy) return reply(409, { error: 'BROWSER_BUSY' });
        const fast = fastInput.parse(await readJson(request, 52000));
        return reply(
          202,
          await runner.start({
            goal: fast.goal,
            tabId: fast.tabId,
            sessionId: fast.sessionId,
            fast,
          }),
        );
      }
      if (pathname.startsWith('/tasks/')) {
        if (pathname.endsWith('/message') && request.method === 'POST') {
          const id = z.string().uuid().parse(pathname.split('/')[2]);
          const { text } = z
            .object({ text: z.string().min(1).max(12000) })
            .strict()
            .parse(await readJson(request, 52000));
          return reply(200, await runner.message(id, text));
        }
        const id = pathname.slice('/tasks/'.length);
        if (request.method === 'GET') return reply(200, runner.get(id));
        if (request.method === 'DELETE') return reply(200, runner.cancel(id));
      }
      reply(404, { error: 'Not found' });
    } catch (error) {
      reply(400, {
        error:
          error instanceof z.ZodError
            ? `Invalid input: ${error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`
            : error.message,
        ...(error.mutationOutcome === 'not_dispatched'
          ? { mutationOutcome: 'not_dispatched' }
          : {}),
      });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    if (
      request.url !== '/extension' ||
      !validHost(request.headers.host, config.port) ||
      !extensionOrigin(request.headers.origin)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let authenticated = false;
      const timeout = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
      const authenticate = (bytes) => {
        if (authenticated) return;
        let message;
        try {
          message = JSON.parse(bytes.toString());
        } catch {
          ws.close(1008, 'Invalid authentication');
          return;
        }
        if (
          message.type !== 'auth' ||
          !tokenMatches(message.token, config.token) ||
          request.headers.origin !== `chrome-extension://${message.extensionId}` ||
          (config.extensionId && config.extensionId !== message.extensionId)
        ) {
          ws.close(1008, 'Authentication failed');
          return;
        }
        try {
          const protocol = z
            .number()
            .int()
            .min(1)
            .max(BROWSER_PROTOCOL)
            .parse(message.protocol ?? 1);
          const version =
            message.version === undefined
              ? undefined
              : z
                  .string()
                  .regex(/^\d+\.\d+\.\d+$/)
                  .parse(message.version);
          browser.attach(ws, { protocol, version });
          authenticated = true;
          extensionId = message.extensionId;
          clearTimeout(timeout);
          ws.off('message', authenticate);
          ws.send(JSON.stringify({ type: 'ready' }));
        } catch (error) {
          ws.close(1008, error.message.slice(0, 100));
        }
      };
      ws.on('message', authenticate);
      ws.on('error', () => {});
      ws.on('close', () => clearTimeout(timeout));
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients)
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
  }, 20000);
  heartbeat.unref();
  server.requestTimeout = 25000;
  server.headersTimeout = 5000;
  return {
    server,
    browser,
    runner,
    store,
    skills,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', resolve);
      }),
    close: async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
