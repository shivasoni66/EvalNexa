import mongoose from 'mongoose';

/**
 * Safely normalizes an entity identifier (raw ObjectId, hex string, or populated Mongoose document / object containing _id)
 * into a canonical lowercase 24-character hexadecimal string, or null if empty/unresolvable.
 */
export function normalizeEntityId(rawId: unknown): string | null {
  if (!rawId) return null;

  // Case 1: Populated document or object containing `_id`
  if (typeof rawId === 'object' && rawId !== null && '_id' in rawId) {
    const subId = (rawId as { _id: unknown })._id;
    if (subId) {
      if (typeof subId === 'string') return subId.trim().toLowerCase();
      if (subId instanceof mongoose.Types.ObjectId) return subId.toHexString().toLowerCase();
      return String(subId).trim().toLowerCase();
    }
  }

  // Case 2: Raw Mongoose ObjectId
  if (rawId instanceof mongoose.Types.ObjectId) {
    return rawId.toHexString().toLowerCase();
  }

  // Case 3: String
  if (typeof rawId === 'string') {
    const trimmed = rawId.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
  }

  // Case 4: Any object that implements toHexString()
  if (
    typeof rawId === 'object' &&
    rawId !== null &&
    'toHexString' in rawId &&
    typeof (rawId as { toHexString: () => string }).toHexString === 'function'
  ) {
    return (rawId as { toHexString: () => string }).toHexString().toLowerCase();
  }

  return null;
}

/**
 * Checks whether two identifiers match after canonical normalization.
 */
export function areEntityIdsEqual(idA: unknown, idB: unknown): boolean {
  const normA = normalizeEntityId(idA);
  const normB = normalizeEntityId(idB);
  if (!normA || !normB) return false;
  return normA === normB;
}
