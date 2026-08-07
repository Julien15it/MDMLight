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
 * Lists what it would drop and stops. Pass --yes to actually drop.
 *
 * In CF, where the private endpoint routes, credentials come from the bound
 * instance and no tunnel is needed:
 *   cf run-task mdm-businesspartner-db-deployer --name wipe --command "..."
 *
 * Locally the endpoint is unreachable, so tunnel first and pass PG* vars:
 *   cf env mdm-businesspartner-srv          # read hostname / port / credentials
 *   cf ssh mdm-businesspartner-srv -L 15432:<hostname>:<port> -N &
 *   PGUSER=<user> PGPASSWORD=<pw> PGDATABASE=<db> node tools/wipe-staging.js
 */
// Hoisted in the CAP project, nested under the driver in the deployer droplet.
function loadPg() {
  try {
    return require('pg');
  } catch {
    return require('@cap-js/postgres/node_modules/pg');
  }
}

const { Client } = loadPg();

// In a CF container the bound instance is the only source of truth; locally it
// is a tunnel, so PG* env vars take over.
function bound() {
  if (!process.env.VCAP_SERVICES) return null;
  const services = JSON.parse(process.env.VCAP_SERVICES);
  const instance = (services['postgresql-db'] || [])[0];
  return instance ? instance.credentials : null;
}

const vcap = bound();
const config = vcap
  ? {
      host: vcap.hostname,
      port: Number(vcap.port),
      user: vcap.username,
      password: vcap.password,
      database: vcap.dbname,
      ssl: { rejectUnauthorized: false },
    }
  : {
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

  // `drop schema public cascade` needs schema ownership, which the bound BTP
  // role does not have. It does own the objects it created, so drop those.
  const views = await client.query(
    `select c.relname as name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')`
  );

  for (const v of views.rows) {
    await client.query(`drop view if exists "${v.name}" cascade`);
  }
  for (const r of rows) {
    await client.query(`drop table if exists "${r.table}" cascade`);
  }

  console.log(
    `\ndropped ${views.rows.length} views and ${rows.length} tables - redeploy to rebuild them`
  );
  await client.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
