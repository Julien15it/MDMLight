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

// What "we already filled that in" means. Trimmed and exact: a difference in case or punctuation is
// a real difference the register is entitled to propose, and a proposal accepted once stops being
// offered because the two sides then match.
const sameValue = (left, right) => String(left ?? '').trim() === String(right ?? '').trim();

function targetRecord(payload, entry) {
  if (!entry.target || entry.target === ROOT) return payload.root;
  const rows = payload.sections?.[entry.target];
  if (!Array.isArray(rows)) return null;
  return rows[entry.index || 0] || null;
}

// A blank on either side is skipped, so the row a requester part-filled is completed, not
// duplicated; an all-blank row (`anyFilled` false) matches nothing.
function rowMatchesKey(row, rowKey) {
  let anyFilled = false;
  for (const [field, value] of Object.entries(rowKey || {})) {
    if (isEmpty(value)) continue;
    const current = row?.[field];
    if (isEmpty(current)) continue;
    anyFilled = true;
    if (String(current).trim() !== String(value).trim()) return false;
  }
  return anyFilled;
}

// A row on its way out holds nothing. Matches `liveRows` in the derivation stages.
const isDeleted = (row) => String(row?.action || 'C').trim().toUpperCase() === 'D';

// By key, not by position: every entry of one derived row carries the same `rowKey`.
function findKeyedRow(payload, entry) {
  const rows = payload.sections?.[entry.target];
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => !isDeleted(row) && rowMatchesKey(row, entry.rowKey)) || null;
}

// Where the row actually landed, so the proposal the requester ticks names the same row.
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
    // A keyed row already present is not a write; an unkeyed one falls through and fills.
    if (keyed) return;
  }
  // By key: this payload holds only the `system` entries, so indices differ from `derived`.
  const record = keyed ? findKeyedRow(payload, entry) : targetRecord(payload, entry);
  if (!record) return;
  // An overwriting `system` entry is replayed over the typed value: `system` says S/4 uses this
  // whatever anyone ticks, so the payload the standard checks see has to carry it.
  if (!entry.overwrites && !isEmpty(record[entry.field])) return;
  record[entry.field] = entry.value;
}

// No caller passed a role to gate on: every field is editable, exactly the behaviour before this
// existed. A caller that resolves field properties for a role (Requester/Approver/DataSteward)
// passes its own predicate instead - see `runRequestChecks` in change-request-service.js.
const ALWAYS_EDITABLE = () => true;

