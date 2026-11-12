import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  tokenMatches,
  validHost,
  extensionOrigin,
  safeEndpoint,
  validateUploadFiles,
} from '../server/security.mjs';
import { parseCommand, assertGrant, originOf } from '../shared/tools.mjs';

test('strict inputs reject unknown tools, unknown fields and dangerous navigation schemes', () => {
  assert.throws(
    () =>
      parseCommand({
        name: 'browser_click',
        args: { tabId: 1, x: 10, y: 10, expected: { name: 'Save' } },
      }),
    /TARGET_GUARD_REQUIRES_REF/,
  );
  assert.throws(() => parseCommand({ name: '__proto__', args: {} }));
  assert.throws(() => parseCommand({ name: 'browser_click', args: { tabId: 1, execute: 'bad' } }));
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings'])
    assert.throws(() => parseCommand({ name: 'browser_navigate', args: { tabId: 1, url } }));
  assert.throws(() => originOf('https://user:pass@example.com'));
  assert.equal(parseCommand({ name: 'browser_snapshot', args: { tabId: 1 } }).args.frameId, 0);
});

test('origin grants enforce expiry, read-only and advanced access independently', () => {
  const grants = {
    'https://example.com': { mode: 'read', advanced: false, expiresAt: Date.now() + 1000 },
  };
  assertGrant(grants, 'https://example.com/path');
  assert.throws(() => assertGrant(grants, 'https://other.example.com'), /ACCESS_REQUIRED/);
  assert.throws(() => assertGrant(grants, 'https://example.com', true), /READ_ONLY/);
  grants['https://example.com'].mode = 'interact';
  assert.throws(
    () => assertGrant(grants, 'https://example.com', true, true),
    /ADVANCED_ACCESS_REQUIRED/,
  );
  grants['https://example.com'].advanced = true;
  assertGrant(grants, 'https://example.com', true, true);
  grants['https://example.com'].expiresAt = Date.now() - 1;
  assert.throws(() => assertGrant(grants, 'https://example.com'), /ACCESS_REQUIRED/);
});

test('all-website grants cover HTTP(S) while explicit blocks and narrower grants win', () => {
  const grants = { '*': { mode: 'interact', advanced: true, expiresAt: Date.now() + 10000 } };
  assertGrant(grants, 'https://new.example/path', true, true);
  assertGrant(grants, 'http://localhost:1234', true);
  assert.throws(() => assertGrant(grants, 'chrome://settings'), /HTTP/);
  grants['https://new.example'] = { mode: 'read', expiresAt: Date.now() + 10000 };
  assert.throws(() => assertGrant(grants, 'https://new.example', true), /READ_ONLY/);
  grants['https://blocked.example'] = { denied: true, expiresAt: Date.now() + 10000 };
  assert.throws(() => assertGrant(grants, 'https://blocked.example'), /blocked/);
  grants['*'].expiresAt = Date.now() - 1;
  assert.throws(() => assertGrant(grants, 'https://different.example'), /ACCESS_REQUIRED/);
});

test('download filenames reject absolute paths, traversal and empty paths', () => {
  for (const filename of ['/tmp/file', '../file', 'safe/../../file', '\\absolute', ''])
    assert.throws(() =>
      parseCommand({
        name: 'browser_download',
        args: { tabId: 1, operation: 'start', url: 'https://example.com/file', filename },
      }),
    );
  assert.equal(
    parseCommand({
      name: 'browser_download',
      args: {
        tabId: 1,
        operation: 'start',
        url: 'https://example.com/file',
        filename: 'reports/result.csv',
      },
    }).args.filename,
    'reports/result.csv',
  );
});

test('loopback Host, extension Origin and constant-time token checks', () => {
  assert.equal(validHost('127.0.0.1:19847', 19847), true);
  assert.equal(validHost('evil.test:19847', 19847), false);
  assert.equal(extensionOrigin(`chrome-extension://${'a'.repeat(32)}`), true);
  assert.equal(extensionOrigin('https://evil.test'), false);
  assert.equal(tokenMatches('secret', 'secret'), true);
  assert.equal(tokenMatches('secrets', 'secret'), false);
  assert.equal(tokenMatches(undefined, 'secret'), false);
});

test('provider keys cannot be sent over plain remote HTTP or redirect-style endpoints', () => {
  assert.equal(safeEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(safeEndpoint('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
  for (const value of [
    'http://api.example.com',
    'https://user:pass@example.com',
    'https://example.com?key=secret',
    'file:///tmp/model',
  ])
    assert.throws(() => safeEndpoint(value));
});

test('upload roots reject sibling paths and symlink escapes', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jev-roots-'));
  const allowed = path.join(temp, 'allowed');
  const sibling = path.join(temp, 'allowed-sibling');
  await mkdir(allowed);
  await mkdir(sibling);
  await writeFile(path.join(allowed, 'ok.txt'), 'ok');
  await writeFile(path.join(sibling, 'secret.txt'), 'secret');
  await symlink(path.join(sibling, 'secret.txt'), path.join(allowed, 'escape.txt'));
  assert.deepEqual(await validateUploadFiles([path.join(allowed, 'ok.txt')], [allowed]), [
    path.join(allowed, 'ok.txt'),
  ]);
  await assert.rejects(
    validateUploadFiles([path.join(sibling, 'secret.txt')], [allowed]),
    /OUTSIDE_ROOT/,
  );
  await assert.rejects(
    validateUploadFiles([path.join(allowed, 'escape.txt')], [allowed]),
    /OUTSIDE_ROOT/,
  );
  await assert.rejects(validateUploadFiles([path.join(allowed, 'ok.txt')], []), /ROOT_REQUIRED/);
});
