'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFieldLengthStages, _internals } = require('../srv/checks/field-lengths');
const { PAYLOAD_NODES } = require('../srv/checks/payload-fields');

/**
 * Reported live 2026-09-04: a create request passed checkRequest twice and answered submitRequest
 * with a bare 500 - `value too long for type character varying(3)` on
 * StagedCustomerTaxGrouping.CustomerTaxGroupingCode, from a 4-character value in a 3-character
 * field. The staged lengths mirror API_BUSINESS_PARTNER's own, so S/4 would have refused it too.
 */

// Only the two entities these cases touch. Keyed by PAYLOAD_NODES so a renamed entity fails here.
const model = {
  definitions: {
    [PAYLOAD_NODES.CustomerTaxGrouping.entity]: {
      elements: {
        ID: { type: 'cds.UUID' },
        request: { type: 'cds.Association', target: 'ChangeRequests' },
        action: { type: 'cds.String', length: 1 },
        CustomerTaxGroupingCode: { type: 'cds.String', length: 3 },
        CustTaxGrpExemptionCertificate: { type: 'cds.String', length: 15 },
        CustTaxGroupExemptionRate: { type: 'cds.Decimal', length: 5 },
        CustTaxGroupExemptionStartDate: { type: 'cds.Date' }
      }
    },
    [PAYLOAD_NODES.General.entity]: {
      elements: {
        OrganizationBPName1: { type: 'cds.String', length: 40 }
      }
    }
  }
};

const run = (payload) => createFieldLengthStages({ model }).validations[0].run(payload);

test('a value one character over its length is refused, naming the field and both numbers', async () => {
  const findings = await run({
    root: {},
    sections: { CustomerTaxGrouping: [{ CustomerTaxGroupingCode: 'MWST' }] }
  });

  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.severity, 'error');
  assert.equal(finding.target, 'CustomerTaxGrouping');
  assert.equal(finding.index, 0);
  assert.equal(finding.field, 'CustomerTaxGroupingCode');
  // The section the requester sees, not the entity, and both numbers so they can act on it.
  assert.match(finding.message, /Customer Tax Grouping: Customer Tax Grouping Code/u);
  assert.match(finding.message, /4 characters/u);
  assert.match(finding.message, /maximum is 3/u);
});

test('a value at its length, an empty one and a missing one all pass', async () => {
  for (const value of ['MWS', '', '   ', null, undefined]) {
    const findings = await run({
      sections: { CustomerTaxGrouping: [{ CustomerTaxGroupingCode: value }] }
    });
    assert.deepEqual(findings, [], `${JSON.stringify(value)} must pass`);
  }
});

test('the offending ROW is named, not just the section', async () => {
  const findings = await run({
    sections: {
      CustomerTaxGrouping: [
        { CustomerTaxGroupingCode: 'MWS' },
        { CustomerTaxGroupingCode: 'MWST' }
      ]
    }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].index, 1);
});

/**
 * A `length` on anything but a string is not a character count - Decimal's is a precision and Date
 * has none - so measuring either would refuse a value nothing rejects.
 */
test('only string elements are measured', async () => {
  const findings = await run({
    sections: {
      CustomerTaxGrouping: [{
        CustTaxGroupExemptionRate: 123456789,
        CustTaxGroupExemptionStartDate: '2026-09-04'
      }]
    }
  });
  assert.deepEqual(findings, []);
});

test('action and the keys are never measured', async () => {
  const findings = await run({
    sections: { CustomerTaxGrouping: [{ action: 'CCCC', ID: 'a-uuid-far-longer-than-one' }] }
  });
  assert.deepEqual(findings, []);
});

test('the root is measured too, and reports as `root`', async () => {
  const findings = await run({ root: { OrganizationBPName1: 'x'.repeat(41) }, sections: {} });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].target, 'root');
  assert.equal(findings[0].index, 0);
});

test('a section the payload does not carry contributes nothing', async () => {
  assert.deepEqual(await run({}), []);
  assert.deepEqual(await run({ root: {}, sections: {} }), []);
});

test('measuredElements skips associations and non-strings', () => {
  const measured = _internals.measuredElements('CustomerTaxGrouping', model).map((e) => e.element);
  assert.deepEqual(measured.sort(), ['CustTaxGrpExemptionCertificate', 'CustomerTaxGroupingCode']);
});
