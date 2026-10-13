# The frame (Phase 1) and masters (Phase 2): the contract

Shivam's rules (13 Oct 2026): **every module looks and works the same**; all ERPNext features, but **easy to reach**;
**local first** (Cloudflare later, by Shivam); **sweep for bugs while building**. See `pos/blueprint/05-system-map.md`.

## The idea: definitions + one kit
Every master and document is described once as a **definition** (`business/core/meta/`). One server layer stores
and checks any definition; one screen kit (`shared/biz/`) draws any definition as list, form and detail. Nothing is
hand-built per module, so everything looks and behaves the same, and a new master is a new definition.

## Definition shape (`business/core/meta/types.ts`)
```
DocDef {
  type: 'product'                    // id, snake_case
  label: 'Product', plural: 'Products'
  module: 'products' | 'customers' | 'suppliers' | 'sell' | 'buy' | 'stock' | 'money' | 'setup'
  icon: '<path …/>'                  // 24x24 stroke icon, same style as hub icons
  title: 'name'                      // field shown as the record's title
  subtitle?: 'code'
  naming: { by: 'field', field: 'code' } | { by: 'series', prefix: 'CUST-', digits: 5 }
  fields: Field[]
  sections: { label: string, fields: string[], columns?: 1|2|3 }[]   // form layout, in order
  list: { columns: string[], sort: string, dir?: 'asc'|'desc', filters: string[] }   // list view; sort may also be title|name|modified|created
  related?: { type: string, by: string, label: string }[]           // e.g. customer → its invoices (later phases)
  roles: { read: Role[], write: Role[], delete: Role[] }
  single?: true                      // one record only (company settings)
  child?: true                       // only lives inside a parent's table field
  description?: string               // one line for the list header / empty state
}
Field {
  key, label, type: 'text'|'longtext'|'number'|'money'|'percent'|'check'|'select'|'date'|'link'|'table'|'phone'|'email'|'tin'
  required?, default?, help?, options?: string[] (select), to?: DocDef.type (link), of?: DocDef.type (table, a child def)
  unique?: true | 'table'            // true: no two records share it (child field: across all parents too); 'table': once per table (child fields)
  filter?: {field: value}            // link: only targets matching, e.g. {is_group:false}; pass as f.<field>= to /options
  integer?: true                     // number: whole numbers only
  lockOnStock?: true                 // cannot change once the record has stock movements (product cost method, stock unit)
  min?, max?, readOnly?, hidden?, search?: true (included in quick search)
}
// A link field's default is the target's name (e.g. product.group default 'All Products'); resolved on save.
// Select values are stored as shown (e.g. 'Moving Average', 'Owner'); the users table keeps roles lowercase.
Role = 'owner' | 'manager' | 'cashier' | 'storekeeper' | 'salesman' | 'accountant'   // owner = everything
```

## Storage (`business/store/`, Node's built-in `node:sqlite`; same SQL works on Cloudflare D1 later)
- `docs(id TEXT PK, type, name, title, data JSON, search TEXT, created, modified, owner, modified_by, deleted INT)`
  with an index on (type, name) and (type, title). Child rows live inside the parent's JSON.
- `links(from_type, from_id, field, to_type, to_id)` kept on every save, so deletes can say "used in …".
- `log(id, type, doc_id, action, by, at, before JSON, after JSON)` (audit trail).
- `steps(seq, id 'ST-00001', kind, data JSON = contract Step with product ids as items and store ids as warehouses, created, by)`;
  stock movements run through the engine. Undo appends a `cancel` step; nothing is rewritten. Steps also write `links`
  (from_type `'step'`), so a product or store with movements cannot be deleted.
- `users(id, name, pin_hash, role, active)`: the login side of the `user` records (same id), kept in step on every save;
  PIN = salted scrypt hash, set only through `POST /pin`. `series(prefix, current)` for numbering; `meta_version` for migrations.
- File: `%APPDATA%\Shivo Labs\Business\business.db` for the real hub (port 4800); `business-test.db` for any other port.

