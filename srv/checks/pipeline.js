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

// { name, async run(payload) -> [{ target, index, field, value, message, label?, system? }] },
// `target` being 'root' or a section id. Applied to a copy and reported back, so nothing is
// discovered after approval.
// `label` is the three-word version of `message`; `system` means S/4 uses it whatever anyone ticks.
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

// The same write, replayed onto a second payload from an entry the pipeline already applied.
function replay(payload, entry) {
  if (entry.createsRow && entry.target && entry.target !== ROOT) {
    if (!payload.sections) payload.sections = {};
    const rows = payload.sections[entry.target] || (payload.sections[entry.target] = []);
    if (!rows.length) {
      rows.push({ [entry.field]: entry.value });
      return;
    }
  }
  const record = targetRecord(payload, entry);
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
      // The one case where a row *is* invented, and only because the derivation asked for it. The
      // section has to be EMPTY: appending beside rows somebody added deliberately would put a
      // registered seat onto their second address, so everything else is still reported and never
      // written somewhere it was not meant to be.
      if (entry.createsRow && entry.target && entry.target !== ROOT) {
        const rows = derived.sections[entry.target] || (derived.sections[entry.target] = []);
        if (!rows.length) {
          rows.push({ [entry.field]: entry.value });
          applied.push({
            check: derivation.name,
            target: entry.target,
            index: rows.length - 1,
            field: entry.field,
            value: entry.value,
            createsRow: true,
            severity: 'info',
            label: entry.label || null,
            system: Boolean(entry.system),
            message: entry.message || `A ${entry.target} row was added with ${entry.field} ${entry.value}.`
          });
          continue;
        }
      }
      const record = targetRecord(derived, entry);
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
        index: entry.index || 0,
        field: entry.field,
        value: entry.value,
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
  runChecks
};
