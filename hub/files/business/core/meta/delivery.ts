// Deliveries by van (phase 4d, blueprint 03 §3.3): drivers, vehicles and routes (ERPNext Driver, Vehicle, Territory).
// Delivery trips themselves are steps (store/trips.ts). Pure data.
import type { DocDef } from './types.ts';
import { ALL } from './types.ts';

export const driver: DocDef = {
  type: 'driver', label: 'Driver', plural: 'Drivers', module: 'sell',
  icon: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 4v6M5 15l5-2M19 15l-5-2"/>',
  title: 'name', subtitle: 'phone',
  description: 'People who drive the delivery vans.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'phone', label: 'Phone', type: 'phone', search: true },
    { key: 'licence', label: 'Driving licence number', type: 'text', search: true },
    { key: 'licence_class', label: 'Licence class', type: 'text', help: 'E.g. C, C1, D.' },
    { key: 'licence_issued', label: 'Licence issued', type: 'date', info: 'Kept for the owner; the expiry date is what is checked' },
    { key: 'licence_expiry', label: 'Licence expires', type: 'date', help: 'A trip after this date is refused.' },
    { key: 'transporter', label: 'Transport company', type: 'link', to: 'supplier', help: 'When the driver works for a transport company you hire.' },
    { key: 'user', label: 'User', type: 'link', to: 'user', help: 'Their login, if they mark stops on their phone.' },
    { key: 'address', label: 'Address', type: 'longtext' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Driver', fields: ['name', 'phone', 'user', 'transporter', 'active'], columns: 2 },
    { label: 'Licence', fields: ['licence', 'licence_class', 'licence_issued', 'licence_expiry'], columns: 2 },
    { label: 'Address', fields: ['address'], columns: 1 },
  ],
  list: { columns: ['name', 'phone', 'licence', 'licence_expiry', 'active'], sort: 'name', filters: ['active'] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const vehicle: DocDef = {
  type: 'vehicle', label: 'Vehicle', plural: 'Vehicles', module: 'sell',
  icon: '<path d="M3 16V7h11v9M14 10h4l3 3v3h-7"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  title: 'plate', subtitle: 'model',
  description: 'Vans and lorries that deliver: number plate, its store (the van) and its usual driver.',
  naming: { by: 'field', field: 'plate' },
  fields: [
    { key: 'plate', label: 'Number plate', type: 'text', required: true, unique: true, search: true, help: 'E.g. T 123 ABC.' },
    { key: 'make', label: 'Make', type: 'text', help: 'E.g. Toyota.' },
    { key: 'model', label: 'Model', type: 'text', help: 'E.g. Dyna.' },
    { key: 'store', label: 'Its store (the van)', type: 'link', to: 'store', filter: { type: 'Van' }, help: 'Stock kept in the van, when it carries stock.' },
    { key: 'driver', label: 'Usual driver', type: 'link', to: 'driver', help: 'Fills in the driver on a new trip.' },
    { key: 'capacity', label: 'Carries up to (kg)', type: 'number', min: 0, info: 'Kept for the dispatcher; trips do not weigh the load' },
    { key: 'fuel', label: 'Fuel', type: 'select', options: ['Diesel', 'Petrol', 'Electric', 'Other'], default: 'Diesel', info: 'Kept for the owner' },
    { key: 'insurer', label: 'Insurance company', type: 'text', info: 'Kept for the owner' },
    { key: 'policy', label: 'Insurance policy number', type: 'text', info: 'Kept for the owner' },
    { key: 'insured_until', label: 'Insured until', type: 'date', help: 'A trip after this date is refused.' },
    { key: 'chassis', label: 'Chassis number', type: 'text', info: 'Kept for the owner' },
    { key: 'bought', label: 'Bought on', type: 'date', info: 'Kept for the owner; vehicles as fixed assets come after the pilot' },
    { key: 'odometer', label: 'Last odometer reading (km)', type: 'number', min: 0, integer: true, info: 'Kept for the owner' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [
    { label: 'Vehicle', fields: ['plate', 'make', 'model', 'store', 'driver', 'capacity', 'fuel', 'active'], columns: 2 },
    { label: 'Papers', fields: ['insurer', 'policy', 'insured_until', 'chassis', 'bought', 'odometer'], columns: 2 },
  ],
  list: { columns: ['plate', 'model', 'driver', 'store', 'active'], sort: 'plate', filters: ['active'] },
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};

export const route: DocDef = {
  type: 'route', label: 'Route', plural: 'Routes', module: 'customers',
  icon: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6"/>',
  title: 'name', subtitle: 'parent',
  description: 'Areas and delivery routes (Kariakoo, Mbezi, Arusha…), inside one another; customers belong to one.',
  naming: { by: 'field', field: 'name' },
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, unique: true, search: true },
    { key: 'parent', label: 'Inside', type: 'link', to: 'route', help: 'E.g. Kariakoo inside Dar es Salaam. Empty: a top area.' },
    { key: 'manager', label: 'Salesman in charge', type: 'link', to: 'salesman' },
    { key: 'active', label: 'Active', type: 'check', default: true },
  ],
  sections: [{ label: 'Route', fields: ['name', 'parent', 'manager', 'active'], columns: 2 }],
  list: { columns: ['name', 'parent', 'manager', 'active'], sort: 'name', filters: ['parent', 'active'] },
  related: [{ type: 'customer', by: 'route', label: 'Customers' }],
  roles: { read: ALL, write: ['manager'], delete: ['manager'] },
};