// `derived` is everything filled in (for the duplicate check); `systemDerived` is what was typed
// plus only the `system` entries, which is what the S/4 standard checks are allowed to see.
//
// `fieldEditable(target, field)` gates what a derivation may PROPOSE, never what it may read: a
// field the current role cannot touch (hidden or read-only, per a field property profile) gets no
// entry at all, silently — the same "a requester never reads what they cannot act on" rule that
// already governs a derivation with no prerequisite (see CLAUDE.md, "The rule about what a
// derivation may say"). A field-less statement entry is checked the same way with `field` left
// undefined, which resolves to the entity's own state - a statement about a section the current
// role cannot see is exactly as unhelpful as a value it cannot edit.
async function runDerivations(payload, derivations = DERIVATIONS, { fieldEditable = ALWAYS_EDITABLE } = {}) {
  const derived = clone(payload);
  const systemDerived = clone(payload);
  const applied = [];
  // One claim per field, first stage wins - the ordering `runRequestChecks` builds is what decides
  // which. It used to fall out of "never overwrite": a later stage found the field filled and said
  // nothing. Now that a filled field IS a proposal, without this the country default would offer to
  // overwrite what VIES just derived.
  const claimed = new Set();
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
      if (!fieldEditable(entry.target || ROOT, entry.field || undefined)) continue;
      // An entry with no field is a statement, not a value: report it and write nothing. It used
      // to depend on `targetRecord` happening to miss, which wrote root[undefined].
      if (!entry.field) {
        applied.push({ check: derivation.name, severity: 'info', message: entry.message });
        continue;
      }
      // A `rowKey` names the missing row, which is what makes appending beside existing rows safe;
      // without one the section must still be EMPTY. See CLAUDE.md.
      const keyed = Boolean(entry.rowKey) && entry.target && entry.target !== ROOT;
      if (entry.createsRow && entry.target && entry.target !== ROOT) {
        const rows = derived.sections[entry.target] || (derived.sections[entry.target] = []);
        const appendable = keyed ? !findKeyedRow(derived, entry) : !rows.length;
        if (appendable) {
          rows.push({ [entry.field]: entry.value });
          // Claimed like any other write: the next stage must not offer to overwrite the value
          // this one just put in a row it also just created.
          claimed.add(`${entry.target}|${rows.length - 1}|${entry.field}`);
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
        // A keyed row already there is not a proposal; an unkeyed one falls through and fills.
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
      // Where the row actually is, so the proposal the requester ticks names the same one.
      const at = keyed ? indexOfRecord(derived, entry, record) : (entry.index || 0);
      const slot = `${entry.target || ROOT}|${at}|${entry.field}`;
      if (claimed.has(slot)) continue;
      // A filled field is a PROPOSAL, not a skip (2026-09-03, asked for). The dialog is where a
      // requester keeps what they typed; a derivation that stays silent because a field is filled
      // leaves a disagreement with the official register nobody is ever offered a way to settle.
      // Proposing what is already there is not a proposal, which is what stops an accepted value
      // being offered again on the next press.
      const current = record[entry.field];
      const overwrites = !isEmpty(current);
      if (overwrites && sameValue(current, entry.value)) continue;
      claimed.add(slot);
      record[entry.field] = entry.value;
      applied.push({
        check: derivation.name,
        target: entry.target || ROOT,
        index: at,
        field: entry.field,
        value: entry.value,
        rowKey: entry.rowKey || null,
        severity: 'info',
        label: entry.label || null,
        system: Boolean(entry.system),
        // What the requester is being asked to give up, so the dialog can show it beside the
        // proposal rather than an empty Current cell.
        overwrites,
        current: overwrites ? String(current) : '',
        message: entry.message || (overwrites
          ? `${entry.field} was derived as ${entry.value}, replacing ${current}.`
          : `${entry.field} was derived as ${entry.value}.`)
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
async function runChecks(payload, {
  checkDuplicates, checkStandard, validations, derivations, propose, fieldEditable
} = {}) {
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

  const { derived, applied, systemDerived } = await runDerivations(
    payload, derivations, { fieldEditable }
  );

  // The three below are STARTED TOGETHER and awaited at the end (2026-09-03). None of them
  // consumes another's output - each is handed a payload the derivations already finished - and
  // none writes into what it is given, checked rather than assumed. So the only thing running them
  // one after another ever bought was latency, and on the data steward step it charged a requester
  // an AI Core round trip and an S/4 dry run back to back.
  //
  // Three separate `.catch`es rather than one `allSettled`, deliberately: the three answers to
  // "this did not run" are different on purpose and a shared handler would flatten them. A
  // normalisation is a convenience and degrades to nothing; the other two must SAY they could not
  // run, because "no duplicates found" and "nothing objected" from a check that never happened are
  // the two wrong answers this pipeline exists to avoid. `Promise.resolve().then(...)` so a stage
  // that throws synchronously lands in its own catch exactly as it did inside the old try.

  // Proposals, not changes. Made against the derived payload so a field just filled in can be
  // normalised in the same pass, and never applied here — the requester accepts or declines.
  const normalisationsPending = propose
    ? Promise.resolve().then(() => propose(derived)).then((value) => value || []).catch((error) => {
      // A convenience, never a gate: an unavailable model must not stop a check or a submit.
      console.warn('[checks] Normalisation proposals unavailable:', error.message);
      return [];
    })
    : Promise.resolve([]);

  // `systemDerived`, not `derived` (fixed 2026-08-27): S/4 was objecting to postal codes VIES had
  // proposed and nobody had accepted, which is an error with no field on the screen to clear it.
  // An accepted proposal comes back as a typed value on the next press and is checked then.
  const standardPending = checkStandard
    ? Promise.resolve().then(() => checkStandard(systemDerived)).then((value) => value || [])
      .catch((error) => [{
        // Same reasoning as the duplicate check below: "nothing objected" produced by a check that
        // never ran is the one answer this must not give.
        check: 'sap_standard_checks',
        severity: 'info',
        message: `The SAP standard checks could not run (${error.message}).`
      }])
    : Promise.resolve([]);

  const duplicatesPending = checkDuplicates
    ? Promise.resolve().then(() => checkDuplicates(derived)).then((value) => value || [])
      .catch((error) => [{
        // "No duplicates found" produced by a check that never ran is the one wrong answer this
        // must not give, so the failure is reported rather than folded into an empty result.
        checkName: 'duplicate_check',
        severity: 'info',
        message: `The duplicate check could not run (${error.message}).`
      }])
    : Promise.resolve([]);

  // Cannot reject: every branch above ends in a catch that resolves to the stage's own fallback.
  const [normalisations, standard, duplicates] = await Promise.all(
    [normalisationsPending, standardPending, duplicatesPending]
  );
  const ranDuplicateCheck = Boolean(checkDuplicates);

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
