import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";

const ARTIFACT_DIR = path.join(process.cwd(), "data", "artifacts");

export function createDailyVlogPlan({ userId, dateKey, timeZone, clips }) {
  const manifest = {
    userId,
    dateKey,
    timeZone,
    generatedAt: new Date().toISOString(),
    clipCount: clips.length,
    clips: clips.map((clip, index) => ({
      index,
      clipId: clip.id,
      uploadId: clip.uploadId,
      recordedAt: clip.recordedAt,
      note: clip.note || "",
      durationSeconds: clip.durationSeconds,
      storageUrl: clip.storageUrl
    })),
    ffmpeg: {
      format: "concat",
      music: "optional",
      captions: "optional"
    }
  };

  const concatList = clips
    .map((clip) => `file '${clip.storagePath || clip.storageUrl || clip.id}'`)
    .join("\n");

  return {
    manifest,
    concatList,
    outputBaseName: `daily_${userId}_${dateKey}_${crypto.randomUUID().slice(0, 8)}`
  };
}

export async function composeDailyVlog(plan) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  if (await hasRenderableInputs(plan)) {
    const outputPath = path.join(ARTIFACT_DIR, `${plan.outputBaseName}.mp4`);
    const listPath = path.join(ARTIFACT_DIR, `${plan.outputBaseName}.txt`);
    await writeFile(listPath, plan.concatList, "utf8");
    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      outputPath
    ]);
    return {
      status: "rendered",
      manifest: plan.manifest,
      outputPath,
      outputUrl: `/data/artifacts/${path.basename(outputPath)}`
    };
  }

  const outputPath = path.join(ARTIFACT_DIR, `${plan.outputBaseName}.json`);
  const payload = {
    status: "planned",
    createdAt: new Date().toISOString(),
    manifest: plan.manifest,
    concatList: plan.concatList,
    note:
      "FFmpeg is not available or the clips do not have local file paths yet, so this MVP stores a composition plan instead of rendering a binary video."
  };
  await writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
  return {
    status: "planned",
    manifest: plan.manifest,
    outputPath,
    outputUrl: `/data/artifacts/${path.basename(outputPath)}`
  };
}

export async function hasFfmpeg() {
  try {
    const binary = process.env.FFMPEG_BIN || "ffmpeg";
    await runFfmpeg(["-version"], binary);
    return true;
  } catch {
    return false;
  }
}

async function hasRenderableInputs(plan) {
  const allPathsExist = plan?.manifest?.clips?.every((clip) => Boolean(clip.storageUrl || clip.storagePath));
  return (await hasFfmpeg()) && allPathsExist;
}

function runFfmpeg(args, binary = process.env.FFMPEG_BIN || "ffmpeg") {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
