import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../server/config.mjs';

const [name = 'browser_status', json = '{}'] = process.argv.slice(2);
const client = new Client({ name: 'jev-local-client', version: '0.4.1' });
try {
  let imageIndex = 0;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'server/mcp.mjs')],
      env: { ...process.env },
    }),
  );
  const result = await client.callTool({ name, arguments: JSON.parse(json) });
  for (const item of result.content) {
    if (item.type === 'text') console.log(item.text);
    if (item.type === 'image') {
      await mkdir(path.join(root, 'artifacts'), { recursive: true });
      const output = path.join(
        root,
        'artifacts',
        `mcp-screenshot-${Date.now()}-${imageIndex++}.${item.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
      );
      await writeFile(output, Buffer.from(item.data, 'base64'));
      console.log(`Screenshot saved: ${output}`);
    }
  }
  if (result.isError) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
