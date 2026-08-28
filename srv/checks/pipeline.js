'use strict';

/**
 * **validate -> derive -> duplicate check**, and the order is the design. Data that fails validation
 * cannot be a duplicate of anything; data that is merely incomplete may be missing the very fields a
 * duplicate rule needs, so derivation runs first. Stages run over the request payload
 * (`{ root, sections }`), not a flattened candidate, so a derivation can name a row and be written back.
 */

// { name, async run(payload) -> [{ check, severity, message, target?, field? }] }.
// `severity: 'error'` stops the pipeline; 'warning' and 'info' do not.
const VALIDATIONS = [];

// { name, async run(payload) -> [{ target, index, field, value, message, label?, system?, rowKey? }] },
// `target` being 'root' or a section id. Applied to a copy and reported back, so nothing is
// discovered after approval.
// `label` is the three-word version of `message`; `system` means S/4 uses it whatever anyone ticks.
// `rowKey` names the row an entry belongs to — see `rowMatchesKey` — and is what lets one stage
// derive SEVERAL rows into a section that is not empty. Every entry of one row carries the same key.
const DERIVATIONS = [];

const BLOCKING = 'error';
const ROOT = 'root';

const clone = (value) => JSON.parse(JSON.stringify(value || {}));

const isEmpty = (value) => value === undefined || value === null || String(value).trim() === '';

function targetRecord(payload, entry) {
  if (!entry.target || entry.target === ROOT) return payload.root;
  const rows = payload.sections?.[entry.target];
  if (!Array.isArray(rows)) return null;
  return rows[entry.index || 0] || null;
}

/**
 * Does this row already hold what a keyed entry would create?
 *
 * **A blank on the existing row counts as a match**, because the entry's own key fields are what
 * would fill it: a requester who typed partner function `AG` and left the sales area empty has the
 * row this derivation was about to add, not a different one. So it is filled, never duplicated.
 *
 * **An entirely empty row matches nothing** (`anyFilled`), or a section holding one blank row would
 * swallow every proposal that ever looked at it.
 */
function rowMatchesKey(row, rowKey) {
  let anyFilled = false;
  for (const [field, value] of Object.entries(rowKey || {})) {
    // A blank in the KEY is not a key either -- it would fail against a row that has that level and
    // the section would end up holding a second copy of every row.
    if (isEmpty(value)) continue;
    const current = row?.[field];
    if (isEmpty(current)) continue;
    anyFilled = true;
    if (String(current).trim() !== String(value).trim()) return false;
  }
  return anyFilled;
}

// A row the request is asking to delete holds nothing, so it can neither be filled nor be the
// reason a proposal is withheld. Matches `liveRows` in the derivation stages.
const isDeleted = (row) => String(row?.action || 'C').trim().toUpperCase() === 'D';

// The row a keyed entry belongs to, found by its key rather than by position. Every entry of one
// derived row carries the same `rowKey`, so the entries that complete a key find the row the
// `createsRow` entry made without anybody counting indices.
function findKeyedRow(payload, entry) {
  const rows = payload.sections?.[entry.target];
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => !isDeleted(row) && rowMatchesKey(row, entry.rowKey)) || null;
}

// Where a keyed entry's row actually landed, so the proposal the requester ticks names the same row.
function indexOfRecord(payload, entry, record) {
  const rows = payload.sections?.[entry.target];
  if (!Array.isArray(rows)) return entry.index || 0;
  const at = rows.indexOf(record);
  return at === -1 ? (entry.index || 0) : at;
}

async function runValidations(payload, validations = VALIDATIONS) {
  const messages = [];
  for (const validation of validations) {
    let found = [];
    try {
      found = await validation.run(payload) || [];
    } catch (error) {
      // A broken rule must not pass as "valid": it reports itself and blocks, because silently
      // skipping a validation is the failure this whole ordering exists to avoid.
      found = [{
        severity: BLOCKING,
        message: `The validation ${validation.name} could not run: ${error.message}`
      }];
    }
    for (const message of found) messages.push({ check: validation.name, ...message });
  }
  return messages;
}

