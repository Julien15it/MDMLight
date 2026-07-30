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
    kind: 'collection'
  },
  {
    id: 'BusinessPartnerRoles',
    title: 'Roles',
    entitySet: 'BusinessPartnerRoles',
    remoteEntity: 'A_BusinessPartnerRole',
    relationField: 'BusinessPartner',
    typeName: 'A_BusinessPartnerRoleType',
    kind: 'collection'
  },
  {
    id: 'TaxNumbers',
    title: 'Tax Numbers',
    entitySet: 'TaxNumbers',
    remoteEntity: 'A_BusinessPartnerTaxNumber',
    relationField: 'BusinessPartner',
    typeName: 'A_BusinessPartnerTaxNumberType',
    kind: 'collection'
  },
  {
    id: 'BankDetails',
    title: 'Bank Details',
    entitySet: 'BankDetails',
    remoteEntity: 'A_BusinessPartnerBank',
    relationField: 'BusinessPartner',
    typeName: 'A_BusinessPartnerBankType',
    kind: 'collection'
  },
  {
    id: 'Identifications',
    title: 'Identifications',
    entitySet: 'Identifications',
    remoteEntity: 'A_BuPaIdentification',
    relationField: 'BusinessPartner',
    typeName: 'A_BuPaIdentificationType',
    kind: 'collection'
  },
  {
    id: 'Industries',
    title: 'Industries',
    entitySet: 'Industries',
    remoteEntity: 'A_BuPaIndustry',
    relationField: 'BusinessPartner',
    typeName: 'A_BuPaIndustryType',
    kind: 'collection'
  },
  {
    id: 'Customers',
    title: 'Customer Data',
    entitySet: 'Customers',
    remoteEntity: 'A_Customer',
    relationField: 'Customer',
    typeName: 'A_CustomerType',
    kind: 'single',
    creatable: false
  },
  {
    id: 'Suppliers',
    title: 'Supplier Data',
    entitySet: 'Suppliers',
    remoteEntity: 'A_Supplier',
    relationField: 'Supplier',
    typeName: 'A_SupplierType',
    kind: 'single',
    creatable: false
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
    .filter(([, element]) => !element.target)
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
        creatable: property['sap:creatable'] !== 'false',
        updatable: property['sap:updatable'] !== 'false'
      };
    });
}

const output = [
  'sap.ui.define([], function () {',
  '  "use strict";',
  '',
  `  return ${JSON.stringify({ sections }, null, 2).replace(/^/gmu, '  ')};`,
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
