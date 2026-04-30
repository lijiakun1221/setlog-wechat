import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";

import {
  DEFAULT_TIME_ZONE,
  clipDateKey,
  clipHourKey,
  nowIso,
  startOfNextHourIso
} from "./lib/time.js";
import {
  MAX_CLIP_SECONDS,
  buildCooldownState,
  validateClipInput
} from "./lib/policy.js";
import {
  createDailyVlogPlan,
  composeDailyVlog
} from "./lib/composer.js";
import {
  createDbQueue,
  ensureDataDir,
  readDb,
  updateDb,
  writeDb,
  uploadPathForId
} from "./lib/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const dbQueue = createDbQueue();

await ensureDataDir();
await seedDb();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const sessionId = String(req.headers["x-session-id"] || "").trim();

    if (req.method === "GET" && url.pathname === "/") {
      return serveStatic(path.join("public", "index.html"), res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      return serveStatic(url.pathname.replace("/assets/", "public/"), res);
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "setlog-mvp",
        timeZone: DEFAULT_TIME_ZONE,
        maxClipSeconds: MAX_CLIP_SECONDS
      });
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const db = await readDb();
      const currentSession = sessionId ? db.sessions.find((entry) => entry.id === sessionId) : null;
      const currentUser = currentSession ? db.users.find((entry) => entry.id === currentSession.userId) : null;
      return sendJson(res, 200, {
        ok: true,
        timeZone: DEFAULT_TIME_ZONE,
        maxClipSeconds: MAX_CLIP_SECONDS,
        users: db.users,
        currentSession: currentSession || null,
        currentUser: currentUser || null,
        logs: db.logs,
        logMembers: db.logMembers,
        circles: db.circles,
        circleMembers: db.circleMembers,
        contents: db.contents,
        clips: db.clips,
        dailyVlogs: db.dailyVlogs,
        mediaAssets: db.mediaAssets
      });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/wechat-login") {
      const body = await readJson(req);
      const code = String(body.code || "").trim();
      const nickname = String(body.nickname || body.name || "微信用户").trim() || "微信用户";
      const avatarUrl = String(body.avatarUrl || "").trim();
      if (!code) {
        return sendJson(res, 400, { ok: false, error: "code is required." });
      }
      const auth = await updateDb(dbQueue, (draft) => {
        const openid = hashToId(`openid:${code}`, 16);
        let user = draft.users.find((entry) => entry.openid === openid);
        if (!user) {
          user = {
            id: `user_${hashToId(openid, 12)}`,
            openid,
            name: nickname,
            avatarUrl: avatarUrl || `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(nickname)}`,
            createdAt: nowIso(),
            lastLoginAt: nowIso()
          };
          draft.users.push(user);
        } else {
          user.name = nickname || user.name;
          user.avatarUrl = avatarUrl || user.avatarUrl;
          user.lastLoginAt = nowIso();
        }
        const session = {
          id: `sess_${hashToId(`${openid}:${nowIso()}`, 18)}`,
          userId: user.id,
          openid,
          createdAt: nowIso()
        };
        draft.sessions.push(session);
        return { ok: true, user, session };
      });
      return sendJson(res, 200, {
        ok: true,
        userId: auth.user.id,
        sessionId: auth.session.id,
        user: auth.user,
        session: auth.session
      });
    }

    if (req.method === "GET" && url.pathname === "/api/auth/session") {
      const db = await readDb();
      const currentSession = sessionId ? db.sessions.find((entry) => entry.id === sessionId) : null;
      if (!currentSession) {
        return sendJson(res, 200, { ok: true, authenticated: false, user: null, session: null });
      }
      const user = db.users.find((entry) => entry.id === currentSession.userId) || null;
      return sendJson(res, 200, { ok: true, authenticated: Boolean(user), user, session: currentSession });
    }

    if (req.method === "GET" && url.pathname === "/api/users") {
      const db = await readDb();
      return sendJson(res, 200, { ok: true, users: db.users });
    }

    if (req.method === "GET" && url.pathname === "/api/users/me") {
      const db = await readDb();
      const currentSession = sessionId ? db.sessions.find((entry) => entry.id === sessionId) : null;
      const user = currentSession ? db.users.find((entry) => entry.id === currentSession.userId) : null;
      if (!user) {
        return sendJson(res, 401, { ok: false, error: "Not authenticated." });
      }
      return sendJson(res, 200, { ok: true, user, session: currentSession });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/users/")) {
      const userId = url.pathname.split("/").pop();
      const db = await readDb();
      const user = db.users.find((entry) => entry.id === userId);
      if (!user) {
        return sendJson(res, 404, { ok: false, error: "User not found." });
      }
      return sendJson(res, 200, { ok: true, user });
    }

    if (req.method === "GET" && url.pathname === "/api/circles") {
      const db = await readDb();
      const circles = db.circles.map((circle) => ({
        ...circle,
        memberCount: db.circleMembers.filter((entry) => entry.circleId === circle.id).length
      }));
      return sendJson(res, 200, { ok: true, circles });
    }

    if (req.method === "GET" && url.pathname === "/api/contents") {
      const circleId = String(url.searchParams.get("circleId") || "").trim();
      const userId = String(url.searchParams.get("userId") || "").trim();
      const db = await readDb();
      const contents = db.contents
        .filter((entry) => (!circleId || entry.circleId === circleId) && (!userId || entry.userId === userId))
        .map((entry) => ({
          ...entry,
          user: db.users.find((user) => user.id === entry.userId) || null,
          circle: db.circles.find((circle) => circle.id === entry.circleId) || null,
          media: db.mediaAssets.find((media) => media.id === entry.mediaId) || null
        }))
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      return sendJson(res, 200, { ok: true, contents });
    }

    if (req.method === "POST" && url.pathname === "/api/circles") {
      const body = await readJson(req);
      const name = String(body.name || "").trim();
      const description = String(body.description || "").trim();
      const ownerId = String(body.ownerId || "").trim();
      if (!name) {
        return sendJson(res, 400, { ok: false, error: "Circle name is required." });
      }
      const created = await updateDb(dbQueue, (draft) => {
        const resolvedOwnerId = ownerId || resolveCurrentUserId(draft, req, sessionId);
        if (!resolvedOwnerId) {
          return { error: "ownerId or session is required." };
        }
        const owner = draft.users.find((entry) => entry.id === resolvedOwnerId);
        if (!owner) {
          return { error: "Owner user was not found." };
        }
        const circle = {
          id: `circle_${crypto.randomUUID().slice(0, 8)}`,
          name,
          description,
          ownerId: resolvedOwnerId,
          createdAt: nowIso()
        };
        draft.circles.push(circle);
        draft.circleMembers.push({
          circleId: circle.id,
          userId: resolvedOwnerId,
          role: "owner",
          joinedAt: nowIso()
        });
        return { ok: true, circle };
      });
      if (created.error) {
        return sendJson(res, 404, { ok: false, error: created.error });
      }
      return sendJson(res, 201, created);
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/circles\/[^/]+\/join$/)) {
      const body = await readJson(req);
      const circleId = url.pathname.split("/")[3];
      const userId = String(body.userId || "").trim();
      const joined = await updateDb(dbQueue, (draft) => {
        const resolvedUserId = userId || resolveCurrentUserId(draft, req, sessionId);
        if (!resolvedUserId) {
          return { error: "userId or session is required." };
        }
        const user = draft.users.find((entry) => entry.id === resolvedUserId);
        const circle = draft.circles.find((entry) => entry.id === circleId);
        if (!user || !circle) {
          return { error: "User or circle not found." };
        }
        const exists = draft.circleMembers.some((entry) => entry.circleId === circleId && entry.userId === resolvedUserId);
        if (!exists) {
          draft.circleMembers.push({
            circleId,
            userId: resolvedUserId,
            role: "member",
            joinedAt: nowIso()
          });
        }
        return { ok: true };
      });
      if (joined.error) {
        return sendJson(res, 404, { ok: false, error: joined.error });
      }
      return sendJson(res, 200, joined);
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/circles\/[^/]+\/members$/)) {
      const circleId = url.pathname.split("/")[3];
      const db = await readDb();
      const circle = db.circles.find((entry) => entry.id === circleId);
      if (!circle) {
        return sendJson(res, 404, { ok: false, error: "Circle not found." });
      }
      const members = db.circleMembers
        .filter((entry) => entry.circleId === circleId)
        .map((entry) => ({
          ...entry,
          user: db.users.find((user) => user.id === entry.userId) || null
        }));
      return sendJson(res, 200, { ok: true, circle, members });
    }

    if (req.method === "PATCH" && url.pathname.match(/^\/api\/circles\/[^/]+\/members\/[^/]+$/)) {
      const parts = url.pathname.split("/");
      const circleId = parts[3];
      const userId = parts[5];
      const body = await readJson(req);
      const role = String(body.role || "").trim();
      const updated = await updateDb(dbQueue, (draft) => {
        const member = draft.circleMembers.find((entry) => entry.circleId === circleId && entry.userId === userId);
        if (!member) {
          return { error: "Circle member not found." };
        }
        if (role) {
          member.role = role;
        }
        return { ok: true, member };
      });
      if (updated.error) {
        return sendJson(res, 404, { ok: false, error: updated.error });
      }
      return sendJson(res, 200, updated);
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/circles\/[^/]+\/members\/[^/]+$/)) {
      const parts = url.pathname.split("/");
      const circleId = parts[3];
      const userId = parts[5];
      const removed = await updateDb(dbQueue, (draft) => {
        const before = draft.circleMembers.length;
        draft.circleMembers = draft.circleMembers.filter(
          (entry) => !(entry.circleId === circleId && entry.userId === userId)
        );
        if (draft.circleMembers.length === before) {
          return { error: "Circle member not found." };
        }
        return { ok: true };
      });
      if (removed.error) {
        return sendJson(res, 404, { ok: false, error: removed.error });
      }
      return sendJson(res, 200, removed);
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      const db = await readDb();
      return sendJson(res, 200, {
        ok: true,
        logs: db.logs.map((log) => ({
          ...log,
          memberCount: db.logMembers.filter((entry) => entry.logId === log.id).length
        }))
      });
    }

    if (req.method === "POST" && url.pathname === "/api/logs") {
      const body = await readJson(req);
      const name = String(body.name || "").trim();
      const ownerId = String(body.ownerId || "").trim();
      if (!name) {
        return sendJson(res, 400, { ok: false, error: "Log name is required." });
      }
      if (!ownerId) {
        return sendJson(res, 400, { ok: false, error: "ownerId is required." });
      }
      const db = await updateDb(dbQueue, (draft) => {
        const owner = draft.users.find((user) => user.id === ownerId);
        if (!owner) {
          return { error: "Owner user was not found." };
        }
        const log = {
          id: `log_${crypto.randomUUID().slice(0, 8)}`,
          name,
          ownerId,
          createdAt: nowIso()
        };
        draft.logs.push(log);
        draft.logMembers.push({
          logId: log.id,
          userId: ownerId,
          role: "owner",
          joinedAt: nowIso()
        });
        const existingCircle = draft.circles.find((entry) => entry.id === log.id);
        if (!existingCircle) {
          draft.circles.push({
            id: log.id,
            name,
            description: "",
            ownerId,
            createdAt: log.createdAt
          });
        }
        const hasCircleOwner = draft.circleMembers.some((entry) => entry.circleId === log.id && entry.userId === ownerId);
        if (!hasCircleOwner) {
          draft.circleMembers.push({
            circleId: log.id,
            userId: ownerId,
            role: "owner",
            joinedAt: nowIso()
          });
        }
        return { ok: true, data: log };
      });
      if (db.error) {
        return sendJson(res, 404, { ok: false, error: db.error });
      }
      return sendJson(res, 201, db);
    }

    if (req.method === "POST" && url.pathname === "/api/log-members") {
      const body = await readJson(req);
      const userId = String(body.userId || "").trim();
      const logId = String(body.logId || "").trim();
      if (!userId || !logId) {
        return sendJson(res, 400, { ok: false, error: "userId and logId are required." });
      }
      const result = await updateDb(dbQueue, (draft) => {
        const user = draft.users.find((entry) => entry.id === userId);
        const log = draft.logs.find((entry) => entry.id === logId);
        if (!user || !log) {
          return { error: "User or log not found." };
        }
        const exists = draft.logMembers.some((entry) => entry.userId === userId && entry.logId === logId);
        if (!exists) {
          draft.logMembers.push({
            userId,
            logId,
            role: "member",
            joinedAt: nowIso()
          });
        }
        const circle = draft.circles.find((entry) => entry.id === logId);
        if (circle) {
          const circleExists = draft.circleMembers.some((entry) => entry.userId === userId && entry.circleId === circle.id);
          if (!circleExists) {
            draft.circleMembers.push({
              userId,
              circleId: circle.id,
              role: "member",
              joinedAt: nowIso()
            });
          }
        }
        return { ok: true };
      });
      if (result.error) {
        return sendJson(res, 404, { ok: false, error: result.error });
      }
      return sendJson(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/api/timeline") {
      const userId = String(url.searchParams.get("userId") || "").trim();
      const logId = String(url.searchParams.get("logId") || "").trim();
      const date = String(url.searchParams.get("date") || "").trim();
      const db = await readDb();
      const clips = db.clips
        .filter((clip) => (!userId || clip.userId === userId) && (!logId || clip.logId === logId))
        .filter((clip) => !date || clip.dateKey === date)
        .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());
      return sendJson(res, 200, { ok: true, clips });
    }

    if (req.method === "POST" && url.pathname === "/api/upload-intents") {
      const body = await readJson(req);
      const userId = String(body.userId || "").trim();
      const circleId = String(body.circleId || body.logId || "").trim();
      const durationSeconds = Number(body.durationSeconds || MAX_CLIP_SECONDS);
      const recordedAt = String(body.recordedAt || nowIso());
      const note = String(body.note || "").trim();
      const timezone = String(body.timeZone || DEFAULT_TIME_ZONE);
      const validation = validateClipInput({ durationSeconds, recordedAt });
      if (!validation.ok) {
        return sendJson(res, 400, validation);
      }
      const db = await readDb();
      const user = db.users.find((entry) => entry.id === userId);
      const circle = db.circles.find((entry) => entry.id === circleId) || db.logs.find((entry) => entry.id === circleId);
      if (!user || !circle) {
        return sendJson(res, 404, { ok: false, error: "User or circle not found." });
      }
      const membership = db.circleMembers.some((entry) => entry.userId === userId && entry.circleId === circleId) ||
        db.logMembers.some((entry) => entry.userId === userId && entry.logId === circleId);
      if (!membership) {
        return sendJson(res, 403, { ok: false, error: "User is not a member of this circle." });
      }
      const cooldown = buildCooldownState(db.clips, userId, recordedAt);
      if (!cooldown.allowed) {
        return sendJson(res, 409, {
          ok: false,
          error: "Upload is still in the hourly cooldown window.",
          nextAllowedAt: cooldown.nextAllowedAt,
          remainingSeconds: cooldown.remainingSeconds
        });
      }
      const uploadId = `upl_${crypto.randomUUID().slice(0, 12)}`;
      const clipId = `clip_${crypto.randomUUID().slice(0, 12)}`;
      const uploadUrl = `/api/uploads/${uploadId}`;
      const uploadMeta = {
        uploadId,
        clipId,
        userId,
        circleId,
        durationSeconds,
        recordedAt,
        note,
        timeZone: timezone,
        dateKey: clipDateKey(recordedAt, timezone),
        hourKey: clipHourKey(recordedAt, timezone),
        status: "pending",
        storageProvider: getStorageProvider(),
        storageBucket: process.env.STORAGE_BUCKET || null
      };
      const next = await updateDb(dbQueue, (draft) => {
        draft.uploadIntents.push(uploadMeta);
        return { ok: true, uploadId, clipId, uploadUrl, uploadMeta };
      });
      return sendJson(res, 201, next);
    }

    if ((req.method === "PUT" || req.method === "POST") && url.pathname.startsWith("/api/uploads/")) {
      const uploadId = url.pathname.split("/").pop();
      const db = await readDb();
      const intent = db.uploadIntents.find((entry) => entry.uploadId === uploadId);
      if (!intent) {
        return sendJson(res, 404, { ok: false, error: "Upload intent not found." });
      }
      const targetPath = uploadPathForId(uploadId);
      await mkdir(path.dirname(targetPath), { recursive: true });
      const uploadResult =
        req.method === "POST" && isMultipart(req.headers["content-type"])
          ? await writeMultipartUpload(req, targetPath)
          : await writeStreamUpload(req, targetPath);
      const size = uploadResult.size;
      const contentType = uploadResult.contentType || String(req.headers["content-type"] || "application/octet-stream");
      const clip = {
        id: intent.clipId,
        uploadId,
        userId: intent.userId,
        logId: intent.circleId,
        circleId: intent.circleId,
        recordedAt: intent.recordedAt,
        createdAt: nowIso(),
        durationSeconds: intent.durationSeconds,
        note: intent.note,
        dateKey: intent.dateKey,
        hourKey: intent.hourKey,
        storagePath: targetPath,
        storageUrl: buildStorageUrl(path.basename(targetPath)),
        storageProvider: intent.storageProvider || getStorageProvider(),
        storageKey: path.basename(targetPath),
        storageBucket: intent.storageBucket || null,
        contentLength: size,
        contentType
      };
      const updated = await updateDb(dbQueue, (draft) => {
        const publishedAt = nowIso();
        const content = {
          id: `content_${crypto.randomUUID().slice(0, 12)}`,
          userId: clip.userId,
          circleId: clip.circleId,
          mediaId: clip.id,
          uploadId: clip.uploadId,
          note: clip.note,
          publishedAt,
          recordedAt: clip.recordedAt,
          createdAt: publishedAt,
          contentType: clip.contentType,
          contentLength: clip.contentLength,
          storageProvider: clip.storageProvider,
          storageBucket: clip.storageBucket,
          storageKey: clip.storageKey,
          storageUrl: clip.storageUrl
        };
        draft.clips.push(clip);
        draft.contents.push(content);
        draft.mediaAssets.push({
          id: clip.id,
          type: "video",
          provider: clip.storageProvider,
          storageKey: clip.storageKey,
          storageUrl: clip.storageUrl,
          storageBucket: clip.storageBucket,
          contentType: clip.contentType,
          contentLength: clip.contentLength,
          createdAt: clip.createdAt,
          userId: clip.userId,
          logId: clip.logId
        });
        draft.uploadIntents = draft.uploadIntents.filter((entry) => entry.uploadId !== uploadId);
        return { ok: true, clip, content };
      });
      return sendJson(res, 201, updated);
    }

    if (req.method === "GET" && url.pathname === "/api/media") {
      const db = await readDb();
      const media = db.mediaAssets
        .map((asset) => ({
          ...asset,
          user: db.users.find((entry) => entry.id === asset.userId) || null,
          log: db.logs.find((entry) => entry.id === asset.logId) || null
        }))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return sendJson(res, 200, { ok: true, media });
    }

    if (req.method === "GET" && url.pathname === "/api/reminders") {
      const userId = String(url.searchParams.get("userId") || "").trim();
      const db = await readDb();
      const cooldown = buildCooldownState(db.clips, userId, nowIso());
      return sendJson(res, 200, { ok: true, ...cooldown });
    }

    if (req.method === "POST" && url.pathname === "/api/daily-vlogs/generate") {
      const body = await readJson(req);
      const userId = String(body.userId || "").trim();
      const dateKey = String(body.date || clipDateKey(nowIso(), DEFAULT_TIME_ZONE));
      const timeZone = String(body.timeZone || DEFAULT_TIME_ZONE);
      const db = await readDb();
      const user = db.users.find((entry) => entry.id === userId);
      if (!user) {
        return sendJson(res, 404, { ok: false, error: "User not found." });
      }
      const clips = db.clips
        .filter((clip) => clip.userId === userId && clip.dateKey === dateKey)
        .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());
      const plan = createDailyVlogPlan({ userId, dateKey, timeZone, clips });
      const result = await composeDailyVlog(plan);
      const dailyVlog = {
        id: `vlog_${crypto.randomUUID().slice(0, 12)}`,
        userId,
        dateKey,
        timeZone,
        clipIds: clips.map((clip) => clip.id),
        status: result.status,
        manifest: result.manifest,
        outputPath: result.outputPath || null,
        outputUrl: result.outputUrl || null,
        createdAt: nowIso()
      };
      const saved = await updateDb(dbQueue, (draft) => {
        draft.dailyVlogs.push(dailyVlog);
        return { ok: true, dailyVlog };
      });
      return sendJson(res, 201, {
        ok: true,
        dailyVlog: saved.dailyVlog,
        result: saved
      });
    }

    if (req.method === "GET" && url.pathname === "/api/daily-vlogs") {
      const userId = String(url.searchParams.get("userId") || "").trim();
      const date = String(url.searchParams.get("date") || "").trim();
      const db = await readDb();
      const dailyVlogs = db.dailyVlogs
        .filter((entry) => (!userId || entry.userId === userId) && (!date || entry.dateKey === date))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return sendJson(res, 200, { ok: true, dailyVlogs });
    }

    if (req.method === "GET" && url.pathname.startsWith("/data/uploads/")) {
      return serveDataFile(url.pathname, res);
    }

    return sendJson(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

const HOST = process.env.HOST || "127.0.0.1";

server.listen(PORT, HOST, () => {
  console.log(`setlog MVP running at http://${HOST}:${PORT}`);
});

async function seedDb() {
  const current = await readDb();
  if (current.users.length > 0) {
    return;
  }
  const alice = {
    id: "user_alice",
    name: "Alice",
    avatarUrl: "https://api.dicebear.com/9.x/thumbs/svg?seed=Alice",
    createdAt: nowIso()
  };
  const bob = {
    id: "user_bob",
    name: "Bob",
    avatarUrl: "https://api.dicebear.com/9.x/thumbs/svg?seed=Bob",
    createdAt: nowIso()
  };
  const log = {
    id: "log_daily",
    name: "Daily Light",
    ownerId: alice.id,
    createdAt: nowIso()
  };
  const circle = {
    id: log.id,
    name: log.name,
    description: "Compatibility seed circle for the current MVP.",
    ownerId: alice.id,
    createdAt: log.createdAt
  };
  const clip = {
    id: "clip_seed_1",
    uploadId: "upl_seed_1",
    userId: alice.id,
    logId: log.id,
    circleId: circle.id,
    recordedAt: nowIso(),
    createdAt: nowIso(),
    durationSeconds: 2,
    note: "Seed clip for a fresh timeline.",
    dateKey: clipDateKey(nowIso(), DEFAULT_TIME_ZONE),
    hourKey: clipHourKey(nowIso(), DEFAULT_TIME_ZONE),
    storagePath: null,
    storageUrl: null,
    contentLength: 0,
    contentType: "video/mp4"
  };
  const content = {
    id: "content_seed_1",
    userId: alice.id,
    circleId: circle.id,
    mediaId: clip.id,
    uploadId: clip.uploadId,
    note: clip.note,
    publishedAt: clip.createdAt,
    recordedAt: clip.recordedAt,
    createdAt: clip.createdAt,
    contentType: clip.contentType,
    contentLength: clip.contentLength,
    storageProvider: "local",
    storageBucket: null,
    storageKey: null,
    storageUrl: null
  };
  await writeDb({
    users: [alice, bob],
    sessions: [],
    circles: [circle],
    circleMembers: [
      { circleId: circle.id, userId: alice.id, role: "owner", joinedAt: nowIso() },
      { circleId: circle.id, userId: bob.id, role: "member", joinedAt: nowIso() }
    ],
    logs: [log],
    logMembers: [
      { userId: alice.id, logId: log.id, role: "owner", joinedAt: nowIso() },
      { userId: bob.id, logId: log.id, role: "member", joinedAt: nowIso() }
    ],
    uploadIntents: [],
    contents: [content],
    mediaAssets: [],
    clips: [clip],
    dailyVlogs: [],
    reminders: []
  });
}

async function serveStatic(relativePath, res) {
  const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(__dirname, normalized);
  try {
    const contents = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml"
    }[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-store"
    });
    res.end(contents);
  } catch {
    sendJson(res, 404, { ok: false, error: "Asset not found." });
  }
}

