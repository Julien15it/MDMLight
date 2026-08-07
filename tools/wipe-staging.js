/**
 * Drops and recreates the `public` schema so the next cds-deploy runs as a
 * fresh full deploy instead of a delta.
 *
 * CAP refuses to drop elements during schema evolution, so any change that
 * removes a column ("Dropping elements is not supported") blocks the deployer
 * permanently. It also computes the delta against the model it stored in the
 * database, so dropping the columns by hand is not enough - that record has to
 * go with them, which is why this wipes the whole schema.
 *
 * Only safe while staging holds nothing worth keeping. Once real change
 * requests live here, write a migration instead.
 *
 * Usage - the BTP Postgres endpoint is private, so tunnel first:
 *   cf env mdm-businesspartner-srv          # read hostname / port / credentials
 *   cf ssh mdm-businesspartner-srv -L 15432:<hostname>:<port> -N &
 *   PGUSER=<user> PGPASSWORD=<pw> PGDATABASE=<db> node tools/wipe-staging.js
 *
 * Lists what it would drop and stops. Pass --yes to actually drop.
 */
const { Client } = require('pg');

const config = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 15432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
};

async function main() {
  const confirmed = process.argv.includes('--yes');
  const client = new Client(config);
  await client.connect();

  const { rows } = await client.query(
    `select c.relname as table,
            coalesce(s.n_live_tup, 0) as rows
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`
  );

  if (!rows.length) {
    console.log('schema public is already empty - nothing to drop');
    await client.end();
    return;
  }

  console.log(`${rows.length} tables in schema public:`);
  for (const r of rows) console.log(`  ${r.table} (~${r.rows} rows)`);

  if (!confirmed) {
    console.log('\ndry run - nothing dropped. Re-run with --yes to drop them.');
    await client.end();
    return;
  }

  const populated = rows.filter((r) => Number(r.rows) > 0);
  if (populated.length) {
    console.log(`\nWARNING: ${populated.length} table(s) report rows. Dropping anyway.`);
  }

  await client.query('drop schema public cascade');
  await client.query('create schema public');
  console.log('\ndropped and recreated schema public - redeploy to rebuild the tables');
  await client.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
