import { setup, root } from '../server/config.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
await setup();
await mkdir('.local', { recursive: true });
await writeFile(
  '.local/mcp-config.json',
  JSON.stringify(
    {
      mcpServers: {
        'jev-browser': { command: process.execPath, args: [path.join(root, 'server/mcp.mjs')] },
      },
    },
    null,
    2,
  ) + '\n',
);
console.log('Generated .local/mcp-config.json for your MCP client.');
