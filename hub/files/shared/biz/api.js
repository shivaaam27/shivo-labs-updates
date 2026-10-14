// Shivo Labs Business: the one client for the server API (business/FRAME.md). Every screen talks to the
// server through this file, so errors read the same everywhere. Writes carry `x-hub: 1` (the hub refuses
// changes without it, so other web pages cannot reach it).
const BASE = '/api/business';
const TIMEOUT = 15000;

/** An error a person can read. `status` is the HTTP code; `errors` = {field: message} (422); `usedIn` (409). */
export class ApiError extends Error {
  constructor(message, { status = 0, errors = null, usedIn = null, body = null } = {}) {
    super(message);
    Object.assign(this, { status, errors, usedIn, body });
  }
}

const PLAIN = {
  0: "Can't reach the Business server. Is the Shivo Labs hub running?",
  400: 'The server did not understand that request.',
  401: 'Please switch to a user first.',
  403: "Your role isn't allowed to do that.",
  404: "That record doesn't exist (any more).",
  409: "It can't be removed: it is still used.",
  413: 'That is too big to send in one go.',
  422: 'Some fields need a look.',
  500: 'Something went wrong on the server.',
};

async function call(method, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  let res, data = null;
  try {
    res = await fetch(BASE + path, {
      method,
      signal: ctl.signal,
      headers: method === 'GET' ? {} : { 'x-hub': '1', 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch (e) {
    clearTimeout(timer);
    throw new ApiError(e.name === 'AbortError' ? 'The server took too long to answer. Try again.' : PLAIN[0]);
  }
  clearTimeout(timer);
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.ok) return data;
  if (res.status === 401 && data?.needsPin) api.onNeedPin?.(); // nobody is switched in (e.g. the hub restarted): ask for a PIN
  const msg = (data && (data.message || data.error)) || PLAIN[res.status] || PLAIN[500];
  throw new ApiError(String(msg), { status: res.status, errors: data?.errors || null, usedIn: data?.usedIn || null, body: data });
}

const qs = (o = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};
const seg = encodeURIComponent;

export const api = {
  /** Set by the shell: called when the server needs someone to enter their PIN. */
  onNeedPin: null,
  session: () => call('GET', '/session'),
  switchUser: (pin) => call('POST', '/session', { pin }),
  meta: () => call('GET', '/meta'),
  /** list(type, {q, sort, dir, limit, offset, filters:{field:value}}) → {rows, total} */
  list(type, { filters = {}, ...o } = {}) {
    const f = {};
    for (const [k, v] of Object.entries(filters)) f['f.' + k] = v;
    return call('GET', `/list/${seg(type)}${qs({ ...o, ...f })}`);
  },
  doc: (type, id) => call('GET', `/doc/${seg(type)}/${seg(id)}`),
  save: (type, doc) => call('POST', `/doc/${seg(type)}`, { doc }),
  remove: (type, id) => call('POST', `/delete/${seg(type)}/${seg(id)}`, {}),
  /** options(type, q, filters) → [{id, title, subtitle}] (max 20); filters = a link field's `filter`. */
  options(type, q = '', filters = {}) {
    const f = {};
    for (const [k, v] of Object.entries(filters || {})) f['f.' + k] = typeof v === 'boolean' ? (v ? '1' : '0') : v;
    return call('GET', `/options/${seg(type)}${qs({ q, ...f })}`);
  },
  search: (q) => call('GET', `/search${qs({ q })}`),
  importCsv: (type, csv, commit) => call('POST', `/import/${seg(type)}`, { csv, commit: !!commit }),
  setup: (body) => call('POST', '/setup', body),
  /** Set a PIN: your own (current PIN needed unless owner) or, as owner, anyone's. */
  setPin: (user, pin, current) => call('POST', '/pin', { user, pin, current }),
  steps: (limit) => call('GET', `/steps${qs({ limit })}`),
  addStep: (step) => call('POST', '/steps', { step }),
  // a movement can be undone once, so its undo has a fixed id: a retry after a timeout returns the same undo
  undoStep: (id) => call('POST', '/steps/undo', { id, client_id: `undo-${id}` }),
  run: (body = {}) => call('POST', '/run', body),
  /** Totals of a sale or bill being typed (nothing saved). */
  preview: (step) => call('POST', '/preview', { step }),
  /** The books per account: no id = trial balance {accounts, debit, credit, unset}; an account id = its entries. */
  books: (account) => call('GET', account ? `/books/${seg(account)}` : '/books'),
  /** The price of a product for a customer (side 'sell') or supplier ('buy') on a date: {price: {rate, price_list} | null}. */
  price: (item, party, side, date, qty, till) => call('GET', `/price${qs({ item, party, side, date, qty, till })}`),
  /** Open till shifts with what they took so far ({shifts}); expected amounts are left out for a blind count. */
  shifts: () => call('GET', '/shifts'),
  /** The till screen's start: {tills (full settings), products (codes, barcodes), methods}. */
  tillStart: () => call('GET', '/till'),
  /** Everything a document's printed page shows (print.js lays it out). */
  print: (id) => call('GET', `/print/${seg(id)}`),
};

/** Normalise the different shapes a list of definitions may come in to {type: def}. */
export function defsByType(meta) {
  const arr = Array.isArray(meta) ? meta : meta?.defs || meta?.types || meta?.docs || (meta && typeof meta === 'object' ? Object.values(meta) : []);
  const out = {};
  for (const d of Array.isArray(arr) ? arr : Object.values(arr)) if (d && d.type) out[d.type] = d;
  return out;
}

/** A record as a flat object (the server may keep the fields in `data`). */
export function flatDoc(d) {
  if (!d) return d;
  if (d.data && typeof d.data === 'object' && !Array.isArray(d.data)) return { ...d.data, ...d, data: undefined };
  return d;
}
