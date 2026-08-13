'use strict';

/**
 * The order is the whole design, and it is not arbitrary:
 *
 *   validate -> derive -> duplicate check
 *
 * Data that fails validation cannot be a duplicate of anything, because it is not a partner yet —
 * so validation runs first and stops the rest. Data that is merely incomplete may be missing the
 * very fields a duplicate rule needs (a country, a tax number), so derivation runs before the
 * duplicate check rather than after it: checking first and deriving second would ask the rules a
 * question about a record that does not exist yet.
 *
 * Validations and derivations are **registries, deliberately empty today**. They exist so the
 * order is fixed now, while there is one caller and no rules, rather than negotiated later when
 * there are several of each. Adding one is pushing an entry into VALIDATIONS or DERIVATIONS.
 */

/**
 * Each entry: { name, run(candidate) -> [{ field, message, severity }] }
 * `severity: 'error'` stops the pipeline; 'warning' and 'info' do not.
 */
const VALIDATIONS = [];

/**
 * Each entry: { name, run(candidate) -> { field: value } }
 * Returned values are applied to a copy of the candidate and reported to the caller, so the user
 * sees what was filled in for them rather than finding it after approval.
 */
const DERIVATIONS = [];

const BLOCKING = 'error';

function runValidations(candidate, validations = VALIDATIONS) {
  const messages = [];
  for (const validation of validations) {
    let found = [];
    try {
      found = validation.run(candidate) || [];
    } catch (error) {
      // A broken rule must not pass as "valid": it reports itself and blocks, because silently
      // skipping a validation is the failure this whole ordering exists to avoid.
      found = [{
        field: null,
        severity: BLOCKING,
        message: `The validation ${validation.name} could not run: ${error.message}`
      }];
    }
    for (const message of found) messages.push({ check: validation.name, ...message });
  }
  return messages;
}

function runDerivations(candidate, derivations = DERIVATIONS) {
  const derived = { ...candidate };
  const applied = [];
  for (const derivation of derivations) {
    let changes = {};
    try {
      changes = derivation.run(derived) || {};
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
    for (const [field, value] of Object.entries(changes)) {
      // Never overwrite what the user typed. A derivation fills gaps; it does not correct people.
      if (derived[field] !== undefined && derived[field] !== null && derived[field] !== '') continue;
      derived[field] = value;
      applied.push({
        check: derivation.name,
        field,
        value,
        severity: 'info',
        message: `${field} was derived as ${value}.`
      });
    }
  }
  return { derived, applied };
}

/**
 * `checkDuplicates(candidate)` is injected rather than imported so this module stays free of the
 * S/4 connection and the resident index, and so the caller decides what a candidate is compared
 * against — the submit path excludes the request's own staged copy, a bare check does not.
 */
async function runChecks(candidate, { checkDuplicates, validations, derivations } = {}) {
  const validationMessages = runValidations(candidate, validations);
  if (validationMessages.some((message) => message.severity === BLOCKING)) {
    return {
      valid: false,
      validations: validationMessages,
      derivations: [],
      derived: candidate,
      duplicates: [],
      ranDuplicateCheck: false
    };
  }

  const { derived, applied } = runDerivations(candidate, derivations);

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
    derived,
    duplicates,
    ranDuplicateCheck
  };
}

module.exports = {
  VALIDATIONS,
  DERIVATIONS,
  BLOCKING,
  runValidations,
  runDerivations,
  runChecks
};
