import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const idSchema = z.string().uuid();
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().max(20000),
  at: z.string(),
  taskId: idSchema.optional(),
});
const sessionSchema = z.object({
  id: idSchema,
  title: z.string().max(200),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(messageSchema),
  summary: z.string().max(16000).default(''),
  modelState: z.unknown().nullable().default(null),
  taskIds: z.array(idSchema).default([]),
  facts: z
    .array(z.object({ id: idSchema, text: z.string().max(4000), at: z.string() }))
    .default([]),
  compactions: z.number().int().nonnegative().default(0),
  revision: z.number().int().nonnegative().default(0),
});

export class SessionStore {
  #sessions = new Map();
  #tasks = new Map();
  #facts = [];
  #writes = Promise.resolve();
  #mutations = Promise.resolve();

  #mutate(operation) {
    const result = this.#mutations.catch(() => {}).then(operation);
    this.#mutations = result;
    return result;
  }

  constructor(directory) {
    this.directory = directory;
  }

  async #write(relative, value) {
    const output = path.join(this.directory, relative);
    const serialized = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(serialized) > 6 * 1024 * 1024)
      throw new Error(
        'MEMORY_LIMIT: Conversation checkpoint exceeded 6 MB; compact or start a new conversation.',
      );
    const operation = this.#writes
      .catch(() => {})
      .then(async () => {
        const temporary = `${output}.${randomUUID()}.tmp`;
        await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
        await rename(temporary, output);
      });
    this.#writes = operation;
    await operation;
  }

  async load() {
    await mkdir(path.join(this.directory, 'sessions'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.directory, 'tasks'), { recursive: true, mode: 0o700 });
    for (const entry of await readdir(path.join(this.directory, 'sessions'))) {
      if (!/^[0-9a-f-]{36}\.json$/.test(entry)) continue;
      const data = sessionSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, 'sessions', entry), 'utf8')),
      );
      this.#sessions.set(data.id, data);
    }
    for (const entry of await readdir(path.join(this.directory, 'tasks'))) {
      if (!/^[0-9a-f-]{36}\.json$/.test(entry)) continue;
      const task = JSON.parse(await readFile(path.join(this.directory, 'tasks', entry), 'utf8'));
      idSchema.parse(task.id);
      if (task.status === 'running') {
        task.status = 'interrupted';
        if (task.ledger?.inFlight) task.ledger.inFlight.state = 'unconfirmed';
        for (const action of task.ledger?.actions || [])
          if (action.state === 'dispatched') action.state = 'unconfirmed';
        task.error =
          'Bridge restarted. An earlier action may have an unknown outcome; inspect the browser before continuing.';
        task.finishedAt = new Date().toISOString();
        await this.saveTask(task);
      }
      this.#tasks.set(task.id, task);
    }
    try {
      this.#facts = z
        .array(z.object({ id: idSchema, text: z.string().max(4000), at: z.string() }))
        .parse(JSON.parse(await readFile(path.join(this.directory, 'facts.json'), 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  list() {
    return [...this.#sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, title, createdAt, updatedAt, messages, compactions }) => ({
        id,
        title,
        createdAt,
        updatedAt,
        messageCount: messages.length,
        compactions,
      }));
  }

  get(id, includeModelState = false) {
    idSchema.parse(id);
    const session = this.#sessions.get(id);
    if (!session) throw new Error('Conversation not found');
    const { modelState, ...publicState } = session;
    return structuredClone(includeModelState ? session : publicState);
  }

  view(id, revision) {
    idSchema.parse(id);
    const session = this.#sessions.get(id);
    if (!session) throw new Error('Conversation not found');
    const meta = {
      id,
      revision: session.revision,
      messageCount: session.messages.length,
      summary: session.summary,
      compactions: session.compactions,
    };
    if (revision !== undefined && Number(revision) === session.revision)
      return { ...meta, unchanged: true };
    return {
      ...meta,
      unchanged: false,
      messages: structuredClone(session.messages.slice(-50)),
      updatedAt: session.updatedAt,
      title: session.title,
    };
  }

  async create(title = 'New conversation') {
    return this.#mutate(async () => {
      if (this.#sessions.size >= 200)
        throw new Error('CONVERSATION_LIMIT: Export or delete old conversations first.');
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        title: title.slice(0, 200),
        createdAt: now,
        updatedAt: now,
        messages: [],
        summary: '',
        modelState: null,
        taskIds: [],
        facts: [],
        compactions: 0,
        revision: 0,
      };
      await this.#write(`sessions/${session.id}.json`, session);
      this.#sessions.set(session.id, session);
      return this.get(session.id);
    });
  }

  async update(id, mutate) {
    return this.#mutate(async () => {
      idSchema.parse(id);
      const session = this.#sessions.get(id);
      if (!session) throw new Error('Conversation not found');
      const next = structuredClone(session);
      mutate(next);
      next.updatedAt = new Date().toISOString();
      next.revision = (session.revision || 0) + 1;
      sessionSchema.parse(next);
      await this.#write(`sessions/${id}.json`, next);
      this.#sessions.set(id, next);
      return this.get(id);
    });
  }

  async remove(id) {
    return this.#mutate(async () => {
      const session = this.get(id, true);
      await this.#writes;
      await unlink(path.join(this.directory, 'sessions', `${id}.json`));
      this.#sessions.delete(id);
      for (const taskId of session.taskIds) {
        await unlink(path.join(this.directory, 'tasks', `${taskId}.json`)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        this.#tasks.delete(taskId);
      }
      return { removed: id };
    });
  }

  async saveTask(task) {
    idSchema.parse(task.id);
    await this.#write(`tasks/${task.id}.json`, task);
    this.#tasks.set(task.id, structuredClone(task));
  }

  task(id) {
    idSchema.parse(id);
    return this.#tasks.has(id) ? structuredClone(this.#tasks.get(id)) : undefined;
  }

  facts(sessionId) {
    return {
      reusable: structuredClone(this.#facts),
      conversation: sessionId ? this.get(sessionId).facts : [],
    };
  }

  async saveFact(text, sessionId) {
    z.string().min(1).max(4000).parse(text);
    const fact = { id: randomUUID(), text, at: new Date().toISOString() };
    if (sessionId) {
      await this.update(sessionId, (session) => {
        if (session.facts.length >= 100) throw new Error('Conversation fact limit reached');
        session.facts.push(fact);
      });
    } else {
      await this.#mutate(async () => {
        if (this.#facts.length >= 200) throw new Error('Reusable fact limit reached');
        const next = [...this.#facts, fact];
        await this.#write('facts.json', next);
        this.#facts = next;
      });
    }
    return fact;
  }

  async forgetFact(id, sessionId) {
    idSchema.parse(id);
    if (sessionId)
      await this.update(sessionId, (session) => {
        session.facts = session.facts.filter((fact) => fact.id !== id);
      });
    else {
      await this.#mutate(async () => {
        const next = this.#facts.filter((fact) => fact.id !== id);
        await this.#write('facts.json', next);
        this.#facts = next;
      });
    }
    return { forgotten: id };
  }
}
