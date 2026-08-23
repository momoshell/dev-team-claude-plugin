// Read-only ledger query helper. Usage: node q.mjs "<sql>" [--json]
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
const db = new DatabaseSync(join(homedir(), '.dev-team/factory/ledger.db'), { readOnly: true });
const sql = process.argv[2];
const rows = db.prepare(sql).all();
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else {
  if (!rows.length) { console.log('(0 rows)'); }
  else {
    const cols = Object.keys(rows[0]);
    console.log(cols.join(' | '));
    for (const r of rows) console.log(cols.map(c => String(r[c] ?? 'NULL')).join(' | '));
    console.log(`(${rows.length} rows)`);
  }
}
db.close();
