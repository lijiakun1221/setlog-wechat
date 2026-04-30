import { startOfNextHourIso } from "./time.js";

export const MAX_CLIP_SECONDS = 2;
export const COOLDOWN_MS = 60 * 60 * 1000;

export function validateClipInput({ durationSeconds, recordedAt }) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { ok: false, error: "durationSeconds must be a positive number." };
  }
  if (durationSeconds > MAX_CLIP_SECONDS) {
    return {
      ok: false,
      error: `Clip duration must be ${MAX_CLIP_SECONDS} seconds or less.`
    };
  }
  const parsed = new Date(recordedAt);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "recordedAt must be a valid ISO timestamp." };
  }
  return { ok: true };
}

export function buildCooldownState(clips, userId, now) {
  const nowDate = new Date(now);
  const userClips = clips
    .filter((clip) => clip.userId === userId)
    .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
  const lastClip = userClips[0];
  if (!lastClip) {
    return {
      allowed: true,
      lastClipAt: null,
      nextAllowedAt: null,
      remainingSeconds: 0
    };
  }
  const lastTime = new Date(lastClip.recordedAt);
  const diff = nowDate.getTime() - lastTime.getTime();
  if (diff >= COOLDOWN_MS) {
    return {
      allowed: true,
      lastClipAt: lastClip.recordedAt,
      nextAllowedAt: null,
      remainingSeconds: 0
    };
  }
  const remainingSeconds = Math.max(0, Math.ceil((COOLDOWN_MS - diff) / 1000));
  return {
    allowed: false,
    lastClipAt: lastClip.recordedAt,
    nextAllowedAt: startOfNextHourIso(lastClip.recordedAt),
    remainingSeconds
  };
}
