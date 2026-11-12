// One stdio MCP connection for an entire JSONL browser-control session.
// Each input line: {"id":1,"name":"browser_tabs","arguments":{}}
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { root } from '../server/config.mjs';

const input = z
  .object({
    id: z.union([z.string().max(100), z.number().finite()]),
    name: z.string().min(1).max(100),
    arguments: z.record(z.unknown()).default({}),
  })
  .strict();
const client = new Client({ name: 'jev-persistent-session', version: '0.4.1' });
let lines;
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'server/mcp.mjs')],
      env: { ...process.env },
    }),
  );
  lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  process.stderr.write('JEV MCP session ready. Send one JSON tool request per line.\n');
  for await (const line of lines) {
    if (!line.trim()) continue;
    const began = performance.now();
    let id = null;
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Input exceeds 1 MiB');
      const request = input.parse(JSON.parse(line));
      id = request.id;
      const result = await client.callTool({ name: request.name, arguments: request.arguments });
      const values = [],
        images = [];
      for (const item of result.content) {
        if (item.type === 'text') {
          try {
            values.push(JSON.parse(item.text));
          } catch {
            values.push(item.text);
          }
        }
        if (item.type === 'image') {
          await mkdir(path.join(root, 'artifacts'), { recursive: true });
          const file = path.join(
            root,
            'artifacts',
            `session-image-${Date.now()}-${images.length}.${item.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
          );
          await writeFile(file, Buffer.from(item.data, 'base64'));
          images.push(file);
        }
      }
      process.stdout.write(
        JSON.stringify({
          id,
          ok: !result.isError,
          result: values.length === 1 ? values[0] : values,
          images,
          elapsedMs: +(performance.now() - began).toFixed(2),
        }) + '\n',
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          id,
          ok: false,
          error: error.message,
          elapsedMs: +(performance.now() - began).toFixed(2),
        }) + '\n',
      );
    }
  }
} finally {
  lines?.close();
  await client.close();
}
