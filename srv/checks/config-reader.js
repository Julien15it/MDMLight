'use strict';

/**
 * Paged reads of the S/4 customizing the checks derive from.
 *
 * **Why this exists (2026-08-27).** `cvi-checks.js` and `derivation-checks.js` both read their
 * customizing with a bare `SELECT.from(entity)` and used the answer as if it were the whole table.
 * It is not: the remote V2 service pages, and the observed page size is **100 rows**. So every one
 * of those twelve reads silently returned its first page.
 *
 * How it presented, and why it took three rounds to find: the tables under 100 rows were complete
 * and correct, so most checks worked. `DerPartnerFunctionAccGrp` is keyed `(AccountGroup,
 * PartnerFunction)` and account group `0001` alone is 18 rows, so page one never reached `DEBI` --
 * a partner-function derivation with correct customizing, a valid payload and nothing proposed.
 * A truncated read looks exactly like customizing that says nothing, which is the whole reason
 * `derivation-checks.js` now logs its row counts.
 *
 * Two things here are deliberate:
 *
 * - **`skip` advances by what actually arrived**, never by `pageSize`. The server's page size is its
 *   own business: ask for 500, get 100, and the next read still starts at 100.
 * - **The loop ends on an EMPTY page, not a short one.** A short page is the obvious signal and it
 *   is wrong here: the read that produced this bug was short (100) precisely because the server
 *   capped it. It costs one extra round trip per table per cache period, which against a 60s cache
 *   is nothing.
 *
 * Paging with `$skip` assumes a stable order across requests. These are keyed CDS views and the
 * gateway serves them in key order, which is what makes it safe; nothing here sorts explicitly.
 */

const cds = require('@sap/cds');

// Comfortably above every one of these tables, so the common case is one read plus one empty one.
const PAGE_SIZE = 500;

// A backstop, not a limit anyone should reach: customizing tables are hundreds of rows. It exists
// so a service that ignores `$skip` cannot spin forever.
const MAX_ROWS = 20000;

async function readAll(service, entity, { pageSize = PAGE_SIZE, maxRows = MAX_ROWS } = {}) {
  const rows = [];
  for (;;) {
    const page = await service.run(cds.ql.SELECT.from(entity).limit(pageSize, rows.length));
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    if (rows.length >= maxRows) {
      console.warn(`[config-reader] ${entity} stopped at the ${maxRows} row safety cap`);
      break;
    }
  }
  return rows;
}

/** The same read for a list of entities, concurrently, in the order given. */
function readAllOf(service, entities, options) {
  return Promise.all(entities.map((entity) => readAll(service, entity, options)));
}

module.exports = { readAll, readAllOf, PAGE_SIZE, MAX_ROWS };
