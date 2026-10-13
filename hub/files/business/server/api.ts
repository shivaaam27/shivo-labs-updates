// The Business API (business/FRAME.md "API"). One handler for every call under /api/business/.
// The hub (hub/api/business.mjs) reads the request, calls `call`, and writes the JSON reply; tests call it directly.
// Session: kept in memory per hub process (real login comes with Cloudflare).
import type { DocDef, Role } from '../core/meta/index.ts';
import { DEFS, getDef, STEP_ROLES } from '../core/meta/index.ts';
import type { DB } from '../store/db.ts';
import { openDb } from '../store/db.ts';
import { fail, HttpError } from '../store/errors.ts';
import type { Data } from '../store/docs.ts';
import { defOrFail, deleteDoc, getDoc, history, listDocs, loadSingle, optionsFor, saveDoc, searchAll } from '../store/docs.ts';
import { importCsv } from '../store/import.ts';
import { setupBusiness } from '../store/seed.ts';
import { addStep, computeStock, listSteps, previewMoney, undoStep } from '../store/steps.ts';
import type { User } from '../store/users.ts';
import { activeOwners, activeUser, activeUserCount, allowedRoles, can, checkPinShape, findByPin, hasPin, newPinHash, storePin, verifyPin } from '../store/users.ts';

export interface ApiRequest {
  method: string;
  path: string;                                   // e.g. /api/business/list/product
  query?: URLSearchParams | Record<string, string>;
  body?: unknown;
  headers?: Record<string, unknown>;
}
export interface ApiReply { status: number; body: unknown }

const MAX_TRIES = 5, LOCK_MS = 30_000;

