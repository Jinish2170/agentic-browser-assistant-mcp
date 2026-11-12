import { timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validHost(host, port) {
  return host === `127.0.0.1:${port}`;
}

export function extensionOrigin(origin) {
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

export function safeEndpoint(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
  ) {
    throw new Error(
      'Provider endpoint must use HTTPS, or HTTP on loopback, without credentials/query/fragment',
    );
  }
  return url.toString().replace(/\/$/, '');
}

export async function validateUploadFiles(files, roots) {
  if (!roots?.length)
    throw new Error('UPLOAD_ROOT_REQUIRED: Configure uploadRoots in .local/config.json first');
  const allowed = await Promise.all(roots.map((root) => realpath(root)));
  return Promise.all(
    files.map(async (file) => {
      const canonical = await realpath(file);
      if (
        !allowed.some((root) => {
          const relative = path.relative(root, canonical);
          return (
            relative !== '' &&
            !relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative)
          );
        })
      )
        throw new Error('UPLOAD_OUTSIDE_ROOT: File is outside configured uploadRoots');
      if (!(await stat(canonical)).isFile()) throw new Error('Upload path must be a regular file');
      return canonical;
    }),
  );
}

export async function readJson(request, maxBytes = 1048576) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
