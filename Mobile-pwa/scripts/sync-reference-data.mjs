/**
 * Refreshes the bundled copy of the client's reference tables.
 *
 * middle_ware/reference_data is the source of truth (api_contract.md section 8.1);
 * the copy under src/data is what Vite compiles into the app so an operator can
 * work offline before the server has ever answered. Run this after a supervisor
 * adds rows and the middleware repo is updated:
 *
 *     npm run sync:reference
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dest = resolve(here, '../src/data/reference_data');
const sources = [
  { dir: resolve(here, '../../middle_ware/reference_data'), files: null },
  { dir: resolve(here, '../../Dashboard/reference_data'), files: ['category.csv'] }
];

mkdirSync(dest, { recursive: true });

let copied = 0;
for (const { dir, files } of sources) {
  const names = files ?? readdirSync(dir).filter((f) => f.endsWith('.csv'));
  for (const name of names) {
    copyFileSync(join(dir, name), join(dest, name));
    console.log(`  ${name}`);
    copied += 1;
  }
}
console.log(`Synced ${copied} reference table(s) into src/data/reference_data.`);
