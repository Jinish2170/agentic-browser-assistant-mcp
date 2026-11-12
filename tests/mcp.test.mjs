import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcp } from '../server/mcp.mjs';

test('MCP publishes the bounded fast schema and returns failed task receipts as successful polls', async () => {
  const id = 'd391739c-13a6-4eaf-944b-7e1f3c6b6f63';
  const server = createMcp({ port: 1, token: 'fixture' }, async () =>
    Response.json({ id, status: 'failed', error: 'Provider HTTP 402' }),
  );
  const client = new Client({ name: 'fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const inventory = await client.listTools();
    assert.equal(inventory.tools.length, 50);
    const fast = inventory.tools.find((t) => t.name === 'browser_fast_run');
    assert.equal(fast.inputSchema.type, 'object');
    assert(fast.inputSchema.required.includes('success'));
    const result = await client.callTool({ name: 'browser_task', arguments: { id } });
    assert(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).status, 'failed');
  } finally {
    await client.close();
    await server.close();
  }
});
