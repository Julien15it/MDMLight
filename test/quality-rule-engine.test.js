'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPARISONS, SEVERITIES, compare, readValueSpec,
  runValidationRule, runDerivationRule,
  validateValidationRule, validateDerivationRule, createConfiguredStages
} = require('../srv/checks/rule-engine');
const {
  PAYLOAD_NODES, payloadFields, resolvePayloadField, sectionRows, targetFor
} = require('../srv/checks/payload-fields');
const { runChecks, runValidations, runDerivations } = require('../srv/checks/pipeline');

/**
 * A CSN stand-in. The real catalog is generated from db/staging.cds at runtime; injecting a small
 * model keeps these tests about the engine rather than about the staging schema, which has its own
 * tests. Sections the model does not describe fall through to "accept the name", which is the
 * documented behaviour for an unloaded model.
 */
const model = {
  definitions: {
    'mdmlight.staging.StagedGeneral': {
      elements: {
        ID: { type: 'cds.UUID' },
        request: { type: 'cds.Association', target: 'mdmlight.staging.ChangeRequests' },
        Language: { type: 'cds.String' },
        CorrespondenceLanguage: { type: 'cds.String' },
        SearchTerm1: { type: 'cds.String' },
        LegalForm: { type: 'cds.String' },
        OrganizationBPName1: { type: 'cds.String' },
        BusinessPartnerCategory: { type: 'cds.String' },
        BusinessPartnerIsBlocked: { type: 'cds.Boolean' }
      }
    },
    'mdmlight.staging.StagedAddresses': {
      elements: {
        ID: { type: 'cds.UUID' },
        action: { type: 'cds.String' },
        Country: { type: 'cds.String' },
        Region: { type: 'cds.String' },
        PostalCode: { type: 'cds.String' },
        StreetName: { type: 'cds.String' }
      }
    }
  }
};

const payload = (root = {}, sections = {}) => ({ root, sections });

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

test('the catalog is qualified, generated, and drops the plumbing', () => {
  const fields = payloadFields(model).map((entry) => entry.field);
  assert.ok(fields.includes('General.Language'));
  assert.ok(fields.includes('Addresses.Country'));
  // Keys, backlinks and the row's change indicator are not rules anybody can write.
  assert.equal(fields.includes('General.ID'), false);
  assert.equal(fields.includes('General.request'), false);
  assert.equal(fields.includes('Addresses.action'), false);
});

