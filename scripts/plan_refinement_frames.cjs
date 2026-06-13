const fs = require("fs");
const path = require("path");

const sessionDir = process.argv[2];
if (!sessionDir) {
  console.error("Usage: node plan_refinement_frames.cjs <session-dir> [--out=refinement_frame_plan.json]");
  process.exit(2);
}

const outArg = process.argv.find((arg) => arg.startsWith("--out="));
const outPath = path.resolve(sessionDir, outArg ? outArg.slice("--out=".length) : "refinement_frame_plan.json");

const REQUIRED_COVERAGE = [
  {
    key: "tool",
    label: "工具或平台",
    categories: ["tool"],
    keywords: ["工具", "平台", "Codex", "Cursor", "Trae", "Claude", "Qwen", "React Bits", "Vite"]
  },
  {
    key: "prompt",
    label: "完整或半完整 Prompt",
    categories: ["prompt"],
    keywords: ["prompt", "Prompt", "提示词", "复制", "粘贴", "请帮我", "生成"]
  },
  {
    key: "code",
    label: "代码、命令或文件结构",
    categories: ["code"],
    keywords: ["代码", "命令", "npm", "pnpm", "src/", "package.json", "main.js", "index.html", "终端"]
  },
  {
    key: "workflow",
    label: "操作步骤",
    categories: ["workflow"],
    keywords: ["步骤", "首先", "然后", "接下来", "打开", "运行", "修改", "优化"]
  },
  {
    key: "result",
    label: "输出结果或作品效果",
    categories: ["result"],
    keywords: ["结果", "预览", "效果", "完成", "部署", "上线", "作品"]
  },
  {
    key: "problem",
    label: "错误、风险或修正",
    categories: ["problem"],
    keywords: ["错误", "失败", "报错", "修复", "问题", "注意", "风险", "避坑"]
  }
];

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const wanted = new Set(exts.map((ext) => ext.toLowerCase()));
  return fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => wanted.has(path.extname(file).toLowerCase()))
    .sort();
}

function parseTimestamp(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number((match[4] || "0").padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function parseSubtitleTimeline(text) {
  const cues = [];
  const normalized = String(text || "").replace(/\r/g, "");
  const blocks = normalized.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeLine = lines.find((line) => line.includes("-->"));
    if (!timeLine) continue;
    const [startRaw, endRaw] = timeLine.split("-->").map((part) => part.trim());
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    if (start === null) continue;
    const textLines = lines.filter((line) => line !== timeLine && !/^\d+$/.test(line));
    cues.push({
      start,
      end: end === null ? start + 2 : end,
      text: textLines.join(" ")
    });
  }
  return cues;
}

function loadSubtitleTimeline() {
  const subtitleDir = path.join(sessionDir, "subtitles");
  const files = listFiles(subtitleDir, [".srt", ".vtt"]);
  const cues = [];
  for (const file of files) {
    for (const cue of parseSubtitleTimeline(readText(file))) {
      cues.push({ ...cue, source: path.basename(file) });
    }
  }
  const context = readJson(path.join(sessionDir, "context.json"), {});
  const transcriptText = context?.transcript?.text || "";
  if (transcriptText && !cues.length) {
    cues.push({ start: 0, end: 0, text: transcriptText.slice(0, 20000), source: "transcript_text_without_timestamps" });
  }
  const pageText = context?.subtitleText || context?.metadata?.description || "";
  if (pageText && !cues.length) {
    cues.push({ start: 0, end: 0, text: String(pageText).slice(0, 20000), source: "page_text_without_timestamps" });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function hasCategory(item, categories) {
  const itemCategories = Array.isArray(item.categories) ? item.categories : [];
  return categories.some((category) => itemCategories.includes(category));
}

function textContains(text, keywords) {
  const haystack = String(text || "").toLowerCase();
  return keywords.some((keyword) => haystack.includes(String(keyword).toLowerCase()));
}

function evidenceText(item) {
  return [
    item.title,
    item.whyImportant,
    item.visibleText,
    item.promptText,
    Array.isArray(item.toolNames) ? item.toolNames.join(" ") : "",
    Array.isArray(item.actions) ? item.actions.join(" ") : ""
  ].join(" ");
}

function coverageFor(requirement, selectedEvidence, allEvidence) {
  const selectedHits = selectedEvidence.filter((item) =>
    hasCategory(item, requirement.categories) || textContains(evidenceText(item), requirement.keywords)
  );
  const allHits = allEvidence.filter((item) =>
    hasCategory(item, requirement.categories) || textContains(evidenceText(item), requirement.keywords)
  );
  return {
    ok: selectedHits.length > 0,
    selectedHits: selectedHits.map((item) => ({
      frameId: item.frameId,
      time: item.time,
      timeText: item.timeText,
      score: item.score,
      title: item.title
    })),
    allHits: allHits.map((item) => ({
      frameId: item.frameId,
      time: item.time,
      timeText: item.timeText,
      score: item.score,
      title: item.title,
      missingOrUnclear: item.missingOrUnclear
    }))
  };
}

function cuesForRequirement(requirement, cues) {
  return cues
    .filter((cue) => textContains(cue.text, requirement.keywords))
    .slice(0, 8)
    .map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: cue.text.slice(0, 220),
      source: cue.source
    }));
}