// The same write, replayed onto a second payload from an entry the pipeline already applied.
function replay(payload, entry) {
  const keyed = Boolean(entry.rowKey) && entry.target && entry.target !== ROOT;
  if (entry.createsRow && entry.target && entry.target !== ROOT) {
    if (!payload.sections) payload.sections = {};
    const rows = payload.sections[entry.target] || (payload.sections[entry.target] = []);
    const appendable = keyed ? !findKeyedRow(payload, entry) : !rows.length;
    if (appendable) {
      rows.push({ [entry.field]: entry.value });
      return;
    }
    // A keyed row already present is not a write; an unkeyed one falls through and fills the gaps
    // of the first row, exactly as before.
    if (keyed) return;
  }
  // By key, not by position: this payload holds only the `system` entries, so a row's index here is
  // not the index it had in `derived`.
  const record = keyed ? findKeyedRow(payload, entry) : targetRecord(payload, entry);
  if (!record || !isEmpty(record[entry.field])) return;
  record[entry.field] = entry.value;
}

// `derived` is everything filled in (for the duplicate check); `systemDerived` is what was typed
// plus only the `system` entries, which is what the S/4 standard checks are allowed to see.
async function runDerivations(payload, derivations = DERIVATIONS) {
  const derived = clone(payload);
  const systemDerived = clone(payload);
  const applied = [];
  for (const derivation of derivations) {
    let entries = [];
    try {
      entries = await derivation.run(derived) || [];
    } catch (error) {
      // A derivation is an improvement, not a gate. It reports and the pipeline carries on with
      // what it already had — the duplicate check on slightly thinner data still beats no check.
      applied.push({
        check: derivation.name,
        severity: 'info',
        message: `The derivation ${derivation.name} could not run: ${error.message}`
      });
      continue;
    }
    for (const entry of entries) {
      // An entry with no field is a statement, not a value: report it and write nothing. It used
      // to depend on `targetRecord` happening to miss, which wrote root[undefined].
      if (!entry.field) {
        applied.push({ check: derivation.name, severity: 'info', message: entry.message });
        continue;
      }
      // The one case where a row *is* invented, and only because the derivation asked for it.
      //
      // **Without a `rowKey` the section has to be EMPTY.** Appending beside rows somebody added
      // deliberately would put a registered seat onto their second address — "fill in the city"
      // says nothing about which address it belongs to, so there is no safe row to add.
      //
      // **With one, the key is what makes appending safe** (2026-08-28). The derivation has named
      // the row it is missing, so a row already carrying that key is left alone and a row carrying
      // a different one is not touched. This is what lets a stage derive all four mandatory
      // partner functions, and derive the missing three beside an `AG` the requester typed.
      const keyed = Boolean(entry.rowKey) && entry.target && entry.target !== ROOT;
      if (entry.createsRow && entry.target && entry.target !== ROOT) {
        const rows = derived.sections[entry.target] || (derived.sections[entry.target] = []);
        const appendable = keyed ? !findKeyedRow(derived, entry) : !rows.length;
        if (appendable) {
          rows.push({ [entry.field]: entry.value });
          applied.push({
            check: derivation.name,
            target: entry.target,
            index: rows.length - 1,
            field: entry.field,
            value: entry.value,
            createsRow: true,
            rowKey: entry.rowKey || null,
            severity: 'info',
            label: entry.label || null,
            system: Boolean(entry.system),
            message: entry.message || `A ${entry.target} row was added with ${entry.field} ${entry.value}.`
          });
          continue;
        }
        // A keyed row that is already there is not a proposal at all — nothing to report and
        // nothing to write. An unkeyed one falls through and fills the first row's gaps, as before.
        if (keyed) continue;
      }
      const record = keyed ? findKeyedRow(derived, entry) : targetRecord(derived, entry);
      // A missing row is never invented, but the value is still reported without a `field`: a registry
      // answer nobody is told about is the same as not having looked it up.
      if (!record) {
        applied.push({
          check: derivation.name,
          severity: 'info',
          message: entry.message || `${entry.field} is available but there is no ${entry.target} row to hold it.`
        });
        continue;
      }
      // Never overwrite what the user typed. A derivation fills gaps; it does not correct people.
      if (!isEmpty(record[entry.field])) continue;
      record[entry.field] = entry.value;
      applied.push({
        check: derivation.name,
        target: entry.target || ROOT,
        // Where the row actually is, not where the derivation counted it: a keyed entry finds its
        // row by key, and the proposal the requester ticks has to name the same one.
        index: keyed ? indexOfRecord(derived, entry, record) : (entry.index || 0),
        field: entry.field,
        value: entry.value,
        rowKey: entry.rowKey || null,
        severity: 'info',
        label: entry.label || null,
        system: Boolean(entry.system),
        message: entry.message || `${entry.field} was derived as ${entry.value}.`
      });
    }
  }
  // Replayed from `applied`, so an entry the pipeline refused to write is not replayed either.
  for (const entry of applied) {
    if (entry.system && entry.field) replay(systemDerived, entry);
  }
  return { derived, applied, systemDerived };
}

