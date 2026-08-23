import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os'; import { join } from 'node:path';
const F = join(homedir(), '.dev-team/factory');
const db = new DatabaseSync(join(F, 'ledger.db'), { readOnly: true });
const have = new Set(db.prepare(`select adw_id, created_at from review_outcomes`).all().map(r => r.adw_id + '|' + r.created_at));
const slug = new Map(db.prepare(`select adw_id, task_slug from sessions`).all().map(r => [r.adw_id, r.task_slug]));
const miss = [];
const rl = createInterface({ input: createReadStream(join(F, 'ledger.jsonl')), crlfDelay: Infinity });
for await (const l of rl) {
  if (!l.trim() || !l.includes('recordReviewOutcome')) continue;
  const o = JSON.parse(l); if (o.kind !== 'recordReviewOutcome') continue;
  const a = o.args; if (!have.has(a.adw_id + '|' + a.created_at)) miss.push(a);
}
console.log('JSONL review_outcomes rows absent from the DB:', miss.length);
for (const m of miss) console.log(` ${m.created_at} ${m.dispatch_id} ${m.verdict} mf=${m.must_fix} sf=${m.should_fix} consider=${m.consider} slug=${slug.get(m.adw_id) ?? '(no session row)'}`);
db.close();
