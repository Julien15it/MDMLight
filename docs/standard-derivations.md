# What S/4 derives for itself, and what we could show

Read from `srv/external/API_BUSINESS_PARTNER.edmx` on 2026-08-26 — the app's own checked-in
metadata, so this is **this release's** answer rather than a general one. Scoped to the 14 entities
the app actually maintains, of the 65 in the service. (244 properties across the whole service
carry `sap:creatable="false"`; 55 of them are in entities we touch.)

## Two kinds of derivation, and only one is discoverable

**Field-level** — S/4 fills a field, and marks it `sap:creatable="false" sap:updatable="false"` so
a caller cannot set it. This is the list below, and it is complete for the entities scanned.

**Row-level** — S/4 creates a whole record the caller never sent. **Metadata cannot show this**,
because the fields on such a record are perfectly creatable; the derivation is that the record
appears at all. Partner functions are the case in point and are covered at the end.

Do not read "nothing derived" on an entity as "nothing happens there". `A_CustSalesPartnerFuncType`
reports nothing derived and is the single biggest row-level derivation in the whole flow.

## One thing this settles immediately

**Every field below is non-creatable, so we cannot send it even if we wanted to.** The question of
"do we include it in the payload for activation" does not arise — S/4 refuses it. So for these 55
fields the only open question is whether to *show* them, never whether to send them.

The app's guard for values that could otherwise slip through is
`ROOT_CREATE_EXCLUDED_FIELDS` / `sanitizeEntityPayload` in `srv/business-partner-service.js`.
`CLAUDE.md` notes that the other derived root fields are "still unguarded on create; nothing
produces them today" — the table below is exactly the set that would need guarding if anything ever
did.

## Field-level derivations, by whether they are worth showing

### A. Administrative — nothing to show

| Entity | Fields |
|---|---|
| `A_BusinessPartner` | `CreatedByUser`, `CreationDate`, `CreationTime`, `LastChangeDate`, `LastChangeTime`, `LastChangedByUser`, `ETag`, `BusinessPartnerUUID`, `PersonNumber`, `IndependentAddressID` |
| `A_BusinessPartnerAddress` | `AddressUUID`, `Person` |
| `A_Customer` / `A_Supplier` | `CreatedByUser`, `CreationDate` |
| `A_SupplierPartnerFunc` | `CreatedByUser`, `CreationDate` |

Technical keys and audit columns. No requester has an opinion about any of them.

### B. Assigned at activation — value cannot be known beforehand

| Entity | Field | What assigns it |
|---|---|---|
| `A_BusinessPartner` | `Customer` | CVI, when a customer role is present |
| `A_BusinessPartner` | `Supplier` | CVI, when a vendor role is present |

Nothing to fill in. If the screen says anything it can only be "a number will be assigned" — and
per `docs/cvi.md` CVI is synchronous here, so it is available immediately after the post.

### C. Copied or composed from data the requester already typed — showable

| Entity | Fields | Composed from |
|---|---|---|
| `A_BusinessPartner` | `BusinessPartnerFullName`, `BusinessPartnerName` | the name components, per BP category |
| `A_BusinessPartnerAddress` | `FullName` | the address's own name fields |
| `A_Customer` | `CustomerFullName`, `BPCustomerFullName`, `CustomerName`, `BPCustomerName` | the BP's name |
| `A_Supplier` | `SupplierFullName`, `SupplierName` | the BP's name |
| `A_Customer` / `A_Supplier` | `Industry` | the BP's industry |
| `A_Customer` / `A_Supplier` | `TaxNumber1`–`TaxNumber5`, `VATRegistration` | the BP's tax numbers, distributed by tax type |
| `A_Customer` / `A_Supplier` | `InternationalLocationNumber1`–`3` | the BP's ILN |
| `A_Customer` | `NFPartnerIsNaturalPerson` | the BP category |
| `A_Supplier` | `IsNaturalPerson`, `ConcatenatedInternationalLocNo` | the BP category / ILN |

**`BusinessPartnerFullName` is already done** — composed client-side by `_refreshFullName` and
excluded from the create payload. That is the pattern any of the others would follow.

The interesting one here is **tax number distribution**: a requester enters tax numbers on the BP
by tax type, and S/4 spreads them across `KNA1-STCD1..5` / `STCEG` according to country and type.
Showing that mapping answers a question requesters do ask — "where does this number end up?" — and
needs no new lookup, only the type-to-slot rule.

