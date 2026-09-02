'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONDITION_LOGIC, DEFAULT_CONDITION_LOGIC, conditionLogicOf, conditionLogicError,
  joinConditions, hasWildcard, wildcardMatches, normalisePattern, listMatches
} = require('../srv/checks/value-lists');
const { compare, runValidationRule, validateValidationRule } = require('../srv/checks/rule-engine');

// --- The `*` wildcard ------------------------------------------------------

test('a value with no wildcard still compares exactly, as it always did', () => {
  assert.equal(hasWildcard('FLVN01'), false);
  assert.equal(listMatches('FLVN01', 'FLVN01', compare), true);
  assert.equal(listMatches('FLVN01', 'FLVN00', compare), false);
});

test('a wildcard works anywhere in the value, not only at the end', () => {
  assert.equal(wildcardMatches('*01', 'FLVN01'), true);
  assert.equal(wildcardMatches('FL*01', 'FLVN01'), true);
  assert.equal(wildcardMatches('FL*N*1', 'FLVN01'), true);
  assert.equal(wildcardMatches('*', 'anything at all'), true);
  assert.equal(wildcardMatches('*01', 'FLVN02'), false);
});

// A regex metacharacter in a condition value must be data, not syntax - `A.C` is not `A?C`.
test('everything except the asterisk is escaped rather than interpreted', () => {
  assert.equal(wildcardMatches('A.C', 'ABC'), false);
  assert.equal(wildcardMatches('A.C', 'A.C'), true);
  assert.equal(wildcardMatches('A+C', 'A+C'), true);
  assert.equal(wildcardMatches('(x)', '(x)'), true);
});

// The duplicate engine holds NORMALISED values, and `alnumUpper` would strip the `*` out of a
// pattern normalised whole - the rule would then look for a role literally called FLVN.
test('a pattern is normalised segment by segment, keeping its wildcards', () => {
  const alnumUpper = (value) => String(value || '').replace(/[^\p{L}\p{N}]+/gu, '').toLocaleUpperCase();
  assert.equal(normalisePattern('flvn*', alnumUpper), 'FLVN*');
  assert.equal(normalisePattern('*01', alnumUpper), '*01');
  assert.equal(normalisePattern('a c*', alnumUpper), 'AC*');
  // The whole-value normalisation this exists to avoid.
  assert.equal(alnumUpper('flvn*'), 'FLVN');
});

test('each operator joins two conditions the way its name says', () => {
  const cases = [
    ['AND', [true, true], true], ['AND', [true, false], false], ['AND', [false, false], false],
    ['OR', [true, false], true], ['OR', [false, false], false], ['OR', [true, true], true],
    ['NOR', [false, false], true], ['NOR', [true, false], false], ['NOR', [true, true], false]
  ];
  for (const [logic, results, expected] of cases) {
    assert.equal(joinConditions(results, logic), expected, `${logic} ${JSON.stringify(results)}`);
  }
});

// Every row stored before 2026-08-27 has no logic column, and conditionsHold was `.every()`.
test('a stored row with no operator reads as AND', () => {
  assert.equal(conditionLogicOf(undefined), 'AND');
  assert.equal(conditionLogicOf(''), 'AND');
  assert.equal(joinConditions([true, false], null), false);
  assert.equal(joinConditions([true, true], null), true);
});

test('the operator is read case insensitively but refused when it is not one', () => {
  assert.equal(conditionLogicOf('or'), 'OR');
  assert.equal(conditionLogicOf(' NoR '), 'NOR');
  // Falls back for the engine, so a stored oddity can never crash a check...
  assert.equal(conditionLogicOf('XOR'), 'AND');
  // ...and is refused at the keyboard, so it cannot be stored in the first place.
  assert.match(conditionLogicError('XOR'), /is not a condition operator/u);
  assert.equal(conditionLogicError(''), null);
  assert.equal(conditionLogicError('NOR'), null);
});

/**
 * The whole reason `joinConditions` was generalised (2026-08-28, for WorkflowRules' dynamic
 * `conditions` column): three or more results, not just the two every OTHER rule table still has.
 * AND/OR fold naturally; NOR is "none of them" - `!results.some(Boolean)`, not a pairwise negation.
 */
test('AND, OR and NOR fold over three or more conditions, not just two', () => {
  assert.equal(joinConditions([true, true, true], 'AND'), true);
  assert.equal(joinConditions([true, true, false], 'AND'), false);
  assert.equal(joinConditions([false, false, true], 'OR'), true);
  assert.equal(joinConditions([false, false, false], 'OR'), false);
  assert.equal(joinConditions([false, false, false, false], 'NOR'), true);
  assert.equal(joinConditions([false, true, false, false], 'NOR'), false);
});

/**
 * `foldConditions` is the same join with ONE LOGIC PER GAP (2026-09-01), for a table that draws a
 * Logic column between every pair of conditions - WorkflowRules since it gained five slots. It has
 * to agree with `joinConditions` wherever the logic is uniform, or every rule saved before it
 * existed would start answering differently.
 */

// Left to right, no precedence: `A OR B AND C` is `(A OR B) AND C`, which is how the row reads.
test('foldConditions applies each gap its own logic, left to right', () => {
  const { foldConditions } = require('../srv/checks/value-lists');
  assert.equal(foldConditions([true, false, true], [null, 'OR', 'AND']), true);
  assert.equal(foldConditions([true, false, false], [null, 'OR', 'AND']), false);
  assert.equal(foldConditions([false, false, true], [null, 'AND', 'OR']), true);
  // An unrecognised or missing logic still reads as AND, the same fallback every stored row gets.
  assert.equal(foldConditions([true, true], [null, 'XOR']), true);
  assert.equal(foldConditions([true, false], [null, undefined]), false);
});

