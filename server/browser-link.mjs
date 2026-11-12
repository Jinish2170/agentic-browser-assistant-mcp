import { BROWSER_PROTOCOL } from '../shared/protocol.mjs';
import { randomUUID } from 'node:crypto';
import { parseCommand, batchCommands } from '../shared/tools.mjs';
import { validateUploadFiles } from './security.mjs';

export class BrowserLink {
  #socket;
  #pending = new Map();
  #active = new Set();
  protocol = 0;
  extensionVersion;

  constructor(config) {
    this.config = config;
  }
  get connected() {
    return this.#socket?.readyState === 1;
  }

  get ready() {
    return this.connected && this.protocol === BROWSER_PROTOCOL;
  }

  attach(socket, { protocol = BROWSER_PROTOCOL, version } = {}) {
    if (this.connected)
      throw new Error(
        'A browser is already connected. Disconnect it before pairing another profile.',
      );
    this.#socket = socket;
    this.protocol = protocol;
    this.extensionVersion = version;
    socket.on('message', (bytes) => {
      let message;
      try {
        message = JSON.parse(bytes.toString());
      } catch {
        socket.close(1008, 'Invalid JSON');
        return;
      }
      if (message.type !== 'result') return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error)
        pending.reject(
          Object.assign(
            new Error(message.error),
            message.mutationOutcome === 'not_dispatched'
              ? { mutationOutcome: 'not_dispatched' }
              : {},
          ),
        );
      else pending.resolve(message.result);
    });
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.protocol = 0;
      this.extensionVersion = undefined;
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(
          new Error(
            'BROWSER_DISCONNECTED: Outcome may be unknown. Inspect before retrying any mutation.',
          ),
        );
      }
      this.#pending.clear();
    });
  }

  async command(rawCommand, { signal, timeoutMs = 20000 } = {}) {
    signal?.throwIfAborted();
    const command = parseCommand(rawCommand);
    if (this.connected && !this.ready)
      throw new Error(
        'EXTENSION_UPDATE_REQUIRED: Reload JEV Browser in chrome://extensions to use the updated bridge. No action was dispatched.',
      );
    if (command.name === 'browser_batch') {
      const commands = batchCommands(command.args);
      // Validate local file boundaries before any sibling action is dispatched.
      for (const child of commands)
        if (child.name === 'browser_upload')
          child.args.files = await validateUploadFiles(child.args.files, this.config.uploadRoots);
      const results = await Promise.allSettled(
        commands.map((child) => this.command(child, { signal, timeoutMs })),
      );
      return {
        results: results.map((entry, index) => ({
          name: commands[index].name,
          tabId: commands[index].args.tabId,
          ...(entry.status === 'fulfilled'
            ? { result: entry.value }
            : { error: entry.reason.message }),
        })),
      };
    }
    if (!this.connected)
      throw new Error('BROWSER_NOT_CONNECTED: Pair the extension in its side panel.');
    const key = command.args.tabId ?? 'global';
    if (this.#active.has(key))
      throw new Error('BROWSER_BUSY: Another command is in progress on this tab.');
    this.#active.add(key);
    try {
      if (command.name === 'browser_upload')
        command.args.files = await validateUploadFiles(command.args.files, this.config.uploadRoots);
      signal?.throwIfAborted();
      const id = randomUUID();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          // Closing the channel discards any queued work. Executed actions are never retried.
          this.#socket?.close(1008, 'Command timed out');
          reject(
            new Error(
              'COMMAND_TIMEOUT: Outcome may be unknown. Inspect the browser before retrying.',
            ),
          );
        }, timeoutMs);
        this.#pending.set(id, { resolve, reject, timer });
        this.#socket.send(
          JSON.stringify({ type: 'command', id, deadline: Date.now() + timeoutMs, command }),
          (error) => {
            if (!error) return;
            clearTimeout(timer);
            this.#pending.delete(id);
            reject(error);
          },
        );
      });
      signal?.throwIfAborted();
      return result;
    } finally {
      this.#active.delete(key);
    }
  }

  close() {
    this.#socket?.close(1001, 'Bridge stopped');
  }
}
