const fs = require("fs");
const path = require("path");

const playwrightModule =
  process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(playwrightModule);

const url = process.argv[2];
const outDir = process.argv[3];
if (!url || !outDir) {
  console.error("Usage: node probe_browser_video.cjs <url> <out-dir>");
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

const realEdgeUserDataDir = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data");
const useRealProfile = process.env.EDGE_USE_REAL_PROFILE === "1" || process.env.EDGE_USE_REAL_PROFILE === "true";
const userDataDir =
  process.env.EDGE_USER_DATA_DIR ||
  (useRealProfile ? realEdgeUserDataDir : path.join(outDir, "edge-profile"));

const videoUrls = new Set();
const responses = [];

(async () => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: process.env.BROWSER_CHANNEL || "msedge",
    headless: false,
    args: ["--profile-directory=Default", "--disable-blink-features=AutomationControlled"],
    viewport: { width: 1280, height: 900 }
  });

  const page = context.pages()[0] || await context.newPage();
  page.on("response", async (response) => {
    const responseUrl = response.url();
    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    if (
      /\.(mp4|m3u8)(\?|$)/i.test(responseUrl) ||
      /video|mpegurl/i.test(contentType)
    ) {
      videoUrls.add(responseUrl);
      responses.push({
        url: responseUrl,
        status: response.status(),
        contentType,
        contentLength: headers["content-length"]
      });
    }
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(Number(process.env.BROWSER_PROBE_WAIT_MS || 12000));

  const pageData = await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll("video")).map((video) => ({
      src: video.currentSrc || video.src || "",
      poster: video.poster || "",
      readyState: video.readyState,
      duration: video.duration,
      paused: video.paused,
      width: video.videoWidth,
      height: video.videoHeight
    }));
    return {
      title: document.title,
      location: location.href,
      videos,
      text: document.body ? document.body.innerText.slice(0, 8000) : ""
    };
  });

  for (const video of pageData.videos) {
    if (video.src) videoUrls.add(video.src);
  }

  await page.screenshot({ path: path.join(outDir, "page.png"), fullPage: true });
  const result = {
    ok: videoUrls.size > 0,
    url,
    userDataDir,
    profileMode: useRealProfile ? "real_edge_profile" : "isolated_probe_profile",
    pageData,
    videoUrls: Array.from(videoUrls),
    responses,
    screenshot: path.join(outDir, "page.png"),
    savedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(outDir, "probe.json"), JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify({
    ok: result.ok,
    title: pageData.title,
    location: pageData.location,
    videoUrlCount: result.videoUrls.length,
    outDir
  }, null, 2));
  await context.close();
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
