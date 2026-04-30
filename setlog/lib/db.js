import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");

const EMPTY_DB = {
  users: [],
  sessions: [],
  circles: [],
  circleMembers: [],
  logs: [],
  logMembers: [],
  uploadIntents: [],
  contents: [],
  mediaAssets: [],
  clips: [],
  dailyVlogs: [],
  reminders: []
};

let queue = Promise.resolve();

export function createDbQueue() {
  return queue;
}

export async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  try {
    await access(DB_FILE);
  } catch {
    await writeDb(structuredClone(EMPTY_DB));
  }
}

export async function readDb() {
  await ensureDataDir();
  const raw = await readFile(DB_FILE, "utf8");
  return normalizeDb(JSON.parse(raw));
}

export async function writeDb(db) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(normalizeDb(db), null, 2), "utf8");
}

export async function updateDb(dbQueue, mutator) {
  queue = queue.then(async () => {
    const current = await readDb();
    const draft = structuredClone(current);
    const result = await mutator(draft);
    if (result && result.error) {
      return result;
    }
    await writeDb(draft);
    return result || draft;
  });
  return queue.catch((error) => {
    queue = Promise.resolve();
    throw error;
  });
}

export function uploadPathForId(uploadId) {
  return path.join(UPLOAD_DIR, `${uploadId}.bin`);
}

function normalizeDb(db) {
  return {
    users: Array.isArray(db.users) ? db.users : [],
    sessions: Array.isArray(db.sessions) ? db.sessions : [],
    circles: Array.isArray(db.circles) ? db.circles : [],
    circleMembers: Array.isArray(db.circleMembers) ? db.circleMembers : [],
    logs: Array.isArray(db.logs) ? db.logs : [],
    logMembers: Array.isArray(db.logMembers) ? db.logMembers : [],
    uploadIntents: Array.isArray(db.uploadIntents) ? db.uploadIntents : [],
    contents: Array.isArray(db.contents) ? db.contents : [],
    mediaAssets: Array.isArray(db.mediaAssets) ? db.mediaAssets : [],
    clips: Array.isArray(db.clips) ? db.clips : [],
    dailyVlogs: Array.isArray(db.dailyVlogs) ? db.dailyVlogs : [],
    reminders: Array.isArray(db.reminders) ? db.reminders : []
  };
}
