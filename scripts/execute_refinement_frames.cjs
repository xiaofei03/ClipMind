const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const sessionDirArg = process.argv[2];
if (!sessionDirArg) {
  console.error("Usage: node execute_refinement_frames.cjs <session-dir> [--plan=refinement_frame_plan.json] [--fps=2] [--max=48] [--activate] [--rescore]");
  process.exit(2);
}

const sessionDir = path.resolve(sessionDirArg);
const planPath = path.resolve(sessionDir, readArg("--plan", "refinement_frame_plan.json"));
const fps = clampNumber(Number(readArg("--fps", "")), 0.25, 8, null);
const maxAdditional = clampInteger(Number(readArg("--max", "")), 1, 300, null);
const activate = hasFlag("--activate") || hasFlag("--rescore");
const rescore = hasFlag("--rescore");
const outputs = readArg("--outputs", process.env.LEARNING_OUTPUTS || "markdown,article_html,word_docx,markmap");
const articleTemplate = readArg("--article-template", process.env.ARTICLE_TEMPLATE_MODE || "cover_markmap_article");

function readArg(name, fallback = "") {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function ensureInside(parent, target) {
  const parentResolved = path.resolve(parent);
  const targetResolved = path.resolve(target);
  const relative = path.relative(parentResolved, targetResolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside session: ${targetResolved}`);
  }
  return targetResolved;
}

function safeResetDir(dirPath) {
  const target = ensureInside(sessionDir, dirPath);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function listImageFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((name) => /\.(jpg|jpeg|png)$/i.test(name))
    .map((name) => path.join(dirPath, name))
    .sort();
}

function probeVideoPath(context) {
  const candidates = [
    context.videoPath,
    path.join(sessionDir, "video.mp4"),
    path.join(sessionDir, "video.webm"),
    path.join(sessionDir, "video.mov")
  ].filter(Boolean);
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error("Missing source video. Expected context.videoPath or video.mp4 in the session directory.");
  return found;
}

function buildOriginalManifest(originalFrames, originalManifest) {
  const byName = new Map(
    Array.isArray(originalManifest)
      ? originalManifest.map((item) => [path.basename(item.file || item.name || ""), item])
      : []
  );
  return originalFrames.map((file, index) => {
    const name = path.basename(file);
    const item = byName.get(name) || {};
    return {
      ...item,
      file,
      name,
      time: Number.isFinite(Number(item.time)) ? Number(item.time) : index,
      source: item.source || "original"
    };
  });
}

function timesFromPlan(plan) {
  const intervals = Array.isArray(plan?.refinementPlan?.intervals) ? plan.refinementPlan.intervals : [];
  const effectiveFps = fps || clampNumber(Number(plan?.refinementPlan?.recommendedFps), 0.25, 8, 2);
  const effectiveMax = maxAdditional || clampInteger(Number(plan?.refinementPlan?.maxAdditionalFrames), 1, 300, 48);
  const step = 1 / effectiveFps;
  const times = [];
  for (const interval of intervals) {
    const start = Math.max(0, Number(interval.start) || 0);
    const end = Math.max(start, Number(interval.end) || start);
    for (let time = start; time <= end + 0.001; time += step) {
      times.push({
        time: Number(time.toFixed(3)),
        reasons: Array.isArray(interval.reasons) ? interval.reasons : [],
        sources: Array.isArray(interval.sources) ? interval.sources : ["refinement_plan"]
      });
    }
  }
  const seen = new Set();
  return {
    fps: effectiveFps,
    maxAdditionalFrames: effectiveMax,
    intervals,
    times: times
      .filter((item) => {
        const key = item.time.toFixed(3);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, effectiveMax)
  };
}

function isNearExisting(time, manifest, tolerance = 0.2) {
  return manifest.some((item) => Math.abs(Number(item.time) - time) <= tolerance);
}

function runFfmpegFrame(videoPath, time, outputPath) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-y",
    "-ss",
    String(Math.max(0, time)),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    "-vf",
    "scale='min(1280,iw)':-2",
    outputPath
  ], {
    cwd: sessionDir,
    windowsHide: true,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed at ${time}s: ${(result.stderr || result.stdout || "").slice(0, 1200)}`);
  }
}

function copyOriginalFrames(originalManifest, refinedDir) {
  return originalManifest.map((item, index) => {
    const sourceFile = item.file;
    const name = path.basename(sourceFile || item.name || `original_${index + 1}.jpg`);
    const target = path.join(refinedDir, name);
    fs.copyFileSync(sourceFile, target);
    return {
      ...item,
      file: target,
      name,
      source: item.source || "original"
    };
  });
}

