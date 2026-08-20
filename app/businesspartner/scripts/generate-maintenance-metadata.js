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
    creatable: true,
    deletable: false,
    // Rendered inside this section's Details dialog instead of as Object Page blocks of
    // their own - one block per role on the page, everything else behind Details, as the
    // standard MDG ERP Customer screen does it.
    // Ordered as the MDG screen orders them: Tax Categories, then Company Codes, then
    // Sales Areas.
    childSections: [
      'CustomerText', 'CustomerAddressExtIdentifier', 'CustomerAddressInfo',
      'CustomerTaxGrouping', 'CustomerCompany', 'CustomerCompanyText', 'CustomerDunning',
      'CustomerWithholdingTax', 'CustomerSalesArea', 'CustomerTaxIndicators',
      'CustomerSalesAreaText', 'CustomerSalesPartnerFunctions',
      'CustomerSalesAreaAddressInfo', 'CustomerUnloadingPoint',
      'CustomerUnloadingPointAddressInfo'
    ],
    // Grouped rather than one flat wall of 50 inputs, mirroring how the standard MDG
    // "ERP Customer" screen splits the same data into Control Data / Tax Information /
    // Additional Data blocks. `fieldNames` is derived from these below, so a field added
    // to a group is automatically fetched too - the two can never drift apart.
    // Block names and order follow the S/4 MDG "ERP Customer" screen: Control Data first,
    // then Tax Information, with Additional Data last before the child tables.
    //
    // It cannot match field for field. MDG draws on the MDG staging model, this app on
    // API_BUSINESS_PARTNER, and A_Customer simply does not carry Trading Partner, Location
    // Code, SubTrib Group, Type of Business, Representative's Name, Liable for VAT, Sales
    // Equalization Tax, ICMS/IPI-Exempt, CFOP Category, Type of Industry, DME Indicator,
    // Instruction Key, Alternative Payer, the Condition Groups or any Export Data field.
    // Those blocks are therefore absent rather than empty. Conversely A_Customer carries
    // fields MDG shows elsewhere (VAT number, Tax Number 1-5, the industry codes), which
    // are grouped here by what they are.
    fieldGroups: [
      {
        title: 'Control Data',
        fields: [
          'Customer', 'CustomerAccountGroup', 'CustomerFullName', 'CustomerName',
          'CustomerClassification', 'CustomerCorporateGroup', 'AuthorizationGroup',
          'CreatedByUser', 'CreationDate'
        ]
      },
      {
        title: 'Tax Information',
        fields: [
          'VATRegistration', 'TaxNumberType', 'TaxNumber1', 'TaxNumber2', 'TaxNumber3',
          'TaxNumber4', 'TaxNumber5', 'FiscalAddress', 'CityCode', 'County',
          'ResponsibleType', 'NFPartnerIsNaturalPerson'
        ]
      },
      {
        title: 'Industry',
        fields: [
          'Industry', 'IndustryCode1', 'IndustryCode2', 'IndustryCode3',
          'IndustryCode4', 'IndustryCode5', 'NielsenRegion'
        ]
      },
      {
        title: 'Reference Data',
        fields: [
          'Supplier', 'PaymentReason', 'ExpressTrainStationName', 'TrainStationName',
          'InternationalLocationNumber1', 'InternationalLocationNumber2',
          'InternationalLocationNumber3'
        ]
      },
      {
        title: 'Blocks and Status',
        fields: [
          'BillingIsBlockedForCustomer', 'DeliveryIsBlocked', 'OrderIsBlockedForCustomer',
          'PostingIsBlocked', 'DeletionIndicator'
        ]
      },
      {
        title: 'Additional Data',
        fields: [
          'FreeDefinedAttribute01', 'FreeDefinedAttribute02', 'FreeDefinedAttribute03',
          'FreeDefinedAttribute04', 'FreeDefinedAttribute05', 'FreeDefinedAttribute06',
          'FreeDefinedAttribute07', 'FreeDefinedAttribute08', 'FreeDefinedAttribute09',
          'FreeDefinedAttribute10'
        ]
      }
    ],
    summaryFields: [
      'CustomerFullName', 'CustomerAccountGroup', 'CustomerClassification',
      'BillingIsBlockedForCustomer', 'DeliveryIsBlocked', 'PostingIsBlocked'
    ],
    // Not exposed by the VF on-premise implementation - see the drift warning in
    // srv/metadata-drift.js. Requesting it makes the whole section read fail.
    excludedFields: ['BR_ICMSTaxPayerType', 'BPCustomerFullName', 'BPCustomerName'],
    requiredCreateFields: ['CustomerAccountGroup']
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
      'AccountingClerk', 'CustomerAccountNote',
      // MDG shows this under the customer's Payment Transactions; in
      // API_BUSINESS_PARTNER it is company-code level.
      'AlternativePayerAccount'
    ],
    summaryFields: [
      'CompanyCode', 'ReconciliationAccount', 'PaymentTerms', 'PaymentBlockingReason', 'HouseBank'
    ],
    requiredCreateFields: ['CompanyCode']
  },
  {
    id: 'CustomerSalesArea',
    title: 'Customer Sales Area Data',
    entitySet: 'CustomerSalesArea',
    remoteEntity: 'A_CustomerSalesArea',
    relationField: 'Customer',
    typeName: 'A_CustomerSalesAreaType',
    kind: 'collection',
    fieldNames: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division',
      'CreditControlArea', 'Currency', 'CustomerPriceGroup', 'CustomerPricingProcedure',
      'CustomerPaymentTerms', 'DeliveryPriority', 'ShippingCondition', 'BillingIsBlockedForCustomer',
      // KNVV.KVGR1-5, "Customer Group 1-5". NOT the MDG screen's "Condition Group 1-5",
      // which is KNA1.KDKG1-5 ("Customer condition group") - a different field at
      // customer level that API_BUSINESS_PARTNER does not expose at all. Checked against
      // the system's own data dictionary; an earlier revision of this file claimed
      // otherwise and was wrong.
      'AdditionalCustomerGroup1', 'AdditionalCustomerGroup2', 'AdditionalCustomerGroup3',
      'AdditionalCustomerGroup4', 'AdditionalCustomerGroup5'
    ],
    summaryFields: [
      'SalesOrganization', 'DistributionChannel', 'Division', 'CreditControlArea', 'Currency', 'CustomerPaymentTerms'
    ],
    requiredCreateFields: ['SalesOrganization', 'DistributionChannel', 'Division']
  },
  {
    // The MDG screen's "ERP Customer: Tax Categories" block, field for field.
    id: 'CustomerTaxGrouping',
    title: 'Customer Tax Categories',
    entitySet: 'CustomerTaxGrouping',
    remoteEntity: 'A_CustomerTaxGrouping',
    relationField: 'Customer',
    typeName: 'A_CustomerTaxGroupingType',
    kind: 'collection',
    fieldNames: [
      'Customer', 'CustomerTaxGroupingCode', 'CustTaxGroupSubjectedStartDate',
      'CustTaxGroupSubjectedEndDate', 'CustTaxGrpExemptionCertificate',
      'CustTaxGroupExemptionRate', 'CustTaxGroupExemptionStartDate',
      'CustTaxGroupExemptionEndDate'
    ],
    summaryFields: [
      'CustomerTaxGroupingCode', 'CustTaxGroupSubjectedStartDate',
      'CustTaxGroupSubjectedEndDate', 'CustTaxGrpExemptionCertificate',
      'CustTaxGroupExemptionRate'
    ],
    requiredCreateFields: ['CustomerTaxGroupingCode']
  },
  {
    // The MDG screen's "ERP Customer: Tax Indicators" block. Posted under
    // A_CustomerSalesArea(Customer=…,SalesOrganization=…,DistributionChannel=…,Division=…) -
    // businessPartnerNavigationPath addresses that through parentKeyFields.
    id: 'CustomerTaxIndicators',
    title: 'Customer Tax Indicators',
    entitySet: 'A_CustomerSalesAreaTax',
    remoteEntity: 'A_CustomerSalesAreaTax',
    relationField: 'Customer',
    typeName: 'A_CustomerSalesAreaTaxType',
    kind: 'collection',
    requiredCreateFields: [
      'SalesOrganization', 'DistributionChannel', 'Division',
      'DepartureCountry', 'CustomerTaxCategory'
    ],
    emptyText: 'No tax indicators for this customer.',
    fieldNames: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division',
      'DepartureCountry', 'CustomerTaxCategory', 'CustomerTaxClassification'
    ],
    summaryFields: [
      'DepartureCountry', 'CustomerTaxCategory', 'CustomerTaxClassification',
      'SalesOrganization', 'DistributionChannel', 'Division'
    ]
  },
  {
    id: 'Suppliers',
    title: 'Supplier Data',
    entitySet: 'Suppliers',
    remoteEntity: 'A_Supplier',
    relationField: 'Supplier',
    typeName: 'A_SupplierType',
    kind: 'single',
    creatable: true,
    deletable: false,
    // See the Customers section above.
    childSections: [
      'SupplierText', 'SupplierCompany', 'SupplierCompanyText', 'SupplierDunning',
      'SupplierWithholdingTax', 'SupplierPurchasingOrg', 'SupplierPurchasingOrgText',
      'SupplierPartnerFunctions'
    ],
    // See the Customers section above for why these are grouped.
    // Same ordering as Customers above, and the same caveat about MDG-only fields.
    fieldGroups: [
      {
        title: 'Control Data',
        fields: [
          'Supplier', 'SupplierAccountGroup', 'SupplierFullName', 'SupplierName',
          'SupplierCorporateGroup', 'AuthorizationGroup', 'CreatedByUser', 'CreationDate'
        ]
      },
      {
        title: 'Tax Information',
        fields: [
          'VATRegistration', 'TaxNumberType', 'TaxNumber1', 'TaxNumber2', 'TaxNumber3',
          'TaxNumber4', 'TaxNumber5', 'TaxNumberResponsible', 'FiscalAddress',
          'ResponsibleType', 'IsNaturalPerson', 'BR_TaxIsSplit'
        ]
      },
      {
        title: 'Quality Management',
        fields: [
          'SuplrQualityManagementSystem', 'SuplrQltyInProcmtCertfnValidTo',
          'SuplrProofOfDelivRlvtCode'
        ]
      },
      {
        title: 'Reference Data',
        fields: [
          'Customer', 'Industry', 'AlternativePayeeAccountNumber', 'PaymentReason',
          'DataExchangeInstructionKey', 'BirthDate', 'ConcatenatedInternationalLocNo',
          'InternationalLocationNumber1', 'InternationalLocationNumber2',
          'InternationalLocationNumber3'
        ]
      },
      {
        title: 'Blocks and Status',
        fields: [
          'PaymentIsBlockedForSupplier', 'PostingIsBlocked', 'PurchasingIsBlocked',
          'SupplierProcurementBlock', 'DeletionIndicator'
        ]
      }
    ],
    summaryFields: [
      'SupplierFullName', 'SupplierAccountGroup', 'VATRegistration',
      'PaymentIsBlockedForSupplier', 'PostingIsBlocked', 'PurchasingIsBlocked'
    ],
    // Not exposed by the VF on-premise implementation - see the drift warning in
    // srv/metadata-drift.js. Requesting them makes the whole section read fail.
    excludedFields: [
      'BusinessPartnerPanNumber',
      'JP_SuplrAmtInCapitalAmount',
      'JP_SupplierCapitalAmountCrcy'
    ],
    requiredCreateFields: ['SupplierAccountGroup']
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
  },
  {
    id: 'SupplierPurchasingOrg',
    title: 'Supplier Purchasing Organization Data',
    entitySet: 'SupplierPurchasingOrg',
    remoteEntity: 'A_SupplierPurchasingOrg',
    relationField: 'Supplier',
    typeName: 'A_SupplierPurchasingOrgType',
    kind: 'collection',
    fieldNames: [
      'Supplier', 'PurchasingOrganization', 'PurchasingGroup', 'PaymentTerms',
      'PurchaseOrderCurrency', 'IncotermsClassification', 'MinimumOrderAmount',
      'PurchasingIsBlockedForSupplier', 'InvoiceIsGoodsReceiptBased'
    ],
    summaryFields: [
      'PurchasingOrganization', 'PurchasingGroup', 'PaymentTerms', 'PurchaseOrderCurrency', 'PurchasingIsBlockedForSupplier'
    ],
    requiredCreateFields: ['PurchasingOrganization']
  },
  {
    id: 'CustomerText',
    title: 'Customer Texts',
    entitySet: 'A_CustomerText',
    remoteEntity: 'A_CustomerText',
    relationField: 'Customer',
    typeName: 'A_CustomerTextType',
    kind: 'collection',
    emptyText: 'No texts for this customer.',
    fieldNames: ['Customer', 'Language', 'LongTextID', 'LongText'],
    summaryFields: ['Language', 'LongTextID', 'LongText'],
    requiredCreateFields: ['Language', 'LongTextID']
  },
  {
    id: 'CustomerAddressExtIdentifier',
    title: 'Customer Address External Identifiers',
    entitySet: 'A_CustAddrDepdntExtIdentifier',
    remoteEntity: 'A_CustAddrDepdntExtIdentifier',
    relationField: 'Customer',
    typeName: 'A_CustAddrDepdntExtIdentifierType',
    kind: 'collection',
    emptyText: 'No address-dependent external identifiers for this customer.',
    fieldNames: ['Customer', 'AddressID', 'CustomerExternalRefID'],
    summaryFields: ['AddressID', 'CustomerExternalRefID'],
    requiredCreateFields: ['AddressID']
  },
  {
    id: 'CustomerAddressInfo',
    title: 'Customer Address-Dependent Information',
    entitySet: 'A_CustAddrDepdntInformation',
    remoteEntity: 'A_CustAddrDepdntInformation',
    relationField: 'Customer',
    typeName: 'A_CustAddrDepdntInformationType',
    kind: 'collection',
    emptyText: 'No address-dependent information for this customer.',
    fieldNames: [
      'Customer', 'AddressID', 'ExpressTrainStationName', 'TrainStationName', 'CityCode',
      'County'
    ],
    summaryFields: ['AddressID', 'CityCode', 'County', 'TrainStationName'],
    requiredCreateFields: ['AddressID']
  },
  {
    id: 'CustomerCompanyText',
    title: 'Customer Company Code Texts',
    entitySet: 'A_CustomerCompanyText',
    remoteEntity: 'A_CustomerCompanyText',
    relationField: 'Customer',
    typeName: 'A_CustomerCompanyTextType',
    kind: 'collection',
    emptyText: 'No company code texts for this customer.',
    fieldNames: ['Customer', 'CompanyCode', 'Language', 'LongTextID', 'LongText'],
    summaryFields: ['CompanyCode', 'Language', 'LongTextID', 'LongText'],
    requiredCreateFields: ['CompanyCode', 'Language', 'LongTextID']
  },
  {
    id: 'CustomerDunning',
    title: 'Customer Dunning',
    entitySet: 'A_CustomerDunning',
    remoteEntity: 'A_CustomerDunning',
    relationField: 'Customer',
    typeName: 'A_CustomerDunningType',
    kind: 'collection',
    emptyText: 'No dunning data for this customer.',
    fieldNames: [
      'Customer', 'CompanyCode', 'DunningArea', 'DunningProcedure', 'DunningLevel',
      'DunningBlock', 'DunningRecipient', 'DunningClerk', 'LastDunnedOn',
      'LegDunningProcedureOn', 'AuthorizationGroup'
    ],
    summaryFields: [
      'CompanyCode', 'DunningArea', 'DunningProcedure', 'DunningLevel', 'DunningBlock'
    ],
    requiredCreateFields: ['CompanyCode', 'DunningArea']
  },
  {
    id: 'CustomerWithholdingTax',
    title: 'Customer Withholding Tax',
    entitySet: 'A_CustomerWithHoldingTax',
    remoteEntity: 'A_CustomerWithHoldingTax',
    relationField: 'Customer',
    typeName: 'A_CustomerWithHoldingTaxType',
    kind: 'collection',
    emptyText: 'No withholding tax data for this customer.',
    fieldNames: [
      'Customer', 'CompanyCode', 'WithholdingTaxType', 'WithholdingTaxCode',
      'WithholdingTaxAgent', 'ObligationDateBegin', 'ObligationDateEnd',
      'WithholdingTaxNumber', 'WithholdingTaxCertificate', 'WithholdingTaxExmptPercent',
      'ExemptionDateBegin', 'ExemptionDateEnd', 'ExemptionReason', 'RecipientType',
      'AuthorizationGroup'
    ],
    summaryFields: [
      'CompanyCode', 'WithholdingTaxType', 'WithholdingTaxCode', 'WithholdingTaxNumber'
    ],
    requiredCreateFields: ['CompanyCode', 'WithholdingTaxType']
  },
  {
    id: 'CustomerSalesAreaText',
    title: 'Customer Sales Area Texts',
    entitySet: 'A_CustomerSalesAreaText',
    remoteEntity: 'A_CustomerSalesAreaText',
    relationField: 'Customer',
    typeName: 'A_CustomerSalesAreaTextType',
    kind: 'collection',
    emptyText: 'No sales area texts for this customer.',
    fieldNames: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'Language',
      'LongTextID', 'LongText'
    ],
    summaryFields: [
      'SalesOrganization', 'DistributionChannel', 'Division', 'Language', 'LongText'
    ],
    requiredCreateFields: [
      'SalesOrganization', 'DistributionChannel', 'Division', 'Language', 'LongTextID'
    ]
  },
  {
    id: 'CustomerSalesPartnerFunctions',
    title: 'Customer Partner Functions',
    entitySet: 'A_CustSalesPartnerFunc',
    remoteEntity: 'A_CustSalesPartnerFunc',
    relationField: 'Customer',
    typeName: 'A_CustSalesPartnerFuncType',
    kind: 'collection',
    emptyText: 'No partner functions for this customer.',
    fieldNames: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'PartnerFunction',
      'PartnerCounter', 'BPCustomerNumber', 'DefaultPartner', 'Supplier', 'PersonnelNumber',
      'ContactPerson', 'AddressID', 'AuthorizationGroup'
    ],
    summaryFields: [
      'SalesOrganization', 'DistributionChannel', 'Division', 'PartnerFunction',
      'BPCustomerNumber', 'DefaultPartner'
    ],
    requiredCreateFields: [
      'SalesOrganization', 'DistributionChannel', 'Division', 'PartnerFunction',
      'PartnerCounter'
    ]
  },
  {
    id: 'CustomerSalesAreaAddressInfo',
    title: 'Customer Sales Area Address-Dependent Information',
    entitySet: 'A_CustSlsAreaAddrDepdntInfo',
    remoteEntity: 'A_CustSlsAreaAddrDepdntInfo',
    relationField: 'Customer',
    typeName: 'A_CustSlsAreaAddrDepdntInfoType',
    kind: 'collection',
    emptyText: 'No sales area address-dependent information for this customer.',
    fieldNames: [
      'Customer', 'SalesOrganization', 'DistributionChannel', 'Division', 'AddressID',
      'IncotermsClassification', 'IncotermsLocation1', 'IncotermsLocation2',
      'IncotermsVersion', 'DeliveryIsBlocked', 'SalesOffice', 'SalesGroup',
      'ShippingCondition', 'SupplyingPlant'
    ],
    summaryFields: [
      'SalesOrganization', 'DistributionChannel', 'Division', 'AddressID',
      'IncotermsClassification', 'DeliveryIsBlocked'
    ],
    requiredCreateFields: ['SalesOrganization', 'DistributionChannel', 'Division', 'AddressID']
  },
  {
    id: 'CustomerUnloadingPoint',
    title: 'Customer Unloading Points',
    entitySet: 'A_CustomerUnloadingPoint',
    remoteEntity: 'A_CustomerUnloadingPoint',
    relationField: 'Customer',
    typeName: 'A_CustomerUnloadingPointType',
    kind: 'collection',
    emptyText: 'No unloading points for this customer.',
    fieldGroups: [
      { title: 'Unloading Point', fields: ['Customer', 'UnloadingPointName', 'CustomerFactoryCalenderCode', 'BPGoodsReceivingHoursCode', 'IsDfltBPUnloadingPoint'] },
      {
        title: 'Monday',
        fields: ['MondayMorningOpeningTime', 'MondayMorningClosingTime', 'MondayAfternoonOpeningTime', 'MondayAfternoonClosingTime']
      },
      {
        title: 'Tuesday',
        fields: ['TuesdayMorningOpeningTime', 'TuesdayMorningClosingTime', 'TuesdayAfternoonOpeningTime', 'TuesdayAfternoonClosingTime']
      },
      {
        title: 'Wednesday',
        fields: ['WednesdayMorningOpeningTime', 'WednesdayMorningClosingTime', 'WednesdayAfternoonOpeningTime', 'WednesdayAfternoonClosingTime']
      },
      {
        title: 'Thursday',
        fields: ['ThursdayMorningOpeningTime', 'ThursdayMorningClosingTime', 'ThursdayAfternoonOpeningTime', 'ThursdayAfternoonClosingTime']
      },
      {
        title: 'Friday',
        fields: ['FridayMorningOpeningTime', 'FridayMorningClosingTime', 'FridayAfternoonOpeningTime', 'FridayAfternoonClosingTime']
      },
      {
        title: 'Saturday',
        fields: ['SaturdayMorningOpeningTime', 'SaturdayMorningClosingTime', 'SaturdayAfternoonOpeningTime', 'SaturdayAfternoonClosingTime']
      },
      {
        title: 'Sunday',
        fields: ['SundayMorningOpeningTime', 'SundayMorningClosingTime', 'SundayAfternoonOpeningTime', 'SundayAfternoonClosingTime']
      }
    ],
    summaryFields: [
      'UnloadingPointName', 'CustomerFactoryCalenderCode', 'BPGoodsReceivingHoursCode',
      'IsDfltBPUnloadingPoint'
    ],
    requiredCreateFields: ['UnloadingPointName']
  },
  {
    id: 'CustomerUnloadingPointAddressInfo',
    title: 'Customer Unloading Point Address-Dependent Information',
    entitySet: 'A_CustUnldgPtAddrDepdntInfo',
    remoteEntity: 'A_CustUnldgPtAddrDepdntInfo',
    relationField: 'Customer',
    typeName: 'A_CustUnldgPtAddrDepdntInfoType',
    kind: 'collection',
    emptyText: 'No unloading point address information for this customer.',
    fieldGroups: [
      { title: 'Unloading Point', fields: ['Customer', 'AddressID', 'UnloadingPointName', 'CustomerFactoryCalenderCode', 'BPGoodsReceivingHoursCode', 'IsDfltBPUnloadingPoint'] },
      {
        title: 'Monday',
        fields: ['MondayMorningOpeningTime', 'MondayMorningClosingTime', 'MondayAfternoonOpeningTime', 'MondayAfternoonClosingTime']
      },
      {
        title: 'Tuesday',
        fields: ['TuesdayMorningOpeningTime', 'TuesdayMorningClosingTime', 'TuesdayAfternoonOpeningTime', 'TuesdayAfternoonClosingTime']
      },
      {
        title: 'Wednesday',
        fields: ['WednesdayMorningOpeningTime', 'WednesdayMorningClosingTime', 'WednesdayAfternoonOpeningTime', 'WednesdayAfternoonClosingTime']
      },
      {
        title: 'Thursday',
        fields: ['ThursdayMorningOpeningTime', 'ThursdayMorningClosingTime', 'ThursdayAfternoonOpeningTime', 'ThursdayAfternoonClosingTime']
      },
      {
        title: 'Friday',
        fields: ['FridayMorningOpeningTime', 'FridayMorningClosingTime', 'FridayAfternoonOpeningTime', 'FridayAfternoonClosingTime']
      },
      {
        title: 'Saturday',
        fields: ['SaturdayMorningOpeningTime', 'SaturdayMorningClosingTime', 'SaturdayAfternoonOpeningTime', 'SaturdayAfternoonClosingTime']
      },
      {
        title: 'Sunday',
        fields: ['SundayMorningOpeningTime', 'SundayMorningClosingTime', 'SundayAfternoonOpeningTime', 'SundayAfternoonClosingTime']
      }
    ],
    summaryFields: [
      'AddressID', 'UnloadingPointName', 'BPGoodsReceivingHoursCode',
      'IsDfltBPUnloadingPoint'
    ],
    requiredCreateFields: ['AddressID', 'UnloadingPointName']
  },
  {
    id: 'SupplierText',
    title: 'Supplier Texts',
    entitySet: 'A_SupplierText',
    remoteEntity: 'A_SupplierText',
    relationField: 'Supplier',
    typeName: 'A_SupplierTextType',
    kind: 'collection',
    emptyText: 'No texts for this supplier.',
    fieldNames: ['Supplier', 'Language', 'LongTextID', 'LongText'],
    summaryFields: ['Language', 'LongTextID', 'LongText'],
    requiredCreateFields: ['Language', 'LongTextID']
  },
  {
    id: 'SupplierCompanyText',
    title: 'Supplier Company Code Texts',
    entitySet: 'A_SupplierCompanyText',
    remoteEntity: 'A_SupplierCompanyText',
    relationField: 'Supplier',
    typeName: 'A_SupplierCompanyTextType',
    kind: 'collection',
    emptyText: 'No company code texts for this supplier.',
    fieldNames: ['Supplier', 'CompanyCode', 'Language', 'LongTextID', 'LongText'],
    summaryFields: ['CompanyCode', 'Language', 'LongTextID', 'LongText'],
    requiredCreateFields: ['CompanyCode', 'Language', 'LongTextID']
  },
  {
    id: 'SupplierDunning',
    title: 'Supplier Dunning',
    entitySet: 'A_SupplierDunning',
    remoteEntity: 'A_SupplierDunning',
    relationField: 'Supplier',
    typeName: 'A_SupplierDunningType',
    kind: 'collection',
    emptyText: 'No dunning data for this supplier.',
    fieldNames: [
      'Supplier', 'CompanyCode', 'DunningArea', 'DunningProcedure', 'DunningLevel',
      'DunningBlock', 'DunningRecipient', 'DunningClerk', 'LastDunnedOn',
      'LegDunningProcedureOn', 'AuthorizationGroup'
    ],
    summaryFields: [
      'CompanyCode', 'DunningArea', 'DunningProcedure', 'DunningLevel', 'DunningBlock'
    ],
    requiredCreateFields: ['CompanyCode', 'DunningArea']
  },
  {
    id: 'SupplierWithholdingTax',
    title: 'Supplier Withholding Tax',
    entitySet: 'A_SupplierWithHoldingTax',
    remoteEntity: 'A_SupplierWithHoldingTax',
    relationField: 'Supplier',
    typeName: 'A_SupplierWithHoldingTaxType',
    kind: 'collection',
    emptyText: 'No withholding tax data for this supplier.',
    fieldNames: [
      'Supplier', 'CompanyCode', 'WithholdingTaxType', 'WithholdingTaxCode',
      'IsWithholdingTaxSubject', 'WithholdingTaxNumber', 'WithholdingTaxCertificate',
      'WithholdingTaxExmptPercent', 'ExemptionDateBegin', 'ExemptionDateEnd',
      'ExemptionReason', 'RecipientType', 'AuthorizationGroup'
    ],
    summaryFields: [
      'CompanyCode', 'WithholdingTaxType', 'WithholdingTaxCode', 'IsWithholdingTaxSubject',
      'WithholdingTaxNumber'
    ],
    requiredCreateFields: ['CompanyCode', 'WithholdingTaxType']
  },
  {
    id: 'SupplierPurchasingOrgText',
    title: 'Supplier Purchasing Organization Texts',
    entitySet: 'A_SupplierPurchasingOrgText',
    remoteEntity: 'A_SupplierPurchasingOrgText',
    relationField: 'Supplier',
    typeName: 'A_SupplierPurchasingOrgTextType',
    kind: 'collection',
    emptyText: 'No purchasing organization texts for this supplier.',
    fieldNames: ['Supplier', 'PurchasingOrganization', 'Language', 'LongTextID', 'LongText'],
    summaryFields: ['PurchasingOrganization', 'Language', 'LongTextID', 'LongText'],
    requiredCreateFields: ['PurchasingOrganization', 'Language', 'LongTextID']
  },
  {
    id: 'SupplierPartnerFunctions',
    title: 'Supplier Partner Functions',
    entitySet: 'A_SupplierPartnerFunc',
    remoteEntity: 'A_SupplierPartnerFunc',
    relationField: 'Supplier',
    typeName: 'A_SupplierPartnerFuncType',
    kind: 'collection',
    emptyText: 'No partner functions for this supplier.',
    fieldNames: [
      'Supplier', 'PurchasingOrganization', 'SupplierSubrange', 'Plant', 'PartnerFunction',
      'PartnerCounter', 'DefaultPartner', 'ReferenceSupplier', 'AuthorizationGroup'
    ],
    summaryFields: [
      'PurchasingOrganization', 'SupplierSubrange', 'Plant', 'PartnerFunction',
      'DefaultPartner'
    ],
    requiredCreateFields: [
      'PurchasingOrganization', 'SupplierSubrange', 'Plant', 'PartnerFunction',
      'PartnerCounter'
    ]
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

  // A grouped section states its fields once, in the groups. Deriving the flat list from
  // them keeps the two in step: a field added to a group is fetched, and one that is only
  // fetched but belongs to no group would never render, so it is not silently allowed.
  if (section.fieldGroups) {
    if (section.fieldNames) {
      throw new Error(`${section.id}: set either fieldGroups or fieldNames, not both.`);
    }
    section.fieldNames = section.fieldGroups.flatMap((group) => group.fields);
    const unknown = section.fieldNames.filter((name) => !definition.elements[name]);
    if (unknown.length) {
      throw new Error(
        `${section.id}: fieldGroups name field(s) that ${section.remoteEntity} does not have: `
        + `${unknown.join(', ')}.`
      );
    }
    const excluded = section.fieldNames.filter((name) => (section.excludedFields || []).includes(name));
    if (excluded.length) {
      throw new Error(
        `${section.id}: fieldGroups name excluded field(s): ${excluded.join(', ')}. `
        + 'Remove them from the group or from excludedFields.'
      );
    }
  }

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

// A child section is hosted in its parent's Details dialog and has no Object Page block of
// its own, so a stale id here would leave its data unreachable rather than merely unstyled.
const sectionIds = new Set(sections.map((section) => section.id));
for (const section of sections) {
  const unknown = (section.childSections || []).filter((id) => !sectionIds.has(id));
  if (unknown.length) {
    throw new Error(`${section.id}: childSections name unknown section(s): ${unknown.join(', ')}.`);
  }
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

// Written into the reuse library, not into an app: both the Manage BP app and the task UI render
// the maintenance screen, and tools/sync-reuse.js copies this into each of them at build time.
const target = path.join(
  projectRoot,
  'app',
  'reuse',
  'src',
  'mdm',
  'md',
  'businesspartner',
  'reuse',
  'BusinessPartnerMetadata.js'
);
fs.writeFileSync(target, output, 'utf8');
console.log(`Generated ${target}`);