## API (hub forwards `/api/business/*` to `business/server/api.ts`; JSON; writes need header `x-hub: 1`)
| Call | Does |
|---|---|
| `GET /api/business/session` | {ready, user:{id,name,role}\|null, company:{name}\|null, needsPin} |
| `POST /api/business/session` {pin} or {lock:true} | switch user by PIN (local; real login comes with Cloudflare) → {user}; 401 wrong PIN; 429 for 30 s after 5 wrong |
| `GET /api/business/meta` | {ready, defs:[DocDef + can:{read,write,delete}] (readable top-level defs + their child defs), steps:{read,write,undo}} |
| `GET /api/business/list/:type?q=&sort=&dir=&limit=&offset=&f.<field>=` | {rows:[{id,title,subtitle,_name,_modified,_titles,…list columns}], total}; limit 1–500 (default 50) |
| `GET /api/business/doc/:type/:id` | {doc, links:{type:count}}; single defs: `doc/company` |
| `POST /api/business/doc/:type` {doc} | create or update (id present = update; fields left out keep their value); returns {doc} or 422 {errors:{field:message}} |
| `POST /api/business/delete/:type/:id` | soft delete; refuses with 409 {usedIn:[{type,label,id,title,field}]} if linked |
| `GET /api/business/options/:type?q=&f.<field>=` | for link fields: [{id,title,subtitle}] (max 20; active records only) |
| `GET /api/business/search?q=` | Ctrl+K: [{kind:'action', action:'list'\|'new', type, title, subtitle} \| {kind:'record', type, id, title, subtitle}] |
| `POST /api/business/import/:type` {csv, commit:boolean} | {committed, columns:[{column,field,label}], rows:[{line,action:'create'\|'update',title,errors,values}], counts:{total,ok,failed,create,update,created,updated}} |
| `POST /api/business/setup` {company:{…}, owner:{name,pin,phone?}} | first-run setup: company, Tanzania template (VAT 18 %, units, payment methods, chart of accounts, a main store), owner → {ready,user}; field errors as `company.<field>` / `owner.<field>` |
| `POST /api/business/pin` {user?, pin, current?} | set a PIN (4–8 digits): own PIN (needs `current` if one is set, except the owner) or, owner only, anyone's |
| `GET /api/business/log/:type/:id` | {history:[{action,at,by,byName,changed:[field]}]} newest first |
| `GET /api/business/steps?limit=&offset=` | {steps:[Step + {label, created, by, undone, undoneBy}] newest first, total, titles:{id:title}} |
| `POST /api/business/steps` {step} | add a stock movement (Step without id; date/time default to now in Dar). Kept only if the engine accepts it, else 422 {error:'Not enough Rice 5kg in Main Store: 32 short'} → {step} |
| `POST /api/business/steps/undo` {id} | undo a movement (adds a cancel step; refused like any step) → {step} |
| `POST /api/business/preview` {step} | totals of a sale or bill being typed (VAT, discounts, rounding; nothing saved); for a sale also {credit:{owed, limit}} |
| `GET /api/business/books` | trial balance on real accounts {accounts:[{id,title,number,root_type,debit,credit,balance}], debit, credit, unset} (owner, manager, accountant) |
| `GET /api/business/books/:account` | one account's entries, oldest first, with the running balance |
| `GET /api/business/price?item=&party=&side=sell\|buy&date=` | {price:{rate, price_list} \| null}: the party's list, else its group's, else the company default; valid on the date |
| `POST /api/business/run` | no body: engine on the stored steps → Result + titles; with a full Scenario (the old demo): runs it, stores nothing |

**Records as the screens get them:** `{...fields, id, title, _name (its number or code, e.g. CUST-00001), _titles:{linkField: title},
_meta:{created, modified, owner, modified_by, hasPin (users only)}}`; child rows carry their own `_titles`. Send `_meta` back on
save: if someone saved in between, the reply is 409 {conflict:true}. Error keys for child rows: `<table>.<row index>.<field>`.
**Errors** are always JSON `{error: 'plain message', …}`: 400 bad request, 401 {needsPin} (PIN needed), 403 role may not,
404, 409 (in use / conflict / not set up {ready:false}), 422 {errors}. Before setup only session, meta and setup answer.
**Session:** in memory per hub process. After a hub start nobody is signed in: only a business whose single active
user is the owner skips the PIN; with more people the PIN screen comes first (a restart never turns anyone into the
owner). Changing your own PIN (owner too) needs the current one; PINs are unique across all users, and a user switched
off loses their PIN; PIN changes run one at a time; wrong-PIN attempts are counted before the slow check, so guesses
sent together still hit the 5-try lock. `/run` always works from the stored movements and needs a signed-in user.
**Stock movements:** a movement may carry `client_id` (the screen's id); the same id is saved once (a retry after a
timeout returns the first). Undo uses `undo-<movement id>`. A movement recorded while negative stock is allowed keeps
`negativeOk`, so switching the setting off applies from then on and never refuses or drops past movements.
Linked record names a role may not open come back as "Hidden".
**Who records what** (`STEP_ROLES.kinds`, like ERPNext's Stock / Sales / Purchase / Accounts users; the owner may do all):
stock movements manager + storekeeper; sales manager + cashier + salesman; returns manager + cashier; supplier bills
manager + accountant; payments manager + accountant + cashier; moving money and journals manager + accountant. Only
the owner or a manager may sell over a credit limit or write off more than 1,000 at the till; opening balances need the
owner, a manager or the accountant. `GET meta` gives `steps.kinds` so screens show only what the person may record.

## Masters in Phase 2
Setup: company (single), store/van, unit, payment method, tax (VAT), account (chart of accounts), user.
Products: product (units table: unit + factor; barcodes table; reorder table per store; prices are item_price), product group, brand, price list, item price.
Customers: customer, customer group. Suppliers: supplier, supplier group. People: salesman.

## Screen kit (`shared/biz/`, plain browser JS modules, uses `shared/tokens.css` and `shared/select.js`)
- **Shell**: left rail with the modules (Home, Sell, Buy, Stock, Money, Products, Customers, Suppliers, Reports, Setup),
  top bar with search (Ctrl+K), "+ New", user switch. Same everywhere.
- **List**: title + count, search, filter chips from `list.filters`, sortable columns, row click → detail, "+ New", import.
- **Form/detail**: one component; view mode shows values and a "Used in" panel from `links`; edit mode shows fields by
  section; Save / Cancel; errors shown next to fields; unsaved-changes guard.
- **Fields**: one widget per type; link = searchable dropdown (same look as `shared/select.js`); table = inline rows.
- Light and dark, sizes in rem with one size dial (`--ui-scale`), Swahili and English labels later via a dictionary.