async function serveDataFile(urlPath, res) {
  const target = path.join(process.cwd(), urlPath);
  try {
    const contents = await readFile(target);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(contents);
  } catch {
    sendJson(res, 404, { ok: false, error: "Data file not found." });
  }
}

function isMultipart(contentType) {
  return String(contentType || "").toLowerCase().includes("multipart/form-data");
}

async function writeStreamUpload(req, targetPath) {
  await pipeline(req, createWriteStream(targetPath));
  const size = (await stat(targetPath)).size;
  return { size };
}

async function writeMultipartUpload(req, targetPath) {
  const contentType = String(req.headers["content-type"] || "");
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) {
    throw new Error("Missing multipart boundary.");
  }
  const boundary = boundaryMatch[1];
  const buffer = await readRequestBuffer(req);
  const filePart = extractMultipartFile(buffer, boundary);
  if (!filePart) {
    throw new Error("No file part was found in the multipart upload.");
  }
  await writeFile(targetPath, filePart.data);
  return {
    size: filePart.data.length,
    contentType: filePart.contentType || "application/octet-stream"
  };
}

async function readRequestBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function extractMultipartFile(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  let offset = buffer.indexOf(delimiter);
  while (offset !== -1) {
    const headerStart = offset + delimiter.length + 2;
    const nextBoundary = buffer.indexOf(delimiter, headerStart);
    const headerEnd = buffer.indexOf(headerSeparator, headerStart);
    if (headerEnd === -1 || nextBoundary === -1) {
      break;
    }
    const headerText = buffer.slice(headerStart, headerEnd).toString("utf8");
    const contentStart = headerEnd + headerSeparator.length;
    const contentEnd = nextBoundary - 2;
    if (/filename="/i.test(headerText)) {
      const contentTypeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
      return {
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : null,
        data: buffer.slice(contentStart, contentEnd)
      };
    }
    offset = nextBoundary;
  }
  return null;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function resolveCurrentUserId(db, req, sessionId) {
  const explicitUserId = String(req.headers["x-user-id"] || "").trim();
  if (explicitUserId) {
    return explicitUserId;
  }
  if (db && sessionId) {
    const session = db.sessions?.find((entry) => entry.id === sessionId);
    return session ? session.userId : "";
  }
  return "";
}

function getStorageProvider() {
  return process.env.STORAGE_PROVIDER || "local";
}

function buildStorageUrl(fileName) {
  const publicBaseUrl = String(process.env.STORAGE_PUBLIC_BASE_URL || "").trim();
  if (publicBaseUrl) {
    return `${publicBaseUrl.replace(/\/+$/, "")}/${fileName}`;
  }
  return `/data/uploads/${fileName}`;
}

function hashToId(value, length = 12) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}
