// Test helper: a Business API on a temporary database file, removed afterwards.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from './api.ts';
import type { Api } from './api.ts';

export interface Kit {
  api: Api;
  get: (path: string, query?: Record<string, string>) => Promise<{ status: number; body: any }>;
  post: (path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  done: () => void;
}

export function makeKit(): Kit {
  const dir = mkdtempSync(join(tmpdir(), 'shivo-business-'));
  const api = createApi(join(dir, 'test.db'));
  const H = { 'x-hub': '1' };
  return {
    api,
    get: (path, query) => api.call({ method: 'GET', path: '/api/business/' + path, query, headers: H }) as Promise<{ status: number; body: any }>,
    post: (path, body = {}) => api.call({ method: 'POST', path: '/api/business/' + path, body, headers: H }) as Promise<{ status: number; body: any }>,
    done: () => { api.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A kit with the business already set up (owner Juma, PIN 1234). */
export async function readyKit(): Promise<Kit> {
  const k = makeKit();
  const r = await k.post('setup', { company: { name: 'Juma Traders', tin: '123456789' }, owner: { name: 'Juma', pin: '1234' } });
  if (r.status !== 200) throw new Error('setup failed: ' + JSON.stringify(r.body));
  return k;
}

/** Look a record up by title through the API (for ids in tests). */
export async function idOf(k: Kit, type: string, title: string): Promise<string> {
  const r = await k.get('options/' + type, { q: title });
  const hit = (r.body as { id: string; title: string }[]).find((x) => x.title === title);
  if (!hit) throw new Error(`${type} "${title}" not found`);
  return hit.id;
}