// The section ids are shared with NODES in change-request-service.js, so a rule can never name a
// section nothing stages. General is the payload root rather than a node.
test('General maps onto the payload root and the rest onto sections', () => {
  assert.equal(targetFor('General'), 'root');
  assert.equal(targetFor('Addresses'), 'Addresses');
  assert.equal(PAYLOAD_NODES.General.root, true);
  assert.equal(PAYLOAD_NODES.Addresses.many, true);
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

test('the comparisons a steward asked for are all there', () => {
  for (const code of ['eq', 'ne', 'lt', 'le', 'gt', 'ge']) {
    assert.ok(COMPARISONS[code], `${code} is offered`);
    assert.equal(COMPARISONS[code].needsValue, true);
  }
  // These two answer a question about emptiness, so a Value cell would be ignored.
  assert.equal(COMPARISONS.empty.needsValue, false);
  assert.equal(COMPARISONS.notEmpty.needsValue, false);
});

// Otherwise 9 would be greater than 10, which is the classic decision-table bug.
test('numbers compare as numbers and text as trimmed upper case', () => {
  assert.equal(compare('9', '10'), -1);
  assert.equal(compare('10', '9'), 1);
  assert.equal(compare(' be ', 'BE'), 0);
  assert.equal(compare('2026-01-02', '2026-01-10'), -1);
});

/**
 * The Value column means one of two things and nothing else decides which. Catalog names are always
 * dotted, so a literal can never be mistaken for a reference - which is why there is no third
 * column asking the steward to say.
 */
test('a dotted catalog name in Value is a reference, anything else a literal', () => {
  assert.deepEqual(readValueSpec('NL', model), { kind: 'literal', literal: 'NL' });
  assert.equal(readValueSpec('General.Language', model).kind, 'reference');
  // Dotted but not in the catalog: still a literal, so a typo writes text rather than throwing.
  assert.deepEqual(readValueSpec('N.V.', model), { kind: 'literal', literal: 'N.V.' });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('the rule from the request: condition Country BE, field Language, = NL', () => {
  const rule = {
    conditionField: 'Addresses.Country', conditionValue: 'BE',
    field: 'General.Language', comparison: 'eq', value: 'NL', severity: 'error'
  };
  const bad = runValidationRule(rule, payload({ Language: 'FR' }, { Addresses: [{ Country: 'BE' }] }), model);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 'error');
  assert.equal(bad[0].target, 'root');
  assert.equal(bad[0].field, 'Language');
  assert.match(bad[0].message, /must be NL/);
  assert.match(bad[0].message, /Addresses\.Country = BE/);

  const good = runValidationRule(rule, payload({ Language: 'NL' }, { Addresses: [{ Country: 'BE' }] }), model);
  assert.deepEqual(good, []);

  // The condition is what makes it a decision table: a French address is not this rule's business.
  const other = runValidationRule(rule, payload({ Language: 'FR' }, { Addresses: [{ Country: 'FR' }] }), model);
  assert.deepEqual(other, []);
});

/**
 * The ordering guard. `pipeline.js` runs validations *before* derivations, so a rule that failed on
 * an empty field would block the very derivation that was about to fill it. `notEmpty` is how a
 * steward says a field is required.
 */
test('an empty field does not fail a comparison, only notEmpty', () => {
  const equals = { field: 'General.Language', comparison: 'eq', value: 'NL' };
  assert.deepEqual(runValidationRule(equals, payload({}), model), []);
  assert.deepEqual(runValidationRule(equals, payload({ Language: '   ' }), model), []);

  const required = { field: 'General.Language', comparison: 'notEmpty' };
  const findings = runValidationRule(required, payload({}), model);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /is required/);
  assert.deepEqual(runValidationRule(required, payload({ Language: 'NL' }), model), []);
});

/**
 * Scoping, which is the part of a decision table people get wrong. A condition on the rule's own
 * section is evaluated per row: this is about the Belgian address rows, not about every address of
 * a partner that happens to have one Belgian address.
 */
test('a condition on the rule own section narrows it to the matching rows', () => {
  const rule = {
    conditionField: 'Addresses.Country', conditionValue: 'BE',
    field: 'Addresses.Region', comparison: 'notEmpty', severity: 'warning'
  };
  const findings = runValidationRule(rule, payload({}, {
    Addresses: [
      { Country: 'BE', Region: 'VAN' },   // fine
      { Country: 'FR' },                   // not this rule's business
      { Country: 'BE' }                    // fails, and says which row
    ]
  }), model);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].index, 2);
  assert.equal(findings[0].target, 'Addresses');
  assert.equal(findings[0].severity, 'warning');
});

// A condition on another section is a statement about the partner, so any row of it may satisfy it.
test('a condition on another section holds when any of its rows matches', () => {
  const rule = {
    conditionField: 'Addresses.Country', conditionValue: 'BE',
    field: 'General.Language', comparison: 'eq', value: 'NL'
  };
  const findings = runValidationRule(rule, payload({ Language: 'FR' }, {
    Addresses: [{ Country: 'FR' }, { Country: 'BE' }]
  }), model);
  assert.equal(findings.length, 1);
});

test('a validation can compare two fields', () => {
  const rule = {
    field: 'General.CorrespondenceLanguage', comparison: 'eq', value: 'General.Language'
  };
  const bad = runValidationRule(rule, payload({ Language: 'NL', CorrespondenceLanguage: 'FR' }), model);
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /General\.Language \(NL\)/);
  assert.deepEqual(
    runValidationRule(rule, payload({ Language: 'NL', CorrespondenceLanguage: 'nl' }), model),
    []
  );
});

/**
 * A rule the engine cannot evaluate blocks, the same way a validation that throws does. Skipping it
 * would let a request through on the strength of a check that never ran, which is the one wrong
 * answer this whole pipeline is arranged to avoid.
 */
test('an unevaluable rule blocks and names itself', () => {
  const unknownField = runValidationRule({ field: 'Nope.Nope', comparison: 'eq', value: 'x' }, payload({}), model);
  assert.equal(unknownField[0].severity, 'error');
  assert.match(unknownField[0].message, /unknown field/);

  const unknownComparison = runValidationRule(
    { field: 'General.Language', comparison: 'sortOf', value: 'x' }, payload({ Language: 'NL' }), model
  );
  assert.equal(unknownComparison[0].severity, 'error');
  assert.match(unknownComparison[0].message, /unknown comparison/);
});

