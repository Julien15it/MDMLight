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

// The case from the request: one condition covering a whole family of roles.
test('a trailing wildcard matches every role in the family', () => {
  assert.equal(listMatches('FLVN*', 'FLVN01', compare), true);
  assert.equal(listMatches('FLVN*', 'FLVN00', compare), true);
  assert.equal(listMatches('FLVN*', 'FLCU01', compare), false);
});

test('a wildcard works anywhere in the value, not only at the end', () => {
  assert.equal(wildcardMatches('*01', 'FLVN01'), true);
  assert.equal(wildcardMatches('FL*01', 'FLVN01'), true);
  assert.equal(wildcardMatches('FL*N*1', 'FLVN01'), true);
  assert.equal(wildcardMatches('*', 'anything at all'), true);
  assert.equal(wildcardMatches('*01', 'FLVN02'), false);
});

// Anchored, or `FLVN*` would also match a role that merely CONTAINS it.
test('a pattern is anchored at both ends', () => {
  assert.equal(wildcardMatches('FLVN', 'XFLVN01'), false);
  assert.equal(wildcardMatches('VN*', 'FLVN01'), false);
});

test('the pattern is case insensitive, like the tables own text comparison', () => {
  assert.equal(wildcardMatches('flvn*', 'FLVN01'), true);
  assert.equal(listMatches('be*', 'BE0448207405', compare), true);
});

// A regex metacharacter in a condition value must be data, not syntax - `A.C` is not `A?C`.
test('everything except the asterisk is escaped rather than interpreted', () => {
  assert.equal(wildcardMatches('A.C', 'ABC'), false);
  assert.equal(wildcardMatches('A.C', 'A.C'), true);
  assert.equal(wildcardMatches('A+C', 'A+C'), true);
  assert.equal(wildcardMatches('(x)', '(x)'), true);
});

test('a wildcard is one entry of a list, alongside exact ones', () => {
  assert.equal(listMatches('FLCU01|FLVN*', 'FLVN00', compare), true);
  assert.equal(listMatches('FLCU01|FLVN*', 'FLCU01', compare), true);
  assert.equal(listMatches('FLCU01|FLVN*', 'BUP001', compare), false);
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

// --- AND / OR / NOR --------------------------------------------------------

test('the three operators are what the tables offer, and AND is the default', () => {
  assert.deepEqual(Object.keys(CONDITION_LOGIC), ['AND', 'OR', 'NOR']);
  assert.equal(DEFAULT_CONDITION_LOGIC, 'AND');
  // Short labels, no description: the column is titleless and sits between the two conditions.
  for (const [code, logic] of Object.entries(CONDITION_LOGIC)) assert.equal(logic.text, code);
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

// One condition has nothing to be joined to, and NOR would silently invert it.
test('the operator only applies when both conditions are filled', () => {
  assert.equal(joinConditions([true], 'NOR'), true);
  assert.equal(joinConditions([false], 'NOR'), false);
  assert.equal(joinConditions([], 'NOR'), true, 'no condition means the rule always applies');
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
test('foldConditions matches joinConditions whenever one logic covers every gap', () => {
  const { foldConditions } = require('../srv/checks/value-lists');
  for (const logic of ['AND', 'OR', null]) {
    for (const results of [[], [true], [false], [true, false], [false, true], [true, true, false]]) {
      assert.equal(
        foldConditions(results, results.map(() => logic)),
        joinConditions(results, logic),
        `${logic} ${JSON.stringify(results)}`
      );
    }
  }
  // NOR too, up to the two-condition case the pairwise version was written for.
  assert.equal(foldConditions([true], [null]), true, 'a lone condition is itself, never inverted');
  assert.equal(foldConditions([false, false], [null, 'NOR']), true);
  assert.equal(foldConditions([false, true], [null, 'NOR']), false);
});

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

test('a rule carrying an unusable operator does not save', () => {
  const model = { definitions: {} };
  const errors = validateValidationRule({ conditionLogic: 'MAYBE' }, model).errors;
  assert.equal(errors.some((error) => error.field === 'conditionLogic'), true);
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

test('OR fires when only the second condition holds, where AND would not', () => {
  const rule = {
    conditionField: 'Addresses.Country',
    conditionValue: 'NL',
    conditionField2: 'BusinessPartnerRoles.BusinessPartnerRole',
    conditionValue2: 'FLVN*',
    field: 'General.CorrespondenceLanguage',
    comparison: 'notEmpty',
    severity: 'error'
  };
  const request = payload({}, {
    Addresses: [{ Country: 'BE' }],
    BusinessPartnerRoles: [{ BusinessPartnerRole: 'FLVN01' }]
  });

  assert.equal(runValidationRule({ ...rule, conditionLogic: 'AND' }, request, model).length, 0);
  assert.equal(runValidationRule({ ...rule, conditionLogic: 'OR' }, request, model).length, 1);
  assert.equal(runValidationRule({ ...rule, conditionLogic: 'NOR' }, request, model).length, 0);
});

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

// Left to right, no precedence: `A OR B AND C` is `(A OR B) AND C`, which is how the row reads.
test('each Logic column joins its own pair, folded left to right', () => {
  const rule = {
    conditionField: 'Addresses.Country', conditionValue: 'BE',
    conditionLogic: 'OR',
    conditionField2: 'Addresses.Country', conditionValue2: 'NL',
    conditionLogic2: 'AND',
    conditionField3: 'BusinessPartnerRoles.BusinessPartnerRole', conditionValue3: 'FLCU01',
    field: 'General.CorrespondenceLanguage',
    comparison: 'notEmpty',
    severity: 'error'
  };
  const payload = (country, role) => ({
    root: { CorrespondenceLanguage: '' },
    sections: { Addresses: [{ Country: country }], BusinessPartnerRoles: [{ BusinessPartnerRole: role }] }
  });
  assert.equal(runValidationRule(rule, payload('NL', 'FLCU01'), model).length, 1, 'NL satisfies the OR');
  assert.equal(runValidationRule(rule, payload('NL', 'FLVN01'), model).length, 0, 'the trailing AND still has to hold');
  assert.equal(runValidationRule(rule, payload('FR', 'FLCU01'), model).length, 0, 'neither side of the OR holds');
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

// Half a condition is the dangerous half in the new slots too, and so is an unrecognised logic.
test('every slot validates, and so does every Logic column', () => {
  const errors = validateValidationRule({
    field: 'General.CorrespondenceLanguage',
    comparison: 'eq',
    value: 'NL',
    conditionField5: 'Addresses.Country',
    conditionLogic3: 'MAYBE'
  }, model).errors;
  assert.equal(errors.some((error) => error.field === 'conditionValue5'), true, 'a field with no value is refused');
  assert.equal(errors.some((error) => error.field === 'conditionLogic3'), true, 'and so is an unusable logic');
});
