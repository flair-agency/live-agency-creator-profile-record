---
name: live-agency-creator-profile-record
description: Prepare creator targets, validate normalized public-profile observations, and safely append follower, post, nickname, avatar, and feature-observation history to Lark Base. Use for reviewed profile refreshes; do not collect live history or fan-club metrics, update existing history, or delete records.
---

# Record creator public-profile observations

## Selected environment planning

When the user selects a saved Runtime environment, use
[the environment workflow](references/environment-workflow.md). The user invokes
this Skill; the Skill requests source and datastore capabilities from that
environment. It does not discover concrete Providers or select credentials.
This connection currently prepares targets, observations and a read-only plan.
It has no apply operation. Keep its selected environment and generation with
every handoff. Do not fall back from this route to the legacy writer below.

The existing route below is retained for compatibility and comparison with
explicitly selected legacy installations. Its successful tests do not establish
production acceptance of the new environment connection.

Append reviewed public-profile observations without embedding knowledge of the
source service. The public core owns target selection, the normalized contract,
destination-aware reconciliation, constrained creates, avatar verification,
and post-write verification.

For every Lark Base read or mutation, follow the policy supplied by the
installed Lark Base provider.
This skill's append-only, approval, and avatar rules remain mandatory.

## Source boundary

Prepare a private target manifest from a current Lark read snapshot according
to the shared provider policy. The manifest includes stable creator record IDs
and normalized account keys. It contains no source URL, UI instruction, or
live-history context.

Obtain observations in either form:

1. normalized JSON conforming to
   [references/normalized-profile-observations.md](references/normalized-profile-observations.md); or
2. exactly one installed `creator-profile-observation-source/v2` provider
   discovered from the direct npm dependencies of a local composition root.

Use `scripts/resolve_profile_source.mjs`. If the resolver returns private
instructions, follow only those loaded instructions and validate their result
through the same normalized schema. Never add provider package names, source
URLs, UI labels, parsing rules, or device procedures to this skill.

An unattended run is allowed only when the provider manifest explicitly
declares it. Authentication or human interaction stops an unattended run.

## Migration verification and route selection

Verify the explicitly selected installed workflow through its supported
planning, approved execution and readback entry points. An MCP adapter is
required only when the selected client route uses it. Package versions and
manifest schema versions do not select a production route.

Reuse applicable Provider evidence. Compare the same reviewed inputs with a
verified existing route when available; otherwise use the business contract
and independently established expected results. Keep synthetic checks distinct
from real-destination verification. Neither comparison nor passing tests
authorize an apply, profile-write activation, schedule switch or retirement of
the active route. Preserve the selected recovery path until cutover acceptance.

When specifically comparing or switching the legacy Creator Scouting MCP
route, follow [references/v2-dual-run.md](references/v2-dual-run.md), including
its same-manifest comparison and scheduled-route conditions. Those conditions
do not require introducing that MCP route for another selected workflow.
Keep comparison inputs and reports owner-only and outside Git.

## Target selection

If a snapshot cannot provide stable creator record IDs and current field
metadata, `scripts/export_profile_targets.mjs` is the API-read exception; it
defaults to the configured due view and 20 rows. Use `--mode selected` with
repeated `--account`, or `--mode all`, only when the user explicitly requests
records outside that view. The hard maximum is 100 targets.

The exporter stops on duplicate accounts, missing field IDs, wrong field types,
or changed relation targets. Manifests, observations, and plans are private
owner-only files.

## Reconciliation

- Require exactly one observation for every manifest row and no extras after
  account normalization.
- Create one profile-history row only when at least one profile value was
  observed. Supported values are follower count, recent-30-day post count,
  latest post time, nickname, avatar, and feature-observation JSON.
- Leave unavailable values blank; never synthesize placeholders or infer zero.
- Require promoted post and nickname fields to agree with equivalent values in
  feature-observation JSON when both are present.
- Treat a matching profile observation already written after its observation
  timestamp as already applied.
- Preserve the normalized seconds in the source observation and
  feature-observation JSON. When a Lark date-time surface stores or returns no
  seconds, treat a stored latest-post time in the same UTC minute as equivalent
  only for replay reconciliation; do not round the source observation itself.
- Upload an observed avatar only from a verified owner-only local file whose
  size and SHA-256 match the normalized metadata. A missing attachment on an
  otherwise exact replay may be resumed through a separately counted operation.
- Never update or delete existing profile records.
- Omit an automatic profile timestamp from writes. If the configured timestamp
  is an ordinary date-time field, write the normalized observation timestamp.

## Reviewed apply

Create a plan with `scripts/sync_profile_observations.mjs` using a manifest,
normalized observations, and `--output-plan`. Report its SHA-256,
profile-create and avatar-attachment counts, already-applied counts,
unavailable profiles, conflicts, and target issues.

Rerun the saved plan without `--apply` immediately before mutation. Applying
requires explicit approval of the exact plan SHA-256, profile-create count, and
avatar-attachment count. Before writing, reread field definitions, creators,
due-view membership, profile history, and existing attachment bytes. After
writing, reread until all approved observations are accounted for. A current
browser/export snapshot may satisfy those reads only when it proves the same
identities, field bindings, view membership, existing values, and attachment
state required by the plan; otherwise use the read API exception.

For an exact browser-grid date-time write, verify seconds from a fresh
data-inclusive Base export according to the installed provider policy. A CSV
or minute-formatted grid readback can verify only a plan that explicitly
accepts minute precision; it cannot prove that stored seconds were discarded.

For a new profile row, upload the avatar first and include its attachment token
in the create payload. This lets record-created Lark flows observe nickname and
avatar together. Use attachment append only to resume an otherwise exact
existing row whose avatar is missing.

For an explicitly selected client composition, use
`buildProfileHistoryWritePayloads` from `scripts/profile_lark_runtime.mjs` to
prepare the complete creates and existing-image-resume review payload. It keeps
image metadata separate from server-issued tokens and supports at most 100 rows
per operation. Bind all effects to the same reviewed plan through the selected
destination Provider; do not omit image operations or silently split the plan.
`applyProfilePlan` remains the approved execution and final-readback entry point.

Use the Lark API for the approved mutation. The implementation batches
compatible profile creates instead of issuing one create call per row. On a
provider limit, use only the shared policy's exact import/browser fallback.

Do not retry an uncertain create or attachment. Reconcile by rereading and
require a new plan and approval for any remainder.

## Lark access and credentials

Use the private field-ID-only configuration in
[references/lark-config.md](references/lark-config.md). Resolve current display
names from those IDs at runtime. Keep snapshots, exports, import files, and
browser-derived data owner-only and out of Git.

When an API route is required, supply credentials with
`LARK_TENANT_ACCESS_TOKEN`, `LARK_APP_ID` plus `LARK_APP_SECRET`, or an
explicitly selected `LARK_KEYCHAIN_SERVICE`. Never put credentials, creator
data, plans, avatar files, or provider instructions in Git.