test('severity decides whether a rule blocks, and defaults to error', () => {
  assert.deepEqual(SEVERITIES, ['error', 'warning', 'info']);
  const rule = { field: 'General.Language', comparison: 'eq', value: 'NL' };
  assert.equal(runValidationRule(rule, payload({ Language: 'FR' }), model)[0].severity, 'error');
  assert.equal(
    runValidationRule({ ...rule, severity: 'warning' }, payload({ Language: 'FR' }), model)[0].severity,
    'warning'
  );
});

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

test('the rule from the request: condition Country BE, fill Language with NL', () => {
  const rule = {
    conditionField: 'Addresses.Country', conditionValue: 'BE',
    field: 'General.Language', value: 'NL'
  };
  const entries = runDerivationRule(rule, payload({}, { Addresses: [{ Country: 'BE' }] }), model);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    { target: entries[0].target, index: entries[0].index, field: entries[0].field, value: entries[0].value },
    { target: 'root', index: 0, field: 'Language', value: 'NL' }
  );
  assert.match(entries[0].message, /filled in as “NL”/);
});

// The whole point of allowing a field name in Value: field A gets the value of field B.
test('a derivation can copy another field', () => {
  const rule = { field: 'General.CorrespondenceLanguage', value: 'General.Language' };
  const entries = runDerivationRule(rule, payload({ Language: 'NL' }), model);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 'NL');
  assert.match(entries[0].message, /copied from General\.Language/);
});

/**
 * A derivation fills a gap; it does not correct people. The pipeline enforces this too - both
 * because these rules and the registry's must not be able to disagree about it.
 */

test('a derivation onto a section fills each matching row and says which', () => {
  const rule = {
    conditionField: 'Addresses.Country', conditionValue: 'BE',
    field: 'Addresses.Region', value: 'VAN'
  };
  const entries = runDerivationRule(rule, payload({}, {
    Addresses: [{ Country: 'FR' }, { Country: 'BE' }, { Country: 'BE', Region: 'WBR' }]
  }), model);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].index, 1);
  assert.equal(entries[0].target, 'Addresses');
});

/**
 * Changed 2026-08-20: an empty section gets one synthetic row so the rule can propose the section's
 * first value, instead of the requester having to press Add before a rule could fire at all. The
 * entry asks for the row; `pipeline.js` is what creates it, and the requester still ticks it.
 */
test('a derivation onto a section with no rows proposes the first row', () => {
  const entries = runDerivationRule({ field: 'Addresses.Region', value: 'VAN' }, payload({}), model);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, 'Addresses');
  assert.equal(entries[0].index, 0);
  assert.equal(entries[0].createsRow, true);
  assert.equal(entries[0].value, 'VAN');
});

/**
 * The guard that stops a rule inventing a row out of its own emptiness: a condition on the rule's
 * OWN section is evaluated against the synthetic row, where every field is empty, so it cannot
 * hold. Only conditions met somewhere else can bring a row into existence.
 */
test('a condition on the empty section itself cannot create the row', () => {
  const rule = {
    field: 'Addresses.Region', value: 'VAN',
    conditionField: 'Addresses.Country', conditionValue: 'BE'
  };
  assert.deepEqual(runDerivationRule(rule, payload({}), model), []);
  // The same rule conditioned elsewhere does fire, and asks for the row.
  const elsewhere = {
    field: 'Addresses.Region', value: 'VAN',
    conditionField: 'General.BusinessPartnerCategory', conditionValue: '2'
  };
  const entries = runDerivationRule(elsewhere, payload({ BusinessPartnerCategory: '2' }), model);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].createsRow, true);
});

// ---------------------------------------------------------------------------
// Save-time validation of the rows
// ---------------------------------------------------------------------------

test('a validation row is checked at the keyboard, not at check time', () => {
  assert.deepEqual(
    validateValidationRule({ field: 'General.Language', comparison: 'eq', value: 'NL' }, model).errors,
    []
  );
  const problems = validateValidationRule({ field: 'Nope', comparison: 'sortOf' }, model).errors;
  assert.ok(problems.some((problem) => problem.field === 'field'));
  assert.ok(problems.some((problem) => problem.field === 'comparison'));
  // A comparison that compares against something needs something to compare against.
  assert.ok(validateValidationRule({ field: 'General.Language', comparison: 'eq' }, model)
    .errors.some((problem) => problem.field === 'value'));
  // And one that does not, says so rather than silently ignoring it.
  assert.ok(validateValidationRule({ field: 'General.Language', comparison: 'empty', value: 'NL' }, model)
    .warnings.some((problem) => problem.field === 'value'));
});