export function createApi(file: string) {
  const db: DB = openDb(file);
  // userId: who switched in by PIN; switched: a PIN switch (or lock) happened, so no automatic owner any more
  const session = { userId: null as string | null, switched: false, fails: 0, lockedUntil: 0 };

  // After a hub restart nobody is signed in. Only a business with a single active user (the owner) skips the PIN;
  // with more people a PIN is needed, so restarting the hub can never turn a cashier into the owner.
  function currentUser(): User | null {
    if (session.switched) return activeUser(db, session.userId);
    const owners = activeOwners(db);
    return owners.length === 1 && activeUserCount(db) === 1 ? owners[0] : null;
  }
  // PIN changes are checked and stored one at a time (the uniqueness check waits on scrypt)
  let pinQueue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => { const p = pinQueue.then(fn, fn); pinQueue = p.catch(() => {}); return p; };

  async function call(req: ApiRequest): Promise<ApiReply> {
    try {
      return { status: 200, body: await route(req) };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...e.extra } };
      return { status: 500, body: { error: `Something went wrong: ${(e as Error)?.message ?? e}` } };
    }
  }

  async function route(req: ApiRequest): Promise<unknown> {
    const method = String(req.method || 'GET').toUpperCase();
    const rest = String(req.path || '').replace(/^\/api\/business\/?/, '');
    let parts: string[];
    try { parts = rest.split('/').filter(Boolean).map((s) => decodeURIComponent(s)); } catch { return fail(400, 'Bad address'); }
    const [head = '', a, b] = parts;
    const q = query(req.query);
    const body = (req.body ?? {}) as Data;
    if (method !== 'GET' && method !== 'POST') fail(405, 'Method not allowed');
    if (method === 'POST') {
      // only the hub's own page can add this header (the hub checks it too)
      if (req.headers?.['x-hub'] !== '1') fail(403, 'Forbidden');
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object');
    }
    const ready = !!loadSingle(db, 'company');
    const user = currentUser();
    const is = (m: string, h: string, n: number) => method === m && head === h && parts.length === n;

    // ---- open before setup and login ----
    if (is('GET', 'session', 1)) {
      const company = loadSingle(db, 'company');
      return { ready, user, company: company ? { name: company.title } : null, needsPin: ready && !user };
    }
    if (is('POST', 'session', 1)) return switchUser(body);
    if (is('POST', 'setup', 1)) {
      const owner = await setupBusiness(db, body);
      session.userId = owner; session.switched = true;
      return { ready: true, user: activeUser(db, owner) };
    }
    if (is('GET', 'meta', 1)) return meta(user, ready);

    if (!ready) fail(409, 'Set up the business first', { ready: false });
    if (!user) fail(401, 'Enter your PIN', { needsPin: true });
    const u = user!;

    if (is('GET', 'list', 2)) {
      const def = readable(u, a!);
      const filters: Record<string, string> = {};
      for (const [k, v] of Object.entries(q)) if (k.startsWith('f.')) filters[k.slice(2)] = v;
      return hideTitles(u, def, listDocs(db, def, { q: q.q, sort: q.sort, dir: q.dir, limit: Number(q.limit), offset: Number(q.offset), filters }));
    }
    if (method === 'GET' && head === 'doc' && (parts.length === 3 || (parts.length === 2 && getDef(a!)?.single))) {
      const def = readable(u, a!);
      const out = getDoc(db, def, b ?? '');
      if (def.type === 'user') (out.doc._meta as Data).hasPin = hasPin(db, out.doc.id as string);
      return hideTitles(u, def, out);
    }
    if (is('POST', 'doc', 2)) {
      const def = allowed(u, a!, 'write');
      const doc = body.doc;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail(400, 'Send the record as {doc: {...}}');
      return hideTitles(u, def, { doc: saveDoc(db, def, doc as Data, u.id) });
    }
    if (is('POST', 'delete', 3)) {
      const def = allowed(u, a!, 'delete');
      deleteDoc(db, def, b!, u.id);
      return { ok: true };
    }
    if (is('GET', 'options', 2)) {
      const def = readable(u, a!);
      const filters: Record<string, string> = {};
      for (const [k, v] of Object.entries(q)) if (k.startsWith('f.')) filters[k.slice(2)] = v;
      return optionsFor(db, def, q.q, filters);
    }
    if (is('GET', 'search', 1)) {
      const defs = DEFS.filter((d) => can(u, d, 'read'));
      return searchAll(db, defs, q.q ?? '', (d) => can(u, d, 'write'));
    }
    if (is('POST', 'import', 2)) {
      const def = allowed(u, a!, 'write');
      return importCsv(db, def, body.csv, body.commit === true, u.id);
    }
    if (is('POST', 'pin', 1)) return setPin(u, body);
    if (is('GET', 'log', 3)) {
      const def = readable(u, a!);
      getDoc(db, def, b!);   // 404 unless the record is of this type (and not deleted)
      return { history: history(db, b!) };
    }
    if (is('GET', 'steps', 1)) {
      needRoles(u, STEP_ROLES.read, 'see stock movements');
      return listSteps(db, q.limit, q.offset);
    }
    if (is('POST', 'steps', 1)) {
      needRoles(u, STEP_ROLES.write, 'record stock movements');
      return { step: addStep(db, body.step as Data, u.id) };
    }
    if (is('POST', 'preview', 1)) {
      needRoles(u, STEP_ROLES.write, 'record sales and bills');
      return previewMoney(db, body.step as Data);
    }
    if (is('POST', 'steps', 2) && a === 'undo') {
      needRoles(u, STEP_ROLES.undo, 'undo stock movements');
      return { step: undoStep(db, body.id, u.id, body.client_id) };
    }
    if (is('POST', 'run', 1)) {
      needRoles(u, STEP_ROLES.read, 'see stock');
      return computeStock(db);   // always from the stored movements; a scenario in the body is ignored
    }
    return fail(404, 'Not found');
  }

  // ---- helpers ----

  /** Names of linked records the user may not open are shown as "Hidden" (review 13 Oct 2026, item 6). */
  function hideTitles<T>(u: User, def: DocDef, out: T): T {
    const may = (field: { to?: string }) => { const t = field.to && getDef(field.to); return !t || can(u, t, 'read'); };
    const scrub = (d: DocDef, rec: Data) => {
      const t = rec?._titles as Record<string, string> | undefined;
      for (const f of d.fields) {
        if (f.type === 'link' && t && f.key in t && t[f.key] && !may(f)) t[f.key] = 'Hidden';
        if (f.type === 'table' && Array.isArray(rec?.[f.key])) for (const r of rec[f.key] as Data[]) scrub(getDef(f.of!)!, r);
      }
    };
    const o = out as unknown as Data;
    if (o?.doc) scrub(def, o.doc as Data);
    if (Array.isArray(o?.rows)) for (const r of o.rows as Data[]) scrub(def, r);
    return out;
  }

  function readable(u: User, type: string) { return allowed(u, type, 'read'); }
  function allowed(u: User, type: string, action: 'read' | 'write' | 'delete') {
    const def = defOrFail(type);
    // child tables are read and written through their parent
    if (def.child) fail(400, `${def.plural} only exist inside another record`);
    if (!can(u, def, action)) fail(403, `Your role (${u.role}) may not ${action === 'read' ? 'see' : action === 'write' ? 'change' : 'delete'} ${def.plural.toLowerCase()}`);
    return def;
  }
  function needRoles(u: User, roles: Role[], what: string) {
    if (!allowedRoles(u, roles)) fail(403, `Your role (${u.role}) may not ${what}`);
  }

  function meta(user: User | null, ready: boolean) {
    // before setup: only the company form (the setup screen draws it); after: what this user may read
    const top = ready ? DEFS.filter((d) => !d.child && can(user, d, 'read')) : DEFS.filter((d) => d.type === 'company');
    const childTypes = new Set(top.flatMap((d) => d.fields.filter((f) => f.type === 'table').map((f) => f.of!)));
    const defs = [...top, ...DEFS.filter((d) => d.child && childTypes.has(d.type))];
    return {
      ready,
      defs: defs.map((d) => ({ ...d, can: { read: can(user, d, 'read'), write: can(user, d, 'write'), delete: can(user, d, 'delete') } })),
      steps: { read: allowedRoles(user, STEP_ROLES.read), write: allowedRoles(user, STEP_ROLES.write), undo: allowedRoles(user, STEP_ROLES.undo) },
    };
  }

  async function switchUser(body: Data) {
    if (body.lock === true) { session.userId = null; session.switched = true; return { user: null }; }
    if (Date.now() < session.lockedUntil) fail(429, `Too many wrong PINs. Try again in ${Math.ceil((session.lockedUntil - Date.now()) / 1000)} seconds.`);
    const pin = checkPinShape(body.pin);
    // reserve this attempt now: scrypt is slow and asynchronous, so guesses sent together must still be counted
    session.fails++;
    if (session.fails > MAX_TRIES) {
      session.lockedUntil = Date.now() + LOCK_MS; session.fails = 0;
      fail(429, `Too many wrong PINs. Try again in ${LOCK_MS / 1000} seconds.`);
    }
    const found = await findByPin(db, pin);
    if (Date.now() < session.lockedUntil) fail(429, `Too many wrong PINs. Try again in ${Math.ceil((session.lockedUntil - Date.now()) / 1000)} seconds.`);
    if (!found) {
      if (session.fails >= MAX_TRIES) { session.lockedUntil = Date.now() + LOCK_MS; session.fails = 0; }
      fail(401, 'Wrong PIN');
    }
    session.fails = 0;
    session.userId = found!.id; session.switched = true;
    return { user: found };
  }

  function setPin(u: User, body: Data) { return oneAtATime(() => setPinNow(u, body)); }
  async function setPinNow(u: User, body: Data) {
    const target = typeof body.user === 'string' && body.user ? body.user : u.id;
    const self = target === u.id;
    if (!self && u.role !== 'owner') fail(403, 'Only the owner can set another person\'s PIN');
    const pin = checkPinShape(body.pin);
    if (self && hasPin(db, u.id)) {   // changing your own PIN (owner too) needs the current one
      const row = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(u.id) as { pin_hash: string | null };
      if (!(await verifyPin(String(body.current ?? ''), row.pin_hash))) fail(422, 'Your current PIN is not right', { errors: { current: 'Not right' } });
    }
    if (!activeUser(db, target)) fail(404, 'That user does not exist or is not active');
    const hash = await newPinHash(db, target, pin);
    storePin(db, target, hash);
    return { ok: true };
  }

  return { call, db, session, close: () => db.close() };
}

function query(q: ApiRequest['query']): Record<string, string> {
  if (!q) return {};
  if (q instanceof URLSearchParams) return Object.fromEntries(q.entries());
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)]));
}

export type Api = ReturnType<typeof createApi>;