The name copies are real but low value: the requester typed the name, so echoing it onto the
customer view tells them nothing.

### D. Looked up from another master record — showable and genuinely useful

| Entity | Fields | Source |
|---|---|---|
| `A_BusinessPartnerBank` | `BankName`, `SWIFTCode`, `CityName` | the bank master (`BNKA`), by bank country + bank key |
| `A_SupplierCompany` | `CompanyCodeName` | the company code text (`T001`) |
| `A_BusinessPartnerAddress` | `FormOfAddress` | **unconfirmed** — probe before relying on it |

**The bank lookup is the best candidate in this whole document.** A requester types a bank country
and a bank key; S/4 resolves the bank's name, SWIFT code and city. Showing them turns a silent
typo into an obvious one — "you entered a key that belongs to a different bank" is something a
requester can act on immediately, and it costs one read of a master record they are already
allowed to see.

Note `Banks` in the existing value helps is `I_BusinessPartnerBank`, which per
`value-help-options-mdmlight` lists banks **already assigned to a BP** rather than a bank
directory — so this needs a different source view, not the existing one.

## Row-level derivations — what metadata cannot tell you

### Partner functions

Creating a sold-to customer makes S/4 create the obligatory partner functions **pointing at the
customer itself**:

> "If you create a master record for a sold-to party, the obligatory functions ship-to party,
> bill-to party and payer are automatically assigned with the sold-to party."
> — [Partners in the Sales and Distribution Process](https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/7b24a64d9d0941bda1afa753263d9e39/0b71bd534f22b44ce10000000a174cb4.html)

So SP, SH, BP and PY are created with the new customer's own number. **There is no value to
show**, because the number does not exist until activation. At most the screen can state the
shape: "these four functions will be created pointing at this customer".

Which functions a given account group gets is configuration and therefore mirrorable — customizing
*Set Up Partner Determination for Customer and Supplier Master → Account Group - Role Assignment*.
Worth reading only if the shape is ever worth showing.

**Do not stage these.** A staging column that can never hold a real value is what the next person
reads as a bug.

### The customer and supplier master themselves

CVI creates them, driven by the BP **role** — measured, not assumed: sending a supplier node
without its role produces `CVI_EI/039 Partner does not have a vendor role, you cannot create a
vendor` and no vendor at all. See `mdmlbpcheck/README.md`.

### The account group is the exception that goes the other way

`docs/cvi.md` established that `CVIC_CUST_TO_BP1`, `CVIC_VEND_TO_BP1` and `TB001.KTOKD` are **all
empty** in this system, so S/4 does *not* derive the account group — it takes it from the caller.
That is why `cvi_account_group` both derives it and sends it, unlike everything else here.

## The rule this suggests

Three categories, and only the middle one is a judgement call:

1. **S/4 derives it and the value is unknowable** → show the shape at most, never stage.
2. **S/4 derives it and the value is knowable** → derive for display, and *do not send it*. For
   the fields in this document that is enforced anyway, since none of them are creatable.
3. **S/4 does not derive it because the config is empty** → derive *and* send. Only the account
   group is in this category today.

The reason category 2 says "do not send" beyond the technical block: **if you send a value, you own
it.** Where S/4 would accept a value, it takes yours over its own derivation, so a stale mirror
silently overrides the correct answer.

## Worth building, in order

1. **Bank name / SWIFT / city from the bank key.** Highest value, catches a real class of typo.
   Needs a bank-directory source view, not the existing `Banks` value help.
2. **Tax number → `STCD1..5` / `STCEG` mapping.** Explains where an entered number lands. No new
   lookup needed.
3. **`CompanyCodeName`.** Trivial, and possibly already covered by a value help.
4. **Partner function shape.** Informational only. Cheap, low value, no staging.
5. **Name copies onto customer/supplier.** Skip — tells the requester what they just typed.

## Limits of this analysis, stated plainly

- **Scoped to 14 entities of 65.** The others are read-only in this app; if a maintained entity is
  ever added, re-run the scan.
- **The metadata is a checked-in copy** and drifts — see `CLAUDE.md`, *The imported models are
  copies*. A field's flags here are what the copy says, not necessarily what the live service does.
  `srv/metadata-drift.js` is what catches that.
- **Row-level derivations are not discoverable this way at all.** The two named above came from SAP
  Help and from probing; there may be more, and no scan of `$metadata` will find them.
- **`FormOfAddress` is a guess.** It is non-creatable, so something derives it, but what was not
  established.
