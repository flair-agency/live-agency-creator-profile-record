---
type: architecture
visibility: public
status: commit
date: 2026-09-27
author: "Naoki Kimura (owner adoption); Codex (drafting)"
context: "Profile Pilot #16 and owner review of PR #18"
---

# Profile capability boundary for an MCP candidate

## Decision and scope

Evaluate a Skill-facing MCP interface for Profile from the business outcome and the properties an execution route must provide. The [owner-reviewed Japanese analysis](../reviews/profile-domain-mcp-contract-ja.md) is review history; this document is the English authority for the adopted direction. [Profile Pilot #16](https://github.com/flair-agency/live-agency-creator-profile-record/issues/16) tracks the remaining investigation. The project-wide [Plugin/MCP boundary](https://github.com/flair-agency/live-agency/blob/main/docs/architecture/plugin-mcp-boundary.md) governs the wider responsibility split.

This decision selects a **non-production contract investigation**, not an MCP tool name or count, a Plugin composition, a production route, or a transfer of authority from the selected Runtime and Provider. The [current Skill](../../SKILL.md) and its `creator-profile-datastore-read/v1` and `creator-profile-datastore-write/v1` contracts continue to govern the selected route. Their plan hash, counts, replan, authorization callbacks, prepared intent and journal requirements remain in force there. Do not infer that their exact mechanisms are universal requirements for a future route. Any change to an existing binding or Skill contract requires its own reviewed amendment before selection.

## Required outcomes and route properties

| Profile need | Property to demonstrate on a selected route | Current route's mechanism, for comparison |
| --- | --- | --- |
| Apply a change requiring owner review only after that review | A caller cannot self-assert or bypass the required review; the effect matches the change the owner reviewed | Plan hash and counts, approval check, replan, Provider intent authorization |
| Store observations for the intended creator and selected destination | Resolve the actor, environment, target, operation and compatible version before an effect; stop on missing, ambiguous or changed selection | Runtime selection and Provider preparation/checks |
| Record a new history row with its observed avatar when available | Preserve the current upload-before-create requirement and distinguish a missing-image resume on an exact existing row | Media upload, token-bearing create and attachment resume |
| Recover from an uncertain write | Do not blindly replay; inspect the resulting state, distinguish verified completion from an unresolved outcome, and leave a human-readable safe next step | Journal, events, bounded readback and read-only verification |

The owner review and actual effect must agree. A caller-supplied `approved: true` or approval-reference string alone does not establish that agreement. Host confirmation may satisfy it if the selected host and operation are shown to prevent bypass and bind the confirmation to the effect. A signed token, approval ledger, or the current callback and hash structure is not prescribed in advance.

The Skill retains business target/observation reconciliation, the content to present for review, the decision to seek required approval, business completion and human takeover. A selected datastore capability owns scoped reads, effects and uncertain-result interpretation. Service-specific fields, transferable media tokens, credentials and the choice between official record tools and supplemental media stay behind that boundary. The MCP interface may expose one bounded write operation or multiple operations; `prepare → apply → verify` is the current route's decomposition, not the candidate's predetermined schema. Choose the smallest tool boundary that passes the conformance cases below.

Concurrency controls, atomic uniqueness and ACID properties are not universal acceptance requirements. Determine whether the selected execution model permits concurrent writers and choose a proportionate prevention or reconciliation strategy if it does. Receipt and recovery evidence need to let an operator identify effects and a safe next action; they need not copy the current journal format.

## Evidence and next gate

The merged [synthetic parent PoC](https://github.com/flair-agency/live-agency/pull/121) proves that one domain-shaped MCP tool can compose lower record and media tools without exposing their schemas to the Skill. The [Profile Pilot fixture](https://github.com/flair-agency/live-agency-creator-profile-record/pull/17) separately proves selected current-route behavior for upload-before-create, lost-create-response readback and upload failure with no history create. Their creator identifiers and avatar bytes differ; this is not exact-input parity or proof of an actual host's approval behavior, Lark authorization, media transfer or production recovery.

The next non-production comparison uses the same normalized observation, target manifest, identifiers and avatar hash on the retained path and a candidate MCP path. Compare intended target/value/image, required-review bypass rejection, effect order, no blind replay, safe stop and human takeover for normal creation, uncertain upload/create, exact-row image resume, changed target or reviewed content, and readback failure. Compare business outcomes and route properties; do not require identical hashes, callback layout, journal format or tool count.

Before selecting a production MCP route, identify its exact host, composition and authority owner; demonstrate the required review and effects on that route; qualify service errors, authentication, resource binding and recovery; and adopt any necessary changes to current contracts. Until then, the selected Runtime/Provider route remains the recovery path. This document grants no live access, installation, publication or cutover authority.
