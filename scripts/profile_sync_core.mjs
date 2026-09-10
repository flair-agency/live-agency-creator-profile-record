// Legacy raw-record adapter. Business decisions live in the neutral planner.
import { buildProfileSyncPlanFromHistory, normalizeProfileObservations,
  validateTargetManifest, isRecordId, stableStringify } from '../src/profile-plan.mjs';
export { PROFILE_TARGET_INPUT_KIND, stableStringify, sha256Json, normalizeAccountKey,
  isRecordId, validateTargetManifest, validateProfileSyncPlan, planIsBlocked } from '../src/profile-plan.mjs';

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function linkedRecordIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const entry of value) {
    if (typeof entry === "string" && isRecordId(entry)) ids.push(entry);
    if (entry && typeof entry === "object") {
      if (isRecordId(entry.record_id)) ids.push(entry.record_id);
      if (Array.isArray(entry.record_ids)) {
        for (const recordId of entry.record_ids) if (isRecordId(recordId)) ids.push(recordId);
      }
    }
  }
  return [...new Set(ids)];
}

function parseStoredCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseStoredDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(number) ? number : null;
}

function parseStoredText(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return null;
}

function parseStoredJson(value) {
  const text = parseStoredText(value);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? stableStringify(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

async function hydrateProfileRecord(record, bindings, resolveAttachmentHash) {
  const reasons = [];
  const recordId = String(record?.record_id ?? "");
  if (!isRecordId(recordId)) reasons.push("invalid_record_id");
  const fields = record?.fields ?? {};
  const creatorIds = linkedRecordIds(fields[bindings.profile.creator.name]);
  if (creatorIds.length !== 1) reasons.push("creator_link_not_unique");
  const timestampMs = Number(fields[bindings.profile.timestamp.name]);
  if (!Number.isFinite(timestampMs)) reasons.push("invalid_timestamp");

  const rawFollower = fields[bindings.profile.followerCount.name];
  const rawRecentPosts = fields[bindings.profile.recentPostCount30d.name];
  const rawLatestPost = fields[bindings.profile.latestPostAt.name];
  const rawNickname = fields[bindings.profile.nickname.name];
  const rawFeatureData = fields[bindings.profile.featureObservationData.name];
  const followerCount = parseStoredCount(rawFollower);
  const recentPostCount30d = parseStoredCount(rawRecentPosts);
  const latestPostAtMs = parseStoredDate(rawLatestPost);
  const nickname = parseStoredText(rawNickname);
  const featureObservationJson = parseStoredJson(rawFeatureData);
  if (rawFollower !== null && rawFollower !== undefined && rawFollower !== "" && followerCount === null) {
    reasons.push("invalid_follower_count");
  }
  if (rawRecentPosts !== null && rawRecentPosts !== undefined && rawRecentPosts !== "" && recentPostCount30d === null) {
    reasons.push("invalid_recent_post_count");
  }
  if (rawLatestPost !== null && rawLatestPost !== undefined && rawLatestPost !== "" && latestPostAtMs === null) {
    reasons.push("invalid_latest_post_at");
  }
  if (rawNickname !== null && rawNickname !== undefined && rawNickname !== "" && nickname === null) {
    reasons.push("invalid_nickname");
  }
  if (rawFeatureData !== null && rawFeatureData !== undefined && rawFeatureData !== "" && featureObservationJson === undefined) {
    reasons.push("invalid_feature_observation_json");
  }

  const attachments = Array.isArray(fields[bindings.profile.avatar.name])
    ? fields[bindings.profile.avatar.name]
    : [];
  const avatarHashes = [];
  try {
    for (const attachment of attachments) avatarHashes.push(await resolveAttachmentHash(attachment));
  } catch {
    reasons.push("invalid_avatar_attachment");
  }

  if (reasons.length) return { valid: false, recordId, reasons: [...new Set(reasons)].sort() };
  return {
    valid: true,
    recordId,
    creatorRecordId: creatorIds[0],
    timestampMs,
    followerCount,
    recentPostCount30d,
    latestPostAtMs,
    nickname,
    featureObservationJson: featureObservationJson ?? null,
    avatarHashes: [...new Set(avatarHashes)].sort(),
  };
}

export async function buildProfileSyncPlan({
  manifest,
  observations,
  profileRecords,
  bindings,
  resolveAttachmentHash = async () => {
    throw new TypeError("attachment hash resolver is unavailable");
  },
  nowMs = Date.now(),
}) {
  // Preserve legacy validation before attachment hydration and its side effects.
  validateTargetManifest(manifest);
  assert(Array.isArray(profileRecords), "Lark profile record collection is invalid");
  assert(Number.isSafeInteger(nowMs), "nowMs is invalid");
  normalizeProfileObservations(observations, nowMs);
  const profileHistory = await Promise.all(
    profileRecords.map((record) => hydrateProfileRecord(record, bindings, resolveAttachmentHash)),
  );
  return buildProfileSyncPlanFromHistory({ manifest, observations, profileHistory, nowMs });
}
