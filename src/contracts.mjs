// Service-neutral validation owned by this business capability.
import path from "node:path";

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assertIsoDateTime(value, label) {
  const match = typeof value === "string" ? value.match(ISO_DATE_TIME_PATTERN) : null;
  if (!match) {
    throw new TypeError(`${label} must be an ISO date-time string`);
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    zone,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = zone === "Z" ? 0 : Number(offsetHourText);
  const offsetMinute = zone === "Z" ? 0 : Number(offsetMinuteText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO date-time string`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}

const OBSERVATION_STATUSES = new Set([
  "observed_exact",
  "observed_rounded",
  "not_available",
  "no_history",
  "account_mismatch",
  "authentication_required",
  "blocked",
  "schema_changed",
]);
function validateObservedCount({ value, status, display }, label, { rounded = true } = {}) {
  if (!OBSERVATION_STATUSES.has(status)) {
    throw new TypeError(`${label} status is invalid`);
  }
  if (value === null) {
    if (["observed_exact", "observed_rounded"].includes(status)) {
      throw new TypeError(`${label} null value cannot be observed`);
    }
    return;
  }
  assertNonNegativeInteger(value, `${label} value`);
  if (status === "observed_exact") return;
  if (status !== "observed_rounded" || !rounded) {
    throw new TypeError(`${label} value requires an observed status`);
  }
  if (typeof display !== "string" || !display.trim()) {
    throw new TypeError(`${label} rounded value requires display text`);
  }
}

function validateObservedValue({ value, status }, label) {
  if (!OBSERVATION_STATUSES.has(status)) throw new TypeError(`${label} status is invalid`);
  if (value === null) {
    if (["observed_exact", "observed_rounded"].includes(status)) {
      throw new TypeError(`${label} null value cannot be observed`);
    }
    return;
  }
  if (status !== "observed_exact") throw new TypeError(`${label} value requires observed_exact`);
}

function validateAvatar(avatar, label) {
  assertObject(avatar, label);
  if (typeof avatar.path !== "string" || !path.isAbsolute(avatar.path)) {
    throw new TypeError(`${label} path must be absolute`);
  }
  if (!/^[0-9a-f]{64}$/.test(avatar.sha256 ?? "")) {
    throw new TypeError(`${label} sha256 is invalid`);
  }
  if (!Number.isSafeInteger(avatar.size) || avatar.size < 1) {
    throw new TypeError(`${label} size is invalid`);
  }
  if (typeof avatar.name !== "string" || !avatar.name || /[\\/\0\r\n]/.test(avatar.name)) {
    throw new TypeError(`${label} name is invalid`);
  }
  if (typeof avatar.mimeType !== "string" || !avatar.mimeType.startsWith("image/")) {
    throw new TypeError(`${label} mimeType is invalid`);
  }
}

function validateFeatureObservationData(value, label, creator) {
  assertObject(value, label);
  if (!Number.isSafeInteger(value.schema_version) || value.schema_version < 1) {
    throw new TypeError(`${label} schema_version is invalid`);
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  if (Buffer.byteLength(encoded, "utf8") > 100_000) {
    throw new TypeError(`${label} exceeds 100000 bytes`);
  }
  if (value.observation?.observed_at !== undefined) {
    assertIsoDateTime(value.observation.observed_at, `${label} observation.observed_at`);
    if (Date.parse(value.observation.observed_at) !== Date.parse(creator.observedAt)) {
      throw new TypeError(`${label} observation timestamp does not match creator observedAt`);
    }
  }
  if (
    value.profile?.display_name !== undefined &&
    creator.profile.nickname !== null &&
    value.profile.display_name !== creator.profile.nickname
  ) {
    throw new TypeError(`${label} display_name does not match profile nickname`);
  }
  if (
    value.posts?.last_30_days_count !== undefined &&
    creator.profile.recentPostCount30d !== null &&
    value.posts.last_30_days_count !== creator.profile.recentPostCount30d
  ) {
    throw new TypeError(`${label} last_30_days_count does not match profile value`);
  }
}

export function validateProfileObservations(snapshot) {
  assertObject(snapshot, "profile observations");
  assertIsoDateTime(snapshot.observedAt, "profile observations observedAt");
  if (!Array.isArray(snapshot.creators)) {
    throw new TypeError("profile observations creators must be an array");
  }
  if (snapshot.rowCount !== snapshot.creators.length) {
    throw new TypeError("profile observations rowCount must match creators.length");
  }

  const creatorIds = new Set();
  const accountKeys = new Set();
  for (const [index, creator] of snapshot.creators.entries()) {
    const label = `profile creator ${index}`;
    assertObject(creator, label);
    for (const key of ["creatorRecordId", "accountKey"]) {
      if (typeof creator[key] !== "string" || !creator[key].trim()) {
        throw new TypeError(`${label} ${key} is required`);
      }
    }
    if (creatorIds.has(creator.creatorRecordId)) {
      throw new TypeError(`profile creatorRecordId is duplicated: ${creator.creatorRecordId}`);
    }
    if (accountKeys.has(creator.accountKey)) {
      throw new TypeError(`profile accountKey is duplicated: ${creator.accountKey}`);
    }
    creatorIds.add(creator.creatorRecordId);
    accountKeys.add(creator.accountKey);
    assertIsoDateTime(creator.observedAt, `${label} observedAt`);

    assertObject(creator.profile, `${label} profile`);
    validateObservedCount(
      {
        value: creator.profile.followerCount,
        status: creator.profile.followerStatus,
        display: creator.profile.followerDisplay,
      },
      `${label} follower`,
    );
    validateObservedCount(
      {
        value: creator.profile.recentPostCount30d,
        status: creator.profile.recentPostStatus,
      },
      `${label} recent posts`,
      { rounded: false },
    );
    validateObservedValue(
      { value: creator.profile.latestPostAt, status: creator.profile.latestPostStatus },
      `${label} latest post`,
    );
    if (creator.profile.latestPostAt !== null) {
      assertIsoDateTime(creator.profile.latestPostAt, `${label} latestPostAt`);
    }
    validateObservedValue(
      { value: creator.profile.nickname, status: creator.profile.nicknameStatus },
      `${label} nickname`,
    );
    if (
      creator.profile.nickname !== null &&
      (typeof creator.profile.nickname !== "string" || !creator.profile.nickname.trim())
    ) {
      throw new TypeError(`${label} nickname must be non-empty text or null`);
    }
    validateObservedValue(
      { value: creator.profile.avatar, status: creator.profile.avatarStatus },
      `${label} avatar`,
    );
    if (creator.profile.avatar !== null) validateAvatar(creator.profile.avatar, `${label} avatar`);
    validateObservedValue(
      {
        value: creator.profile.featureObservationData,
        status: creator.profile.featureObservationStatus,
      },
      `${label} feature observation data`,
    );
    if (creator.profile.featureObservationData !== null) {
      validateFeatureObservationData(
        creator.profile.featureObservationData,
        `${label} feature observation data`,
        creator,
      );
    }
  }
  return snapshot;
}

