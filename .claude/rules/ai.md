# `srv/ai/` — SAP AI Core orchestration

<!-- paths: srv/ai/**, app/reuse/src/mdm/md/businesspartner/reuse/BusinessPartnerAssistant.js -->

`business-partner-assistant.js` calls the Generative AI Hub via `@sap-ai-sdk/orchestration`, bound
through the `extended`-plan service `mdm-businesspartner-aicore`. Model and fallbacks are set by
`AICORE_MODEL`/`AICORE_FALLBACK_MODELS`/`AICORE_RESOURCE_GROUP` in `mta.yaml`.

**The primary is deliberately not a reasoning model** — the assistant summarises a pre-filtered context
and gains nothing from reasoning, while a reasoning primary was slower and could spend its whole budget
on hidden reasoning. `gpt-5`/`o*` models take `max_completion_tokens` instead of `max_tokens`, and an
undersized budget returns empty content instead of erroring (`isReasoningModel`/`modelParams` handle
this — keep them if a reasoning model is ever promoted back).

`ASSISTANT_INTENT_SOURCE: model` switches intent parsing from the regex heuristics to `srv/ai/intent.js`,
which is what makes "maak BP X aan" reliably yield a `companyName`. **The regex parser stays as the
fallback** whenever `parseIntent` returns null. `company-research.js` is a separate lookup;
`findPotentialDuplicates` uses Dice-coefficient name similarity, not exact match.

- **The Wikipedia branch has no structured data.** The REST summary API is prose, and Wikipedia is the
  branch a well-known company always takes (tried first, wins on any non-empty summary), so
  `suggestedAddress` was permanently `undefined` for exactly the companies most likely to have one.
  `addressFromPublicWeb` runs the DuckDuckGo snippet search as a **supplementary** call afterwards and
  merges the result, in its own try/catch.
- **`CorrespondenceLanguage` is inferred from the address country** — `COUNTRY_LANGUAGE`, deliberately
  narrow: only `NL`/`DE`/`FR`/`GB`. `BE` and `LU` are left silent on purpose — a wrong guess is worse
  than an empty field.
- **Registry enrichment joined the suggestion.** `registryEnrichment` calls `enrichCandidate` with the
  requested name and no typed tax numbers. **A tax number is only ever proposed once VIES has confirmed
  it, and only for Belgium** — GLEIF's `registeredAs` is a local company number and `registeredAt` a
  registration-authority id; **neither is an SAP `BPTaxType`**. A Belgian enterprise number is the base
  of the Belgian VAT number, so `belgianEnterpriseNumber` derives the candidate and `checkVatNumber`
  must answer `VALID` before `BPTaxType: 'BE0'` is proposed. Any other country's GLEIF hit contributes
  name and address only. **Registry outranks the research**: confirmed VIES, then GLEIF, then
  Wikipedia's title, then the plain requested name.
- **A VAT number typed in the chat is answered directly.** `extractVatNumber` finds a VIES-recognised
  2-letter code followed by 7–14 digits and `directVatLookup` calls VIES independently of any name match
  — **answered whatever VIES says**, including `invalid`/`unknown`, because staying silent on a number
  the requester explicitly gave is the failure being fixed. **`check.vatNumber` is always the national
  number without the country prefix**, so build every branch off the check's own fields — building a
  label from the raw regex match doubled the prefix (`BEBE0403200393`).
- **The model must be TOLD about the registry results.** `registryEnrichment`/`directVatLookup` once
  reached only `fallbackAnswer`, so the live model had an empty context and reasoned its way to "check
  VIES yourself" — a plausible answer from a genuinely empty context, not a fallback-string bug.
  `registryFindings` is a fourth `promptContext` field, and the system prompt says plainly what it is
  and that the lookup already happened.
- **A requested role gets a role row.** `detectRequestedRoles` matches `customer`/`klant`/`afnemer` →
  `FLCU01` and `supplier`/`vendor`/`leverancier` → `FLVN01` (a plain regex, always on, unlike the
  `ASSISTANT_INTENT_SOURCE`-gated parser); both can fire. **Only the role row is added** —
  `cvi_account_group` fills Customers/Suppliers on the next Check, through the proposal path every other
  derivation follows.
- **`SuggestedData` is `{ root, sections }`**, the same shape a staged payload uses — a `TaxNumbers` row
  is a child entity and no flat key list can express one. The client JSON-encodes the whole object into a
  single `?draft=` query parameter. `_onCreateRoute` applies root fields off the explicit allowlist
  `ROOT_DRAFT_FIELDS` and section rows by id, stamping each `__state: "new"`; an unknown section key is
  ignored rather than refused.
- **The chat is a coloured list of turns** — a `sap.m.List` of `FeedListItem`s built by a **factory** (a
  template cannot vary a row's style class). Three classes keyed off SAP semantic tokens, never fixed
  hex. `pushMessage(role, sender, text)` is the only writer. `conversationHistory` — the narrower list
  sent as `ConversationJson`, capped to the last 10 turns — stays deliberately separate: the system intro
  and error text belong on screen, never in what the model reasons over.
