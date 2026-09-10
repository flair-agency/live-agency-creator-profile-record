---
name: live-agency-creator-profile-record
description: Prepare creator targets, validate normalized public-profile observations, and append reviewed profile history through a selected environment. Use for profile refreshes and readback recovery; exclude LIVE sessions, fan-club metrics and history deletion.
---

# Record creator public-profile observations

The user invokes this Skill. Use the explicitly selected saved Runtime
environment to obtain the observation and datastore capabilities. Runtime
resolves the fixed Providers; it does not choose the business workflow.
Read [the environment workflow](references/environment-workflow.md) for the
commands, approval evidence, journal and read-only recovery procedure.

The selected installation must supply the generic Runtime API and all three
capabilities: `creator-profile-observation-source/v2`,
`creator-profile-datastore-read/v1` and `creator-profile-datastore-write/v1`.
Use the saved default platform unless the user explicitly selects another
configured platform. If setup is missing, use the selected Runtime's setup
procedure to obtain the missing choices. Do not infer a production environment,
Provider, credential or datastore from the current directory or browser session.

## Inputs and source boundary

Prepare a private target manifest from current normalized datastore reads. It
contains stable creator IDs and normalized account keys, without source URLs,
UI instructions or LIVE-history context. Obtain observations either as explicit
[normalized input](references/normalized-profile-observations.md) or through
the selected observation capability. Follow returned private instructions only
through an authorized source session and validate the correlated result.
Provider-specific screens, exports, credentials, field mapping and access routes
remain in that Provider's knowledge.

The selected source must explicitly support unattended operation before an
unattended run can proceed. Authentication or required human interaction stops
that unattended acquisition; report the condition instead of inventing observations.

## Target selection

The existing default selects up to 20 creators in the configured due view.
The hard maximum remains 100 targets. Use `selected` with explicit account keys
or `all` only for the corresponding user-requested scope. The datastore supplies
field-validated identities and due membership; the Skill preserves their order,
normalizes account keys, and rejects duplicate or missing target identities.
Keep targets, observations, reviews, images and results private and outside Git.

## Reconciliation

- Require one observation for every manifest row and no extras after account
  normalization.
- Create a history row only when at least one profile value was observed:
  follower count, recent-30-day post count, latest post time, nickname, avatar or
  feature-observation JSON. Unavailable values stay blank; do not infer zero.
- Promoted post/nickname values must agree with equivalent feature-observation
  values when both are present.
- A matching observation whose stored timestamp is at or after five minutes
  before the observation time counts as already applied (the existing replay
  tolerance). Preserve normalized seconds; when the datastore's date-time
  surface lacks seconds, a stored latest-post time in the same UTC minute is
  equivalent only for replay reconciliation. Never round the source observation.
- Upload an observed avatar only from an owner-only regular file with the
  normalized byte size and SHA-256. An otherwise exact row missing its avatar
  may receive a separately counted attachment resume.
- Never update or delete existing profile values. Attachment resume is the
  explicit exception for a missing observed image, not permission to replace it.
- Let the Provider enforce the selected timestamp field's storage semantics:
  omit an automatic timestamp; use the observation time for an ordinary timestamp.

## Reviewed registration and verification

Use `scripts/profile_environment.mjs` for targets, source handoff, planning and
write preparation. Show the exact business plan SHA-256, create and attachment
counts, already-applied and unavailable rows, conflicts and target issues.
Obtain actual owner approval for that plan and counts before `apply`.
An approval-reference string, digest or generated JSON is not proof of approval.

Recheck the plan using current creator identities, due membership where needed,
and scoped history/attachment hashes. The Provider separately rechecks current
fields, destination, authority and prepared intent. The selected Provider owns
which API or browser evidence meets its requirements; do not switch credentials,
environment or write route to bypass a failed check.

Upload new-row avatars before record creation and include their attachment tokens
in that create, so creation-triggered downstream work sees nickname and image
together. Existing-image resume appends the missing image to its exact row.
Do not silently split an approved plan or drop image operations to meet a limit;
use the selected Provider's documented handling and review any changed plan.

After execution, read history again until every approved observation is accounted
for or the bounded verification ends. An acknowledged create alone is not
business completion. For a precise timestamp write, use the selected Provider's
evidence capable of proving that precision; a minute-only display cannot prove
stored seconds. Report the actual verification and its limits.

## Failure and human takeover

Preserve the plan, prepared review, actual approval reference and durable journal.
Do not resend an uncertain create or attachment. Use the read-only `verify`
operation first; prepare and review a new plan for any missing remainder.
If identity, scope, environment or authority changed, return to the corresponding
preparation step. A failed read is not an empty history.

A qualified operator can inspect the normalized inputs, explain the plan's
summary and proposed effects, reproduce reconciliation with
`buildProfileSyncPlanFromHistory`, follow the selected Provider's operation and
readback procedures, and use the journal to determine what happened. The
[workflow guide](references/environment-workflow.md#failure-and-human-takeover)
links these steps. Tests and AI self-review do not establish human comprehension.

## Version boundary

Version 2 distributes this neutral environment workflow. The old service-specific
script exports are absent from the archive. The source repository retains legacy
comparison code and development dependencies; their presence does not select a
fallback route. Keep the unchanged 1.2.0 installation and its recovery evidence
for an explicitly selected legacy workflow. Installing this version does not
authorize production writes, schedules or retirement of that prior installation.
