namespace mdmlight.config;

using { managed } from '@sap/cds/common';

/**
 * Installation-wide feature switches, maintained by a steward rather than set at
 * deploy time - a customer who decides against AI assistance should not need a
 * redeploy, and the decision has to survive one.
 *
 * One row, keyed on a fixed id. A singleton is modelled as a keyed entity rather
 * than a one-column table because that is what OData can address and what
 * cds-deploy can evolve; `srv/ai/availability.js` reads it through that key and
 * treats an absent row as "everything on", so an installation that never opens
 * this page behaves exactly as it did before the switch existed.
 *
 * Defaults are deliberately permissive. A missing row must not read as "AI is
 * off": that would silently disable the assistant on every existing landscape
 * the moment this table ships.
 */
entity FeatureSettings : managed {
  /** Always SINGLETON_ID. Present so the row is addressable, not to allow a second. */
  key ID                  : String(12);

      /**
       * False turns off every call to a language model: the assistant, model-based
       * intent parsing and the normalisation proposals.
       *
       * The assistant is withdrawn rather than degraded. It is the one feature that
       * exists only to reach a model, so an installation that may not use AI is not
       * offered a quieter version of it: every way in is hidden and
       * `askBusinessPartnerAssistant` refuses with 403.
       *
       * The other two degrade instead, because they are enrichments of work the user
       * came to do rather than features in their own right - submitting a change
       * request has to keep working. Both already had a deterministic path for the
       * case where no AI Core binding exists: intent falls back to pattern matching,
       * normalisation to its rule-based proposals. This switch takes that same road,
       * so turning AI off exercises code that is already used and tested rather than
       * a second, unproven branch.
       *
       * Explicitly NOT covered, because they reach no model: the duplicate check
       * and fuzzy name matching (local scoring), and the VIES and GLEIF
       * look-ups (external registers, not language models). Those are separate
       * concerns and would need their own switch.
       */
      aiAssistanceEnabled : Boolean default true;
}