// Half a condition is the dangerous half: a field with no value matches every record, which is the
// opposite of what a condition is for.
test('half a condition is rejected in both tables', () => {
  for (const validate of [validateValidationRule, validateDerivationRule]) {
    const base = validate === validateValidationRule
      ? { field: 'General.Language', comparison: 'eq', value: 'NL' }
      : { field: 'General.Language', value: 'NL' };
    assert.ok(validate({ ...base, conditionField: 'Addresses.Country' }, model)
      .errors.some((problem) => problem.field === 'conditionValue'));
    assert.ok(validate({ ...base, conditionValue: 'BE' }, model)
      .errors.some((problem) => problem.field === 'conditionField'));
    assert.ok(validate({ ...base, conditionField: 'Nope.Nope', conditionValue: 'BE' }, model)
      .errors.some((problem) => problem.field === 'conditionField'));
  }
});

/**
 * One stage per kind rather than one per rule, because `pipeline.js` blocks on the first error a
 * validation stage reports - a table of twenty rules has to report all twenty problems rather than
 * the first one.
 */
test('every rule in a table reports, not just the first that fails', async () => {
  const stages = createConfiguredStages({
    validations: [
      { field: 'General.Language', comparison: 'eq', value: 'NL' },
      { field: 'General.SearchTerm1', comparison: 'notEmpty' }
    ],
    model
  });
  assert.equal(stages.validations.length, 1);
  const findings = await stages.validations[0].run(payload({ Language: 'FR' }));
  assert.equal(findings.length, 2);
});

// An inactive or unusable row contributes nothing rather than blocking every request. There are no
// default validations to fall back to, so running none is the honest answer - unlike the duplicate
// check, where an empty table would switch the control off.
test('inactive and unusable rows are dropped, and drop nothing else', async () => {
  const stages = createConfiguredStages({
    validations: [
      { field: 'General.Language', comparison: 'eq', value: 'NL', isActive: false },
      { field: 'Nope.Nope', comparison: 'eq', value: 'x' },
      { field: 'General.SearchTerm1', comparison: 'notEmpty' }
    ],
    model
  });
  const findings = await stages.validations[0].run(payload({ Language: 'FR' }));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /required/);
});

// Two derivations onto one field resolve predictably: the pipeline never overwrites, so the first
// to fill it wins, and `sequence` is what decides who is first.
test('sequence orders the derivations that compete for a field', async () => {
  const stages = createConfiguredStages({
    derivations: [
      { sequence: 20, field: 'General.Language', value: 'FR' },
      { sequence: 10, field: 'General.Language', value: 'NL' }
    ],
    model
  });
  const { derived, applied } = await runDerivations(payload({}), stages.derivations);
  assert.equal(derived.root.Language, 'NL');
  assert.equal(applied.filter((entry) => entry.field === 'Language').length, 1);
});

// ---------------------------------------------------------------------------
// Through the pipeline
// ---------------------------------------------------------------------------

/**
 * The ordering the whole design rests on, now with configured rules in it: a blocking validation
 * stops the derivations and the duplicate check, and a warning does not.
 */
test('a blocking configured validation stops the rest of the pipeline', async () => {
  const stages = createConfiguredStages({
    validations: [{ field: 'General.Language', comparison: 'eq', value: 'NL', severity: 'error' }],
    derivations: [{ field: 'General.SearchTerm1', value: 'ALLUVION' }],
    model
  });
  let matched = false;
  const result = await runChecks(payload({ Language: 'FR' }), {
    ...stages,
    checkDuplicates: async () => { matched = true; return []; }
  });
  assert.equal(result.valid, false);
  assert.equal(matched, false, 'nothing is compared against a record that failed validation');
  assert.deepEqual(result.derivations, []);
});

test('a warning validation reports and lets the derivations run', async () => {
  const stages = createConfiguredStages({
    validations: [{ field: 'General.Language', comparison: 'eq', value: 'NL', severity: 'warning' }],
    derivations: [{ field: 'General.SearchTerm1', value: 'ALLUVION' }],
    model
  });
  const result = await runChecks(payload({ Language: 'FR' }), {
    ...stages,
    checkDuplicates: async () => []
  });
  assert.equal(result.valid, true);
  assert.equal(result.validations.length, 1);
  assert.equal(result.validations[0].check, 'configured_validation');
  assert.equal(result.derived.root.SearchTerm1, 'ALLUVION');
});

// Derive precedes match so a rule conditioned on a field nobody typed still fires - which is why a
// derived value has to reach the duplicate check.
test('a derived value reaches the duplicate check', async () => {
  const stages = createConfiguredStages({
    derivations: [{ field: 'General.Language', value: 'NL' }],
    model
  });
  let seen = null;
  await runChecks(payload({}), { ...stages, checkDuplicates: async (derived) => { seen = derived; return []; } });
  assert.equal(seen.root.Language, 'NL');
});

