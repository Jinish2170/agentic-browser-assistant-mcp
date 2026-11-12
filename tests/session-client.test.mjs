import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server/bridge.mjs';
import { Settings } from '../server/settings.mjs';
import { defaults, root } from '../server/config.mjs';

test('persistent CLI retains piped startup requests, correlates errors and exits cleanly on EOF', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'jev-session-test-'));
  const configFile = path.join(temporary, 'config.json');
  const config = {
    ...structuredClone(defaults),
    port: 0,
    token: 'fixture-session-token-'.repeat(3),
  };
  let bridge, child;
  try {
    bridge = await createBridge(config, {
      settings: new Settings(config, path.join(temporary, 'secrets.json'), configFile),
    });
    await bridge.listen();
    config.port = bridge.server.address().port;
    await writeFile(configFile, JSON.stringify(config));
    child = spawn(process.execPath, [path.join(root, 'scripts/session.mjs')], {
      env: { ...process.env, JEV_CONFIG: configFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => (stdout += bytes));
    child.stderr.on('data', (bytes) => (stderr += bytes));
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Session did not exit'));
      }, 8000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    // Input arrives before the MCP handshake; nothing may be dropped.
    child.stdin.end(
      [
        JSON.stringify({ id: 'first', name: 'browser_status', arguments: {} }),
        '{invalid json',
        JSON.stringify({ id: 'last', name: 'browser_status', arguments: {} }),
      ].join('\n') + '\n',
    );
    assert.equal(await completion, 0, stderr);
    const output = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(output.length, 3);
    assert.equal(output[0].id, 'first');
    assert.equal(output[0].ok, true);
    assert.equal(output[1].ok, false);
    assert.equal(output[2].id, 'last');
    assert.equal(output[2].ok, true);
    assert.equal(output[0].result.connected, false);
    assert(!stdout.includes(config.token));
  } finally {
    child?.kill();
    await bridge?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
