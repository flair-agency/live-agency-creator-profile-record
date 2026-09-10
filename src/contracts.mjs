import { validateProfileObservations as validateObservation } from './profile-observation.mjs';

// A recording request additionally binds observations to distinct destination records.
export function validateProfileObservations(snapshot) {
  validateObservation(snapshot);
  const identities = new Set();
  for (const [index, creator] of snapshot.creators.entries()) {
    if (typeof creator.creatorRecordId !== 'string' || !creator.creatorRecordId.trim()) {
      throw new TypeError(`profile creator ${index} creatorRecordId is required`);
    }
    if (identities.has(creator.creatorRecordId)) {
      throw new TypeError(`profile creatorRecordId is duplicated: ${creator.creatorRecordId}`);
    }
    identities.add(creator.creatorRecordId);
  }
  return snapshot;
}
