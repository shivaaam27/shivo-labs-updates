// The shape of a definition (business/FRAME.md). Every master and document is described once as a DocDef;
// the server (business/store) stores and checks any definition, the screen kit (shared/biz) draws any definition.
// Pure data: no functions, so the same definitions can be sent to the screens as JSON.

export type Role = 'owner' | 'manager' | 'cashier' | 'storekeeper' | 'salesman' | 'accountant';
export const ROLES: Role[] = ['owner', 'manager', 'cashier', 'storekeeper', 'salesman', 'accountant'];
/** Everyone (owner is always allowed anyway). */
export const ALL: Role[] = ROLES;

export type Module = 'products' | 'customers' | 'suppliers' | 'sell' | 'buy' | 'stock' | 'money' | 'setup';

export type FieldType =
  | 'text' | 'longtext' | 'number' | 'money' | 'percent' | 'check' | 'select' | 'date'
  | 'link' | 'table' | 'phone' | 'email' | 'tin';
export const FIELD_TYPES: FieldType[] = ['text', 'longtext', 'number', 'money', 'percent', 'check', 'select', 'date', 'link', 'table', 'phone', 'email', 'tin'];

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** true: no two records may share the value (for a field in a child table: across every parent's table too).
   *  'table': only inside one parent's table (child fields only), e.g. one row per unit. */
  unique?: true | 'table';
  /** Value used when a new record leaves the field empty. For a link: the target's name or title (resolved on save). */
  default?: string | number | boolean;
  help?: string;
  options?: string[];                  // select
  to?: string;                         // link: DocDef.type of the target
  /** link: only targets whose fields match, e.g. { is_group: false }. Applied to options and on save. */
  filter?: Record<string, string | number | boolean>;
  of?: string;                         // table: DocDef.type of a child definition
  min?: number;
  max?: number;
  /** number: whole numbers only. */
  integer?: true;
  readOnly?: true;
  hidden?: true;
  search?: true;                       // included in quick search
  /** Cannot be changed once the record has stock movements (e.g. a product's valuation method). */
  lockOnStock?: true;
  /** Not working yet: which phase brings it (the form says so next to the field). A field that only looks like it does
   *  something is never allowed: it either works, or says "soon" (meta.test.ts checks this). */
  soon?: string;
  /** Kept for people to read only (no rule uses it): why that is enough, e.g. "printed on invoices". */
  info?: string;
  /** Promised by a phase marked done but not working: what is missing. Listed in the coverage report as a gap to fix;
   *  the form says "Not working yet". */
  gap?: string;
}

export interface Section { label: string; fields: string[]; columns?: 1 | 2 | 3 }

export type Naming = { by: 'field'; field: string } | { by: 'series'; prefix: string; digits: number };

export interface DocDef {
  type: string;
  label: string;
  plural: string;
  module: Module;
  icon: string;                        // 24x24 stroke icon paths
  title: string;                       // field shown as the record's title (a link field shows the target's title)
  subtitle?: string;
  naming: Naming;
  fields: Field[];
  sections: Section[];
  list: { columns: string[]; sort: string; dir?: 'asc' | 'desc'; filters: string[] };
  related?: { type: string; by: string; label: string }[];
  roles: { read: Role[]; write: Role[]; delete: Role[] };
  single?: true;
  child?: true;
  /** One line shown on the list and empty states. */
  description?: string;
}
