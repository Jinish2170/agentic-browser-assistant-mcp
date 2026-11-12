import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { safeEndpoint } from './security.mjs';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const configPath = process.env.JEV_CONFIG ?? path.join(root, '.local/config.json');
export const defaults = {
  port: 19847,
  provider: {
    kind: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    toolProfile: 'auto',
    apiKeyEnv: 'LLM_API_KEY',
  },
  jev: {
    enabled: false,
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    confidenceThreshold: 0.8,
  },
  agent: { maxSteps: 40, maxDurationMs: 600000, maxInputChars: 240000 },
  uploadRoots: [],
};
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
export const agentSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(2000),
    maxDurationMs: z.number().int().min(1000).max(43200000),
    maxInputChars: z.number().int().min(10000).max(2000000),
  })
  .strict();
const configSchema = z
  .object({
    port: z.number().int().min(1024).max(65535),
    token: z.string().min(32).max(256),
    extensionId: z
      .string()
      .regex(/^[a-p]{32}$/)
      .optional(),
    provider: z
      .object({
        kind: z.enum(['responses', 'anthropic', 'chat']),
        baseUrl: z.string().url(),
        model: z.string().max(200),
        apiKeyEnv: envName,
        advancedTools: z.boolean().optional(),
        nativeCompaction: z.boolean().optional(),
        toolProfile: z.enum(['auto', 'full']).default('auto'),
      })
      .strict(),
    jev: z
      .object({
        enabled: z.boolean(),
        endpoint: z.string().url(),
        model: z.string().min(1).max(200),
        apiKeyEnv: envName,
        confidenceThreshold: z.number().min(0.5).max(1),
      })
      .strict(),
    agent: agentSchema,
    uploadRoots: z.array(z.string().min(1)).max(20),
  })
  .strict();
export async function loadConfig() {
  const parsed = JSON.parse(await readFile(configPath, 'utf8'));
  const config = configSchema.parse({
    ...defaults,
    ...parsed,
    provider: { ...defaults.provider, ...parsed.provider },
    jev: { ...defaults.jev, ...parsed.jev },
    agent: { ...defaults.agent, ...parsed.agent },
  });
  config.provider.baseUrl = safeEndpoint(config.provider.baseUrl);
  config.jev.endpoint = safeEndpoint(config.jev.endpoint);
  return config;
}
export async function setup() {
  try {
    await readFile(configPath);
    console.log(`Existing config preserved: ${configPath}`);
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(configPath), 0o700);
  await writeFile(
    configPath,
    JSON.stringify({ ...defaults, token: randomBytes(32).toString('hex') }, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  console.log(`Created ${configPath}. Pairing token is in that file; it is never printed to logs.`);
}