function nearestManifestTimes(targetTime, manifest, windowSeconds) {
  return manifest
    .filter((item) => Number.isFinite(Number(item.time)) && Math.abs(Number(item.time) - targetTime) <= windowSeconds)
    .map((item) => ({
      time: Number(item.time),
      name: item.name || path.basename(item.file || ""),
      source: item.source,
      reasons: item.reasons || []
    }))
    .slice(0, 12);
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (!last || item.start > last.end + 1.5) {
      merged.push({ ...item, reasons: [...item.reasons], sources: [...item.sources] });
    } else {
      last.end = Math.max(last.end, item.end);
      last.reasons.push(...item.reasons);
      last.sources.push(...item.sources);
    }
  }
  return merged.map((item) => ({
    ...item,
    reasons: [...new Set(item.reasons)],
    sources: [...new Set(item.sources)]
  }));
}

function seconds(value) {
  return Math.max(0, Number(value) || 0);
}

function main() {
  const evidenceJson = readJson(path.join(sessionDir, "learning_evidence.json"), {});
  const selectedEvidence = Array.isArray(evidenceJson.selectedEvidence) ? evidenceJson.selectedEvidence : [];
  const allEvidence = Array.isArray(evidenceJson.allEvidence) ? evidenceJson.allEvidence : selectedEvidence;
  const manifest = readJson(path.join(sessionDir, "frames_manifest.json"), []);
  const cues = loadSubtitleTimeline();

  const coverage = {};
  const gaps = [];
  const plannedIntervals = [];

  for (const requirement of REQUIRED_COVERAGE) {
    const itemCoverage = coverageFor(requirement, selectedEvidence, allEvidence);
    const matchedCues = cuesForRequirement(requirement, cues);
    coverage[requirement.key] = {
      label: requirement.label,
      ok: itemCoverage.ok,
      selectedHits: itemCoverage.selectedHits,
      allHits: itemCoverage.allHits,
      subtitleHints: matchedCues
    };

    const weak = !itemCoverage.ok || itemCoverage.selectedHits.some((item) => Number(item.score) < 70);
    if (!weak) continue;

    const hintTimes = [];
    for (const cue of matchedCues) {
      hintTimes.push((seconds(cue.start) + seconds(cue.end || cue.start)) / 2);
    }
    for (const hit of itemCoverage.allHits.slice(0, 4)) {
      if (Number.isFinite(Number(hit.time))) hintTimes.push(Number(hit.time));
    }
    if (!hintTimes.length) {
      for (const item of manifest.slice(0, 3)) {
        if (Number.isFinite(Number(item.time))) hintTimes.push(Number(item.time));
      }
    }

    const uniqueTimes = [...new Set(hintTimes.map((time) => Number(time.toFixed(1))))].slice(0, 6);
    gaps.push({
      key: requirement.key,
      label: requirement.label,
      reason: !itemCoverage.ok ? "selected evidence missing" : "selected evidence exists but appears weak",
      subtitleHints: matchedCues,
      nearbyExistingFrames: uniqueTimes.flatMap((time) => nearestManifestTimes(time, manifest, 6)).slice(0, 16)
    });
    for (const time of uniqueTimes) {
      plannedIntervals.push({
        start: Math.max(0, time - 3),
        end: time + 3,
        reasons: [`补强：${requirement.label}`],
        sources: matchedCues.length ? ["subtitle_timeline", "evidence_gap"] : ["evidence_gap"]
      });
    }
  }

  const intervals = mergeIntervals(plannedIntervals);
  const plan = {
    ok: gaps.length === 0,
    generatedAt: new Date().toISOString(),
    sessionDir,
    inputs: {
      evidencePath: path.join(sessionDir, "learning_evidence.json"),
      frameManifestPath: path.join(sessionDir, "frames_manifest.json"),
      subtitleCueCount: cues.length
    },
    summary: {
      selectedEvidenceCount: selectedEvidence.length,
      allEvidenceCount: allEvidence.length,
      manifestFrameCount: Array.isArray(manifest) ? manifest.length : 0,
      gapCount: gaps.length,
      refinementIntervalCount: intervals.length
    },
    coverage,
    gaps,
    refinementPlan: {
      strategy: "second_pass_dense_frames",
      recommendedFps: 2,
      maxAdditionalFrames: Math.min(48, Math.max(12, intervals.length * 8)),
      intervals,
      nextCommandHint: "后续可由脚本读取 refinementPlan.intervals，调用 ffmpeg 在对应区间二次抽帧。"
    }
  };

  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), "utf8");
  console.log(JSON.stringify({
    ok: plan.ok,
    outPath,
    gapCount: gaps.length,
    refinementIntervalCount: intervals.length
  }, null, 2));
}

main();
