'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const externalRoot = path.join(projectRoot, 'srv', 'external');
const csn = JSON.parse(
  fs.readFileSync(path.join(externalRoot, 'API_BUSINESS_PARTNER.csn'), 'utf8')
);
const edmx = fs.readFileSync(
  path.join(externalRoot, 'API_BUSINESS_PARTNER.edmx'),
  'utf8'
);

const sections = [
  {
    id: 'BusinessPartners',
    title: 'General Information',
    entitySet: 'BusinessPartners',
    remoteEntity: 'A_BusinessPartner',
    relationField: 'BusinessPartner',
    typeName: 'A_BusinessPartnerType',
    kind: 'root'
  },
  {
    id: 'Addresses',
    title: 'Addresses',
    entitySet: 'Addresses',
    remoteEntity: 'A_BusinessPartnerAddress',
    relationField: 'BusinessPartner',
    typeName: 'A_BusinessPartnerAddressType',
    kind: 'collection',
    fieldNames: [
      'BusinessPartner', 'AddressID', 'StreetName', 'HouseNumber',
      'PostalCode', 'CityName', 'Country', 'Region', 'POBox'
    ],
    summaryFields: [
      'StreetName', 'HouseNumber', 'PostalCode', 'CityName', 'Country', 'Region', 'POBox'
    ],
    requiredCreateFields: ['Country']
  },
  {
    id: 'BusinessPartnerRoles',
    title: 'Roles',
    entitySet: 'BusinessPartnerRoles',
    remoteEntity: 'A_BusinessPartnerRole',
    relationField: 'BusinessPartner',
    typeName: 'A_BusinessPartnerRoleType',
    kind: 'collection',
    fieldNames: ['BusinessPartner', 'BusinessPartnerRole', 'ValidFrom', 'ValidTo'],
    summaryFields: ['BusinessPartnerRole', 'ValidFrom', 'ValidTo'],
    requiredCreateFields: ['BusinessPartnerRole']
  },
  {
    id: 'TaxNumbers',
    title: 'Tax Numbers',
    entitySet: 'TaxNumbers',
    remoteEntity: 'A_BusinessPartnerTaxNumber',
    relationField: 'BusinessPartner',
    typeName: 'A_BusinessPartnerTaxNumberType',
    kind: 'collection',
    fieldNames: ['BusinessPartner', 'BPTaxType', 'BPTaxNumber', 'BPTaxLongNumber'],
    summaryFields: ['BPTaxType', 'BPTaxNumber', 'BPTaxLongNumber'],
    requiredCreateFields: ['BPTaxType'],
    oneOfCreateFields: ['BPTaxNumber', 'BPTaxLongNumber']
  },
  {
    id: 'BankDetails',
    title: 'Bank Details',
    entitySet: 'BankDetails',
    remoteEntity: 'A_BusinessPartnerBank',
    relationField: 'BusinessPartner',
    typeName: 'A_BusinessPartnerBankType',
    kind: 'collection',
    fieldNames: [
      'BusinessPartner', 'BankIdentification', 'BankName', 'BankCountryKey',
      'BankNumber', 'SWIFTCode', 'BankAccountHolderName', 'BankAccountName',
      'IBAN', 'BankAccount', 'CityName'
    ],
    summaryFields: [
      'BankName', 'BankCountryKey', 'BankNumber', 'IBAN', 'BankAccount', 'CityName'
    ],
    requiredCreateFields: ['BankIdentification'],
    oneOfCreateFields: ['IBAN', 'BankAccount']
  },
  {
    id: 'Identifications',
    title: 'Identifications',
    entitySet: 'Identifications',
    remoteEntity: 'A_BuPaIdentification',
    relationField: 'BusinessPartner',
    typeName: 'A_BuPaIdentificationType',
    kind: 'collection',
    fieldNames: [
      'BusinessPartner', 'BPIdentificationType', 'BPIdentificationNumber',
      'BPIdnNmbrIssuingInstitute', 'BPIdentificationEntryDate', 'Country', 'Region'
    ],
    summaryFields: [
      'BPIdentificationType', 'BPIdentificationNumber',
      'BPIdnNmbrIssuingInstitute', 'Country', 'Region'
    ],
    requiredCreateFields: ['BPIdentificationType', 'BPIdentificationNumber']
  },
  {
    id: 'Industries',
    title: 'Industries',
    entitySet: 'Industries',
    remoteEntity: 'A_BuPaIndustry',
    relationField: 'BusinessPartner',
    typeName: 'A_BuPaIndustryType',
    kind: 'collection',
    fieldNames: [
      'BusinessPartner', 'IndustrySector', 'IndustrySystemType',
      'IsStandardIndustry', 'IndustryKeyDescription'
    ],
    summaryFields: [
      'IndustrySector', 'IndustrySystemType', 'IndustryKeyDescription', 'IsStandardIndustry'
    ],
    requiredCreateFields: ['IndustrySector', 'IndustrySystemType']
  },
  {
    id: 'Customers',
    title: 'Customer Data',
    entitySet: 'Customers',
    remoteEntity: 'A_Customer',
    relationField: 'Customer',
    typeName: 'A_CustomerType',
    kind: 'single',
    creatable: false,
    deletable: false,
    fieldNames: [
      'Customer', 'CustomerFullName', 'CustomerName', 'CustomerAccountGroup',
      'CustomerClassification', 'BillingIsBlockedForCustomer',
      'DeliveryIsBlocked', 'OrderIsBlockedForCustomer', 'PostingIsBlocked'
    ],
    summaryFields: [
      'CustomerFullName', 'CustomerAccountGroup', 'CustomerClassification',
      'BillingIsBlockedForCustomer', 'DeliveryIsBlocked', 'PostingIsBlocked'
    ],
    excludedFields: ['BR_ICMSTaxPayerType']
  },
  {
    id: 'Suppliers',
    title: 'Supplier Data',
    entitySet: 'Suppliers',
    remoteEntity: 'A_Supplier',
    relationField: 'Supplier',
    typeName: 'A_SupplierType',
    kind: 'single',
    creatable: false,
    deletable: false,
    fieldNames: [
      'Supplier', 'SupplierFullName', 'SupplierName', 'SupplierAccountGroup',
      'PaymentIsBlockedForSupplier', 'PostingIsBlocked', 'PurchasingIsBlocked',
      'SupplierProcurementBlock', 'VATRegistration'
    ],
    summaryFields: [
      'SupplierFullName', 'SupplierAccountGroup', 'VATRegistration',
      'PaymentIsBlockedForSupplier', 'PostingIsBlocked', 'PurchasingIsBlocked'
    ],
    excludedFields: [
      'BusinessPartnerPanNumber',
      'JP_SuplrAmtInCapitalAmount',
      'JP_SupplierCapitalAmountCrcy'
    ]
  },
  {
    id: 'CustomerCompany',
    title: 'Customer Company Code Data',
    entitySet: 'CustomerCompany',
    remoteEntity: 'A_CustomerCompany',
    relationField: 'Customer',
    typeName: 'A_CustomerCompanyType',
    kind: 'collection',
    fieldNames: [
      'Customer', 'CompanyCode', 'ReconciliationAccount', 'PaymentTerms',
      'PaymentMethodsList', 'PaymentBlockingReason', 'HouseBank',
      'AccountingClerk', 'CustomerAccountNote'
    ],
    summaryFields: [
      'CompanyCode', 'ReconciliationAccount', 'PaymentTerms', 'PaymentBlockingReason', 'HouseBank'
    ],
    requiredCreateFields: ['CompanyCode']
  },
  {
    id: 'SupplierCompany',
    title: 'Supplier Company Code Data',
    entitySet: 'SupplierCompany',
    remoteEntity: 'A_SupplierCompany',
    relationField: 'Supplier',
    typeName: 'A_SupplierCompanyType',
    kind: 'collection',
    fieldNames: [
      'Supplier', 'CompanyCode', 'CompanyCodeName', 'ReconciliationAccount',
      'PaymentTerms', 'PaymentMethodsList', 'PaymentBlockingReason', 'HouseBank',
      'AccountingClerk'
    ],
    summaryFields: [
      'CompanyCode', 'CompanyCodeName', 'ReconciliationAccount', 'PaymentTerms', 'PaymentBlockingReason'
    ],
    requiredCreateFields: ['CompanyCode']
  }
];

