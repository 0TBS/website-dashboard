// The desk's database for tests: PGlite, which is Postgres itself running in
// the test process, behind the same connect() the Worker uses for Neon. One
// connection at a time, as a real one would be held: a call that starts
// while another holds it waits its turn, so two transactions never share it.

import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/schema.js';

export function pgliteConnector(db) {
  let queue = Promise.resolve();
  return () => new Promise((resolve) => {
    queue = queue.then(() => new Promise((release) => {
      resolve({ query: (text, params) => db.query(text, params), end: async () => release() });
    }));
  });
}

// → { db, connect }: a fresh, fully migrated database. `db` is the raw
// PGlite, for a test that needs to look underneath.
export async function freshDatabase() {
  const db = new PGlite();
  const connect = pgliteConnector(db);
  await migrate(connect);
  return { db, connect };
}
