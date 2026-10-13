// Users, PINs and permissions. A PIN is never stored: only a salted scrypt hash (node:crypto).
// Roles come from the definitions (DocDef.roles); the owner may do everything.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { DocDef, Role } from '../core/meta/index.ts';
import { ROLES } from '../core/meta/index.ts';
import type { DB } from './db.ts';
import { fail } from './errors.ts';

export interface User { id: string; name: string; role: Role }
interface UserRow { id: string; name: string; role: string; active: number; pin_hash: string | null }

const N = 16384, R = 8, P = 1, LEN = 32;
const derive = (pin: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((ok, no) => scrypt(pin, salt, LEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? no(e) : ok(key))));

export function checkPinShape(pin: unknown): string {
  if (typeof pin !== 'string' && typeof pin !== 'number') fail(422, 'Enter a PIN', { errors: { pin: 'Required' } });
  const s = String(pin).trim();
  if (!/^\d{4,8}$/.test(s)) fail(422, 'The PIN must be 4 to 8 digits', { errors: { pin: 'The PIN must be 4 to 8 digits' } });
  return s;
}

/** 'scrypt$N$r$p$salt$hash' (base64). */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pin, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  try {
    const got = await derive(pin, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; } // a damaged hash never matches
}

const toUser = (r: UserRow): User => ({ id: r.id, name: r.name, role: (ROLES.includes(r.role as Role) ? r.role : 'cashier') as Role });

export function activeUser(db: DB, id: string | null): User | null {
  if (!id) return null;
  const r = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id) as UserRow | undefined;
  return r ? toUser(r) : null;
}

export function activeOwners(db: DB): User[] {
  return (db.prepare("SELECT * FROM users WHERE role = 'owner' AND active = 1").all() as unknown as UserRow[]).map(toUser);
}

export function activeUserCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get() as { n: number }).n;
}

export function hasPin(db: DB, id: string): boolean {
  return !!(db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(id) as { pin_hash: string | null } | undefined)?.pin_hash;
}

/** The active user with this PIN, or null. */
export async function findByPin(db: DB, pin: string): Promise<User | null> {
  const rows = db.prepare('SELECT * FROM users WHERE active = 1 AND pin_hash IS NOT NULL').all() as unknown as UserRow[];
  for (const r of rows) if (await verifyPin(pin, r.pin_hash)) return toUser(r);
  return null;
}

/** Hash a new PIN after checking no other user has it, active or not (a PIN must pick one person, also after
 *  someone is switched back on). Callers run PIN changes one at a time (api.ts oneAtATime). */
export async function newPinHash(db: DB, userId: string, pin: string): Promise<string> {
  const rows = db.prepare('SELECT * FROM users WHERE pin_hash IS NOT NULL AND id <> ?').all(userId) as unknown as UserRow[];
  for (const r of rows) {
    if (await verifyPin(pin, r.pin_hash)) fail(422, 'Someone else already uses this PIN; choose another', { errors: { pin: 'Choose another PIN' } });
  }
  return hashPin(pin);
}

export function storePin(db: DB, userId: string, hash: string): void {
  const r = db.prepare('UPDATE users SET pin_hash = ? WHERE id = ? AND active = 1').run(hash, userId);
  if (!r.changes) fail(404, 'That user does not exist or is not active');
}

export type Action = 'read' | 'write' | 'delete';
/** May this user do this to records of this definition? Child definitions follow their use inside parents. */
export function can(user: User | null, def: DocDef, action: Action): boolean {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return def.roles[action].includes(user.role);
}

export function allowedRoles(user: User | null, roles: Role[]): boolean {
  return !!user && (user.role === 'owner' || roles.includes(user.role));
}
