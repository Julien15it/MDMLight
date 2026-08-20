namespace mdmlight.config;

using { managed } from '@sap/cds/common';

/**
 * Field property profiles: what a request may, must and must not show, per change request type and
 * per role. A profile is the conditions; the settings under it are the properties themselves, one
 * row per entity or field that is being said something about.
 *
 * Rows not columns, like the other rule tables - a new entity or field must never mean an ALTER,
 * and cds-deploy refuses to drop elements anyway.
 */
entity FieldPropertyProfiles : managed {
  key ID          : UUID;

      /** The steward's own label. Nothing keys on it: two profiles may carry the same name. */
      name        : String(60);

      /** A change request type (`create`, `change`) or `*` for every type. */
      requestType : String(10) default '*';

      /** `Requester`, `Approver`, `DataSteward` or `*` for every role. */
      role        : String(40) default '*';

      // No precedence column, deliberately: where two profiles match, the result is the BROADEST of
      // what they say (see srv/checks/field-properties.js), which is a join and therefore
      // order-independent. A `sequence` here would be a column implying an ordering nothing reads.
      isActive    : Boolean default true;

      settings    : Composition of many FieldPropertySettings on settings.profile = $self;
}

/**
 * One row is one statement: "under this profile, Addresses.Country is mandatory". A field with no
 * row is not mentioned by the profile at all, which is deliberately different from `optional` -
 * absent inherits, `optional` overrides a broader profile back to optional.
 */
entity FieldPropertySettings {
  key ID       : UUID;

      profile  : Association to FieldPropertyProfiles;

      /** Payload section id, e.g. `Addresses`. Matches srv/checks/payload-fields.js. */
      section  : String(40) not null;

      /** Element name, e.g. `Country`. **Null means the whole entity**, which is what lets a steward
       *  hide or require a section without naming every field in it. */
      element  : String(60);

      /** mandatory | readOnly | hidden | optional. One per row: a field is in one state, and
       *  `hidden` + `mandatory` on the same field is a request nobody can submit. */
      property : String(12) not null;
}
