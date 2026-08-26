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

      /**
       * Superseded the same day it was added (2026-08-26), and kept only because `cds-deploy` refuses
       * to drop an element - the same reason `sequence` below is still here, and `DerivationRules`
       * still carries `createsRow`. **Nothing reads it. Do not write to it.**
       *
       * Tried "critical" as one qualified field per profile row, matched by (requestType, role) like
       * every other rule table's condition. Maarten wanted it drawn alongside Mandatory/Read-only/
       * Hidden/Optional in the Modify dialog instead - a property of the FIELD, not a condition of the
       * PROFILE - which is `FieldPropertySettings.critical` below.
       */
      criticalField : String(60);

      /**
       * Superseded, and kept only because `cds-deploy` refuses to drop an element - the same reason
       * `DerivationRules` still carries `createsRow` and `DuplicateRules` its four `cond*` columns.
       * **Nothing reads it. Do not write to it.**
       *
       * There is no precedence, deliberately: where two profiles match, the result is the BROADEST
       * of what they say (see srv/checks/field-properties.js), which is a join and therefore
       * order-independent. Removing the column on 2026-08-20 failed `deploy_to_postgresql` four
       * times over - it had already reached the deployed model.
       */
      sequence    : Integer default 10;

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

      /** mandatory | readOnly | hidden | optional, or empty when the row exists only to carry
       *  `critical` below. One of the four per row: a field is in one state, and `hidden` +
       *  `mandatory` on the same field is a request nobody can submit. */
      property : String(12);

      /**
       * Independent of `property` above - an entity can be mandatory AND critical, or optional AND
       * critical, so it is its own checkbox rather than a fifth value in that one-per-row set.
       *
       * Entity-level only (2026-08-26): `element` must be null on a critical row - the write path
       * (`validateSetting` in srv/checks/field-properties.js) refuses a field-level one, and the
       * dialog greys the box out on a field row to match. `resolveProfiles` still reads an older
       * field-level row rather than dropping it, the same tolerance the withdrawn multi-value feature
       * left behind for its own stored data.
       *
       * A marker, not a gate (reverted 2026-08-26 the same day it was tried) - `createFieldPropertyStages`
       * enforces `mandatory` only, never `critical`. Two things read it instead: the maintenance
       * screen draws "⚠" next to a critical section's title, and `workflowContext`
       * (srv/change-request-service.js) reduces every critical entity on the request to one scalar
       * `criticalField` - `'X'` if any of them has data, `' '` otherwise. Neither ever names which
       * entity; that is what the screen's marker is for.
       */
      critical : Boolean default false;
}
