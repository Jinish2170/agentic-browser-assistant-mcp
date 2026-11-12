import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { configPath, agentSchema } from './config.mjs';
import { safeEndpoint } from './security.mjs';

const settingsSchema = z
  .object({
    agent: agentSchema.optional(),
    provider: z
      .object({
        kind: z.enum(['responses', 'anthropic', 'chat']),
        baseUrl: z.string().url(),
        model: z.string().max(200),
        apiKey: z.string().max(2000).optional(),
        advancedTools: z.boolean().default(false),
        nativeCompaction: z.boolean().default(false),
        toolProfile: z.enum(['auto', 'full']).default('auto'),
      })
      .strict(),
    jev: z
      .object({
        enabled: z.boolean(),
        endpoint: z.string().url(),
        model: z.string().min(1).max(200),
        confidenceThreshold: z.number().min(0.5).max(1),
        apiKey: z.string().max(2000).optional(),
      })
      .strict(),
  })
  .strict();

export class Settings {
  constructor(
    config,
    secretsPath = path.join(path.dirname(configPath), 'secrets.json'),
    configFile = configPath,
  ) {
    this.config = config;
    this.secretsPath = secretsPath;
    this.configFile = configFile;
    this.secrets = {};
    this.environmentIdentities = { llm: this.identity('llm'), jev: this.identity('jev') };
  }

  identity(name) {
    return name === 'llm'
      ? JSON.stringify([this.config.provider.kind, safeEndpoint(this.config.provider.baseUrl)])
      : safeEndpoint(this.config.jev.endpoint);
  }

  async load() {
    try {
      const stored = JSON.parse(await readFile(this.secretsPath, 'utf8'));
      this.secrets = Object.fromEntries(
        ['llm', 'jev']
          .filter((name) => stored[name] !== undefined)
          .map((name) => [
            name,
            typeof stored[name] === 'string'
              ? { value: stored[name], identity: this.identity(name) }
              : stored[name],
          ]),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  key(env, name) {
    const local = this.secrets[name];
    const identity = this.identity(name);
    if (local?.identity === identity && typeof local.value === 'string' && local.value)
      return local.value;
    return this.environmentIdentities[name] === identity ? process.env[env] || '' : '';
  }

  publicView() {
    return {
      provider: {
        ...this.config.provider,
        apiKeyConfigured: !!this.key(this.config.provider.apiKeyEnv, 'llm'),
      },
      jev: { ...this.config.jev, apiKeyConfigured: !!this.key(this.config.jev.apiKeyEnv, 'jev') },
      agent: this.config.agent,
    };
  }

  async save(raw) {
    const parsed = settingsSchema.parse(raw);
    parsed.provider.baseUrl = safeEndpoint(parsed.provider.baseUrl);
    parsed.jev.endpoint = safeEndpoint(parsed.jev.endpoint);
    const { apiKey: llmKey, ...provider } = parsed.provider;
    const { apiKey: jevKey, ...jev } = parsed.jev;
    const secrets = { ...this.secrets };
    if (llmKey !== undefined)
      secrets.llm = { value: llmKey, identity: JSON.stringify([provider.kind, provider.baseUrl]) };
    if (jevKey !== undefined) secrets.jev = { value: jevKey, identity: jev.endpoint };
    const config = {
      ...this.config,
      provider: { ...this.config.provider, ...provider },
      jev: { ...this.config.jev, ...jev },
      ...(parsed.agent ? { agent: parsed.agent } : {}),
    };
    await writeFile(`${this.secretsPath}.tmp`, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    await rename(`${this.secretsPath}.tmp`, this.secretsPath);
    await writeFile(`${this.configFile}.tmp`, JSON.stringify(config, null, 2) + '\n', {
      mode: 0o600,
    });
    await rename(`${this.configFile}.tmp`, this.configFile);
    this.secrets = secrets;
    Object.assign(this.config, config);
    return this.publicView();
  }
}
