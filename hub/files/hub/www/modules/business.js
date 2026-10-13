// Business: our own ERP (Shivo Labs Business). The screens are the shared kit in /shared/biz (also meant for the
// phone app later); this only mounts its shell inside the hub. Server side: hub/api/business.mjs → business/.
import { mountShell } from '/shared/biz/shell.js';

export function mountBusiness(root, { toast, goHome }) {
  return mountShell(root, { toast, goHome });
}