// --- Through the engine ----------------------------------------------------

const payload = (root = {}, sections = {}) => ({ root, sections });

// The same CSN stand-in shape test/quality-rule-engine.test.js uses: a small injected model keeps
// these tests about the engine rather than about the staging schema, which has its own tests.
const model = {
  definitions: {
    'mdmlight.staging.StagedGeneral': {
      elements: {
        ID: { type: 'cds.UUID' },
        request: { type: 'cds.Association', target: 'mdmlight.staging.ChangeRequests' },
        CorrespondenceLanguage: { type: 'cds.String' }
      }
    },
    'mdmlight.staging.StagedAddresses': {
      elements: {
        ID: { type: 'cds.UUID' },
        action: { type: 'cds.String' },
        Country: { type: 'cds.String' }
      }
    },
    'mdmlight.staging.StagedRoles': {
      elements: {
        ID: { type: 'cds.UUID' },
        action: { type: 'cds.String' },
        BusinessPartnerRole: { type: 'cds.String' }
      }
    }
  }
};

// A requester told "where A and B" about an OR rule has been told something untrue.
test('the message says which operator the rule actually used', () => {
  const rule = {
    conditionField: 'Addresses.Country',
    conditionValue: 'NL',
    conditionField2: 'BusinessPartnerRoles.BusinessPartnerRole',
    conditionValue2: 'FLVN*',
    field: 'General.CorrespondenceLanguage',
    comparison: 'notEmpty',
    severity: 'error',
    conditionLogic: 'OR'
  };
  const request = payload({}, {
    Addresses: [{ Country: 'BE' }],
    BusinessPartnerRoles: [{ BusinessPartnerRole: 'FLVN01' }]
  });

  const [finding] = runValidationRule(rule, request, model);
  assert.match(finding.message, / or /u);
  assert.doesNotMatch(finding.message, / and /u);
});

// --- Five condition slots, one Logic per gap (2026-09-01) ----------------------------------------
//
// Rolled out from WorkflowRules onto ValidationRules/DerivationRules the same day. Columns, not a
// composition - see db/quality-rules.cds for why that route is closed permanently.

test('a validation rule can carry five conditions, ANDed by default', () => {
  const rule = {
    conditionField: 'Addresses.Country', conditionValue: 'BE',
    conditionField2: 'BusinessPartnerRoles.BusinessPartnerRole', conditionValue2: 'FLCU01',
    conditionField3: 'Addresses.Country', conditionValue3: 'BE',
    conditionField4: 'BusinessPartnerRoles.BusinessPartnerRole', conditionValue4: 'FLCU01',
    conditionField5: 'Addresses.Country', conditionValue5: 'BE',
    field: 'General.CorrespondenceLanguage',
    comparison: 'notEmpty',
    severity: 'error'
  };
  const matching = {
    root: { CorrespondenceLanguage: '' },
    sections: { Addresses: [{ Country: 'BE' }], BusinessPartnerRoles: [{ BusinessPartnerRole: 'FLCU01' }] }
  };
  assert.equal(runValidationRule(rule, matching, model).length, 1, 'every condition holds, so it fires');
  const missing = {
    root: { CorrespondenceLanguage: '' },
    sections: { Addresses: [{ Country: 'BE' }], BusinessPartnerRoles: [{ BusinessPartnerRole: 'FLVN01' }] }
  };
  assert.equal(runValidationRule(rule, missing, model).length, 0, 'one failing condition is enough');
});

// A rule saved with two conditions has no later column filled in - it must read exactly as it did.
test('a rule saved before the extra slots existed is unchanged', () => {
  const rule = {
    conditionField: 'Addresses.Country', conditionValue: 'BE',
    conditionField2: 'BusinessPartnerRoles.BusinessPartnerRole', conditionValue2: 'FLCU01',
    field: 'General.CorrespondenceLanguage', comparison: 'notEmpty', severity: 'error'
  };
  const both = {
    root: { CorrespondenceLanguage: '' },
    sections: { Addresses: [{ Country: 'BE' }], BusinessPartnerRoles: [{ BusinessPartnerRole: 'FLCU01' }] }
  };
  assert.equal(runValidationRule(rule, both, model).length, 1);
});

// A condition value is a LIST on every rule table, not only on WorkflowRules (2026-09-01: "the
// plural conditionvalue can be reused on the other tables as well"). The column names stay
// singular - cds-deploy cannot rename one - but parseValueList is shared, so the behaviour is not.
test('a quality condition ORs across a delimited list', () => {
  const rule = {
    conditionField: 'Addresses.Country',
    conditionValue: 'BE|NL|FR',
    field: 'General.CorrespondenceLanguage',
    comparison: 'notEmpty',
    severity: 'error'
  };
  const request = (country) => payload({}, { Addresses: [{ Country: country }] });
  assert.equal(runValidationRule(rule, request('NL'), model).length, 1, 'any listed value fires it');
  assert.equal(runValidationRule(rule, request('DE'), model).length, 0, 'an unlisted one does not');
  // A single value is a one-entry list, so a rule saved before this reads exactly as it did.
  assert.equal(runValidationRule({ ...rule, conditionValue: 'BE' }, request('BE'), model).length, 1);
});