// `checkDuplicates` is injected, not imported: this module stays free of the S/4 connection, and the
// caller decides what to compare against - submit excludes the request's own staged copy, a check does not.
async function runChecks(payload, { checkDuplicates, checkStandard, validations, derivations, propose } = {}) {
  const validationMessages = await runValidations(payload, validations);
  if (validationMessages.some((message) => message.severity === BLOCKING)) {
    return {
      valid: false,
      validations: validationMessages,
      derivations: [],
      normalisations: [],
      derived: payload,
      systemDerived: payload,
      duplicates: [],
      ranDuplicateCheck: false,
      standard: []
    };
  }

  const { derived, applied, systemDerived } = await runDerivations(payload, derivations);

  // Proposals, not changes. Made against the derived payload so a field just filled in can be
  // normalised in the same pass, and never applied here — the requester accepts or declines.
  let normalisations = [];
  try {
    normalisations = propose ? await propose(derived) || [] : [];
  } catch (error) {
    // A convenience, never a gate: an unavailable model must not stop a check or a submit.
    console.warn('[checks] Normalisation proposals unavailable:', error.message);
  }

  // `systemDerived`, not `derived` (fixed 2026-08-27): S/4 was objecting to postal codes VIES had
  // proposed and nobody had accepted, which is an error with no field on the screen to clear it.
  // An accepted proposal comes back as a typed value on the next press and is checked then.
  let standard = [];
  try {
    standard = checkStandard ? await checkStandard(systemDerived) || [] : [];
  } catch (error) {
    // Same reasoning as the duplicate check below: "nothing objected" produced by a check that
    // never ran is the one answer this must not give.
    standard = [{
      check: 'sap_standard_checks',
      severity: 'info',
      message: `The SAP standard checks could not run (${error.message}).`
    }];
  }

  let duplicates = [];
  let ranDuplicateCheck = false;
  try {
    duplicates = checkDuplicates ? await checkDuplicates(derived) || [] : [];
    ranDuplicateCheck = Boolean(checkDuplicates);
  } catch (error) {
    // "No duplicates found" produced by a check that never ran is the one wrong answer this must
    // not give, so the failure is reported rather than folded into an empty result.
    duplicates = [{
      checkName: 'duplicate_check',
      severity: 'info',
      message: `The duplicate check could not run (${error.message}).`
    }];
  }

  return {
    valid: true,
    // The standard checks join the validation list, because to a requester they are validations --
    // where a message came from is a detail of `check`, not a separate list to render.
    validations: [...validationMessages, ...standard],
    derivations: applied,
    normalisations,
    systemDerived,
    derived,
    duplicates,
    ranDuplicateCheck,
    standard
  };
}

module.exports = {
  VALIDATIONS,
  DERIVATIONS,
  BLOCKING,
  ROOT,
  runValidations,
  runDerivations,
  runChecks,
  rowMatchesKey
};