function activateRefinedManifest(refinedManifestPath) {
  const currentManifestPath = path.join(sessionDir, "frames_manifest.json");
  const backupPath = path.join(sessionDir, "frames_manifest.before_refinement.json");
  if (fs.existsSync(currentManifestPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(currentManifestPath, backupPath);
  }
  fs.copyFileSync(refinedManifestPath, currentManifestPath);
  return { currentManifestPath, backupPath };
}

function runRescore(refinedDir) {
  const args = [
    path.join("scripts", "extract_learning_summary.cjs"),
    sessionDir,
    refinedDir,
    `--outputs=${outputs}`,
    `--article-template=${articleTemplate}`
  ];
  const result = spawnSync("node", args, {
    cwd: path.resolve(__dirname, ".."),
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      LEARNING_OUTPUTS: outputs,
      ARTICLE_TEMPLATE_MODE: articleTemplate
    }
  });
  if (result.status !== 0) {
    throw new Error(`re-score failed: ${(result.stderr || result.stdout || "").slice(0, 2000)}`);
  }
  try {
    return JSON.parse((result.stdout || "").trim().split(/\r?\n/).pop() || "{}");
  } catch {
    return { raw: result.stdout };
  }
}

function main() {
  if (!fs.existsSync(sessionDir) || !fs.statSync(sessionDir).isDirectory()) {
    throw new Error(`Missing session directory: ${sessionDir}`);
  }
  if (!fs.existsSync(planPath)) {
    throw new Error(`Missing refinement plan: ${planPath}`);
  }

  const context = readJson(path.join(sessionDir, "context.json"), {});
  const plan = readJson(planPath, {});
  const videoPath = probeVideoPath(context);
  const originalFrameDir = path.join(sessionDir, "frames");
  const refinedDir = path.join(sessionDir, "frames_refined");
  const refinementOnlyDir = path.join(sessionDir, "frames_refinement_pass2");
  const originalFrames = listImageFiles(originalFrameDir);
  const originalManifest = buildOriginalManifest(originalFrames, readJson(path.join(sessionDir, "frames_manifest.json"), []));
  const extractionPlan = timesFromPlan(plan);

  safeResetDir(refinedDir);
  safeResetDir(refinementOnlyDir);

  const refinedManifest = copyOriginalFrames(originalManifest, refinedDir);
  const added = [];
  for (const item of extractionPlan.times) {
    if (isNearExisting(item.time, refinedManifest)) continue;
    const name = `refine_t${String(Math.round(item.time * 1000)).padStart(9, "0")}_${String(added.length + 1).padStart(4, "0")}.jpg`;
    const outputPath = path.join(refinementOnlyDir, name);
    runFfmpegFrame(videoPath, item.time, outputPath);
    const mergedPath = path.join(refinedDir, name);
    fs.copyFileSync(outputPath, mergedPath);
    const manifestItem = {
      file: mergedPath,
      name,
      time: item.time,
      source: "refinement_pass2",
      reasons: item.reasons,
      sources: item.sources
    };
    refinedManifest.push(manifestItem);
    added.push(manifestItem);
  }

  refinedManifest.sort((a, b) => Number(a.time) - Number(b.time));
  const refinedManifestPath = path.join(sessionDir, "frames_manifest_refined.json");
  fs.writeFileSync(refinedManifestPath, JSON.stringify(refinedManifest, null, 2), "utf8");

  let activation = null;
  if (activate) activation = activateRefinedManifest(refinedManifestPath);

  let rescoreResult = null;
  if (rescore) rescoreResult = runRescore(refinedDir);

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    sessionDir,
    planPath,
    videoPath,
    originalFrameDir,
    refinedDir,
    refinementOnlyDir,
    refinedManifestPath,
    originalFrameCount: originalManifest.length,
    plannedTimeCount: extractionPlan.times.length,
    addedFrameCount: added.length,
    finalFrameCount: refinedManifest.length,
    fps: extractionPlan.fps,
    maxAdditionalFrames: extractionPlan.maxAdditionalFrames,
    intervals: extractionPlan.intervals,
    added,
    activation,
    rescoreResult
  };
  const reportPath = path.join(sessionDir, "refinement_extract_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    ok: true,
    reportPath,
    refinedManifestPath,
    refinedDir,
    addedFrameCount: added.length,
    finalFrameCount: refinedManifest.length,
    activated: Boolean(activation),
    rescored: Boolean(rescoreResult)
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
