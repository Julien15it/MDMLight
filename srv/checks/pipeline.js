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

// { name, async run(payload) -> [{ target, index, field, value, message }] }, `target` being 'root'
// or a section id. Applied to a copy and reported back, so nothing is discovered after approval.
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

/**
 * The row a derivation targets, created when the section is empty and the derivation asked for it.
 * Changed 2026-08-20: a derivation used to report "there is no Addresses row to hold it" and write
 * nothing, so a VIES address could not be proposed until the requester had pressed Add first.
 *
 * Only an EMPTY section and only index 0. Appending to a section that already has rows would put
 * the registered seat onto a second address somebody added deliberately, and filling index 3 of a
 * one-row section would invent the two rows in between.
 */
function createTargetRecord(payload, entry) {
  if (!entry.createRow || !entry.target || entry.target === ROOT) return null;
  if ((entry.index || 0) !== 0) return null;
  if (!payload.sections) payload.sections = {};
  const rows = payload.sections[entry.target];
  if (Array.isArray(rows) && rows.length) return null;
  const record = {};
  payload.sections[entry.target] = [record];
  return record;
}

async function runDerivations(payload, derivations = DERIVATIONS) {
  const derived = clone(payload);
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
      let record = targetRecord(derived, entry);
      // A derivation that asked to may create the first row of an empty section; anything else is
      // still never invented, and the value is reported without a `field` instead - a registry
      // answer nobody is told about is the same as not having looked it up.
      let createdRow = false;
      if (!record) {
        record = createTargetRecord(derived, entry);
        createdRow = Boolean(record);
      }
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
        index: entry.index || 0,
        field: entry.field,
        value: entry.value,
        // The screen has to add the row as well, or an accepted value has nowhere to land.
        createRow: createdRow || undefined,
        severity: 'info',
        message: entry.message || `${entry.field} was derived as ${entry.value}.`
      });
    }
  }
  return { derived, applied };
}

// `checkDuplicates` is injected, not imported: this module stays free of the S/4 connection, and the
// caller decides what to compare against - submit excludes the request's own staged copy, a check does not.
async function runChecks(payload, { checkDuplicates, validations, derivations, propose } = {}) {
  const validationMessages = await runValidations(payload, validations);
  if (validationMessages.some((message) => message.severity === BLOCKING)) {
    return {
      valid: false,
      validations: validationMessages,
      derivations: [],
      normalisations: [],
      derived: payload,
      duplicates: [],
      ranDuplicateCheck: false
    };
  }

  const { derived, applied } = await runDerivations(payload, derivations);

  // Proposals, not changes. Made against the derived payload so a field just filled in can be
  // normalised in the same pass, and never applied here — the requester accepts or declines.
  let normalisations = [];
  try {
    normalisations = propose ? await propose(derived) || [] : [];
  } catch (error) {
    // A convenience, never a gate: an unavailable model must not stop a check or a submit.
    console.warn('[checks] Normalisation proposals unavailable:', error.message);
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
    validations: validationMessages,
    derivations: applied,
    normalisations,
    derived,
    duplicates,
    ranDuplicateCheck
  };
}

module.exports = {
  VALIDATIONS,
  DERIVATIONS,
  BLOCKING,
  ROOT,
  runValidations,
  runDerivations,
  runChecks
};
