import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const skillId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

export class SkillLibrary {
  constructor(directory) {
    this.directory = directory;
  }

  async read(id) {
    skillId.parse(id);
    const root = await realpath(this.directory);
    const file = await realpath(path.join(root, id, 'SKILL.md'));
    if (!file.startsWith(root + path.sep))
      throw new Error('Skill is outside the configured library');
    const content = await readFile(file, 'utf8');
    if (content.length > 20000) throw new Error('Skill exceeds 20,000 characters');
    const title = /^#\s+(.+)$/m.exec(content)?.[1] || id;
    const description =
      content.split('\n').find((line) => line.trim() && !line.startsWith('#')) || '';
    return {
      id,
      title,
      description,
      content,
      trust: 'LOCAL_WORKFLOW_INSTRUCTIONS',
      note: 'This workflow cannot override permissions, user intent, or safety boundaries.',
    };
  }

  async list() {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries)
      if (entry.isDirectory() && skillId.safeParse(entry.name).success) {
        const { content, ...metadata } = await this.read(entry.name);
        result.push(metadata);
      }
    return result;
  }
}