test('a configured derivation is labelled in three words', async () => {
  const rules = [{
    field: 'General.Language', value: 'NL', sequence: 1, isActive: true
  }];
  const stages = createConfiguredStages({ derivations: rules, model });
  const { applied } = await runDerivations(payload({}), stages.derivations);

  assert.equal(applied.length, 1);
  assert.equal(applied[0].label, 'Derivation rule');
  assert.equal(applied[0].system, false);
});

// ---------------------------------------------------------------------------
// The condition comparator (2026-09-02, asked for: "Condition 1 contains the field, the
// comparator, the values" - the shape Workflow Agent Determination already had)
// ---------------------------------------------------------------------------

// The whole point of the column: a condition is no longer forced to mean equality.
test('a condition is evaluated under its own comparator', () => {
  const rule = (operator, value) => ({
    conditionField: 'Addresses.Country', conditionOperator: operator, conditionValue: value,
    field: 'General.Language', comparison: 'eq', value: 'NL', severity: 'error'
  });
  const be = payload({ Language: 'FR' }, { Addresses: [{ Country: 'BE' }] });

  // `!=` fires on a partner whose country is anything but BE, and stays quiet on one that is BE.
  assert.equal(runValidationRule(rule('ne', 'BE'), be, model).length, 0);
  assert.equal(runValidationRule(rule('ne', 'DE'), be, model).length, 1);
  assert.equal(runValidationRule(rule('contains', 'B'), be, model).length, 1);
  assert.equal(runValidationRule(rule('eq', 'BE'), be, model).length, 1);
});

// `is empty` / `is not empty` are read on the RAW value: an empty value is exactly the thing they
// exist to notice, so filtering it out first would make them answer about nothing.
test('a condition can ask about emptiness, and needs no value to do it', () => {
  const rule = (operator) => ({
    conditionField: 'Addresses.Region', conditionOperator: operator,
    field: 'General.Language', comparison: 'eq', value: 'NL', severity: 'error'
  });
  const noRegion = payload({ Language: 'FR' }, { Addresses: [{ Country: 'BE', Region: '' }] });
  const region = payload({ Language: 'FR' }, { Addresses: [{ Country: 'BE', Region: 'VBR' }] });

  assert.equal(runValidationRule(rule('empty'), noRegion, model).length, 1);
  assert.equal(runValidationRule(rule('empty'), region, model).length, 0);
  assert.equal(runValidationRule(rule('notEmpty'), region, model).length, 1);
  assert.equal(runValidationRule(rule('notEmpty'), noRegion, model).length, 0);

  // And it is a COMPLETE condition with no value, so save-time validation must not refuse it.
  for (const validate of [validateValidationRule, validateDerivationRule]) {
    const base = validate === validateValidationRule
      ? { field: 'General.Language', comparison: 'eq', value: 'NL' }
      : { field: 'General.Language', value: 'NL' };
    assert.deepEqual(
      validate({ ...base, conditionField: 'Addresses.Region', conditionOperator: 'notEmpty' }, model).errors,
      []
    );
    // An operator outside the vocabulary is refused rather than quietly read as equality.
    assert.ok(validate({ ...base, conditionField: 'Addresses.Region', conditionOperator: 'nope' }, model)
      .errors.some((problem) => problem.field === 'conditionOperator'));
  }
});

// A requester told "where Country = BE" about a `!=` rule has been told something untrue.
test('the reason a rule fired says which comparator it used', () => {
  const fired = (operator, value) => runValidationRule({
    conditionField: 'Addresses.Country', conditionOperator: operator, conditionValue: value,
    field: 'General.Language', comparison: 'eq', value: 'NL', severity: 'error'
  }, payload({ Language: 'FR' }, { Addresses: [{ Country: 'BE' }] }), model)[0].message;
  assert.match(fired('ne', 'DE'), /Addresses\.Country != DE/u);
  assert.match(fired('contains', 'B'), /Addresses\.Country contains B/u);
  // The two that compare against nothing say what they asked, not an empty value list.
  assert.match(
    runValidationRule({
      conditionField: 'Addresses.Region', conditionOperator: 'notEmpty',
      field: 'General.Language', comparison: 'eq', value: 'NL', severity: 'error'
    }, payload({ Language: 'FR' }, { Addresses: [{ Country: 'BE', Region: 'VBR' }] }), model)[0].message,
    /Addresses\.Region is not empty/u
  );
});