function attributes(source) {
  return Object.fromEntries(
    [...source.matchAll(/([\w:-]+)="([^"]*)"/gu)].map((match) => [match[1], match[2]])
  );
}

function entityTypeProperties(typeName) {
  const escapedName = typeName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const block = edmx.match(
    new RegExp(`<EntityType Name="${escapedName}"[\\s\\S]*?<\\/EntityType>`, 'u')
  );
  if (!block) throw new Error(`Entity type ${typeName} was not found in the EDMX.`);

  return Object.fromEntries(
    [...block[0].matchAll(/<Property\s+([\s\S]*?)\/>/gu)].map((match) => {
      const property = attributes(match[1]);
      return [property.Name, property];
    })
  );
}

// Keys S/4 assigns itself on create. The imported metadata marks AddressID creatable, so the create
// form asked for an address number that the system generates a moment later and that
// `addDefaultAddressUsage` strips from the payload anyway. `creatable: false` is the flag
// `_createForm` already keys off to hide a key field on create.
// Deliberately not the MDG "$" convention: this path posts to API_BUSINESS_PARTNER, not to MDG
// staging, so the field is omitted rather than filled with a placeholder S/4 would take literally.
const SERVER_ASSIGNED_KEYS = new Set(['AddressID']);

function humanize(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/\bBP\b/gu, 'Business Partner')
    .replace(/\bNmbr\b/gu, 'Number')
    .replace(/\bPrfrd\b/gu, 'Preferred')
    .replace(/\bSuplr\b/gu, 'Supplier');
}

for (const section of sections) {
  const definition = csn.definitions[`API_BUSINESS_PARTNER.${section.remoteEntity}`];
  const edmxProperties = entityTypeProperties(section.typeName);

  section.fields = Object.entries(definition.elements)
    .filter(([name, element]) => (
      !element.target &&
      !(section.excludedFields || []).includes(name) &&
      (!section.fieldNames || section.fieldNames.includes(name))
    ))
    .map(([name, element]) => {
      const property = edmxProperties[name] || {};
      return {
        name,
        label: property['sap:label'] || humanize(name),
        type: element.type,
        key: Boolean(element.key),
        nullable: element.notNull !== true,
        maxLength: element.length,
        precision: element.precision,
        scale: element.scale,
        creatable: property['sap:creatable'] !== 'false' && !SERVER_ASSIGNED_KEYS.has(name),
        updatable: property['sap:updatable'] !== 'false'
      };
    });
}

const clientSections = sections.map(({ excludedFields, fieldNames, ...section }) => section);

const output = [
  'sap.ui.define([], function () {',
  '  "use strict";',
  '',
  `  return ${JSON.stringify({ sections: clientSections }, null, 2).replace(/^/gmu, '  ')};`,
  '});',
  ''
].join('\n');

const target = path.join(
  projectRoot,
  'app',
  'businesspartner',
  'webapp',
  'ext',
  'BusinessPartnerMetadata.js'
);
fs.writeFileSync(target, output, 'utf8');
console.log(`Generated ${target}`);
