# The business partner lock

<!-- paths: srv/bp-lock.js, srv/change-request-service.js (persist), srv/business-partner-service.js
     (updateBusinessPartner, businessPartnerLock), app/reuse (_readLock, onEdit) -->

The statuses themselves, and everything else about staging, are in `staging.md`.

**While a request holds a partner, nobody else may raise a second one over it, and nothing may write to
it directly.** Until 2026-09-15 the only guard was `openEditPage` in `CustomActions.js`: client side, on
the list report alone, and reading the narrower in-flight marker. **The display screen's own Edit button
walked straight past it**, so two change requests over BP 20 could both reach approval and the second to
be approved posted over the first one's staged values.

Three enforcement points, one `lockHolder`:

1. **`persist`** (`change-request-service.js`) refuses a second request with a **409**. In `persist`, not
   in `submitRequest`, so `saveRequest` is gated identically — a draft locks, so a draft must not be
   parkable on a partner somebody else holds. It excludes the asking request, which holds its own lock
   from its first save onwards, so a resubmit is unaffected. **A create locks nothing** (no partner
   number); two people creating the same company is the duplicate check's question.
2. **`updateBusinessPartner`** (`business-partner-service.js`) refuses the one direct S/4 write a user
   can still start — **Mark for Deletion**, which is neither staged nor approved.
3. **`businessPartnerLock`**, a function the maintenance screen reads on every display/edit open. It
   withholds Edit and explains why in its own strip, and the edit ROUTE downgrades to display mode — the
   route is reachable by deep link and by the back button, and refusing only at submit would throw away
   a filled-in form.

**`saveBusinessPartner`, `saveBusinessPartnerEntity` and `deleteBusinessPartnerEntity` are deliberately
NOT gated.** They are what `postToS4` posts an approved request through, and the request holding the
lock is `approved` — a guard on any of them makes every approved request refuse its own post. A test
pins their absence.

**`lockHolder` is the one staging read on these paths that is NOT best-effort**: a lock nobody could read
must not read as "unlocked", so it throws and the write is refused. The **rendering** caller is the sole
exception and catches, answering `Readable: false` — hiding Edit on every partner in the system over a
staging hiccup is the worse failure, and the server gate is still behind it.

**`draft` locks**, decided 2026-09-15 with the strict reading chosen deliberately. **Accepted
consequence:** a forgotten draft holds the partner, and the change request list is steward-gated, so
only a data steward can reach it to withdraw it.

**The list's own marker stays narrow.** `openEditPage` still reads `ChangeRequest`, built from
`IN_PROGRESS_REQUEST_STATUSES`, so it does not see a partner held by an `approved` or `failed` request —
that is the first and weakest of the three checks, and widening the marker to make it stricter would
change what the list column means.
