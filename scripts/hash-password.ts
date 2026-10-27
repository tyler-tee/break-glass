import { hashPassword } from '../src/features/admin/auth.js';

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: npm run hash-password -- <password>');
  process.exit(1);
}
console.log(await hashPassword(pw));
