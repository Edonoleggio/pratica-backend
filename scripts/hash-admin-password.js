// Genera il valore da mettere nella env var ADMIN_PASSWORD_HASH su Render.
// Uso:  node scripts/hash-admin-password.js "LaMiaPasswordAdmin"
import { hashAdminPassword } from '../src/admin-auth.js';

const pwd = process.argv[2];
if (!pwd) {
  console.error('Uso: node scripts/hash-admin-password.js "<password>"');
  process.exit(1);
}
console.log(hashAdminPassword(pwd));
