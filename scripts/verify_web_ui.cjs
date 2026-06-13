const fs = require("fs");
const path = require("path");

const DEFAULT_URL = "http://127.0.0.1:8787/";
const DEFAULT_OUT_DIR = path.resolve(__dirname, "..", "sessions", "web-ui-checks");
const DEFAULT_PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE || "playwright";

const homeText = ["视频秒变笔记", "进入收藏盒", "Video Learning Desk"];
const collectionText = ["视频收藏盒", "先收藏，再学习", "加入收藏盒", "送入工作台", "全部", "学习工作台"];
const workspaceText = ["视频学习工作台", "待识别", "视频链接", "开始分析", "历史记录", "生成思维导图", "生成字幕总结", "保存地址"];
const forbiddenText = ["最大帧数", "加密 FPS", "抽帧策略", "检测平台"];
const homeSelectors = [".landing-screen", ".landing-stage", ".prism-hero", ".hero-button", ".health-chip"];
const collectionSelectors = [
  ".collection-screen",
  ".collection-shell",
  ".collection-hero-panel",
  ".collection-input-row textarea",
  ".platform-filters",
  ".collection-grid",
  ".app-tabs"
];
const workspaceSelectors = [
  ".workspace-screen",
  ".workspace-sidebar",
  ".desk-main",
  "textarea",
  ".platform-badge",
  ".timeline-panel",
  ".timeline-list, .empty-state",
  ".history-panel",
  ".primary-action",
  ".auto-frame-panel"
];

function readArg(name, fallback = "") {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function hasMojibake(text) {
  return /瑙嗛|绮樿|杩涘|鍥\?|锛\?|鎬濈淮|鐢熸垚|\uFFFD/.test(String(text || ""));
}

function assertCheck(checks, name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
}

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();
  return { response, text };
}

function loadPlaywright() {
  try {
    return require(DEFAULT_PLAYWRIGHT_MODULE);
  } catch {
    return null;
  }
}

async function launchBrowser(playwright) {
  const attempts = [{ headless: true }, { channel: process.env.BROWSER_CHANNEL || "msedge", headless: true }];
  let lastError = null;
  for (const options of attempts) {
    try {
      return await playwright.chromium.launch(options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function pageState(page, selectors) {
  return page.evaluate((targetSelectors) => {
    const text = document.body.innerText;
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height), top: Math.round(box.top), left: Math.round(box.left) };
    };
    const style = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const computed = window.getComputedStyle(node);
      return {
        height: Math.round(parseFloat(computed.height)),
        resize: computed.resize,
        overflowY: computed.overflowY
      };
    };
    return {
      title: document.title,
      text,
      health: document.querySelector(".health-chip")?.textContent || "",
      selectors: Object.fromEntries(targetSelectors.map((selector) => [selector, Boolean(document.querySelector(selector))])),
      stageRect: rect(".landing-stage"),
      workspaceRect: rect(".workspace-screen"),
      textareaStyle: style("textarea"),
      prismCanvas: Boolean(document.querySelector(".prism-hero canvas"))
    };
  }, selectors);
}

async function runBrowserChecks({ url, outDir, checks }) {
  const playwright = loadPlaywright();
  if (!playwright) {
    assertCheck(checks, "browser:playwright", false, `Playwright not found: ${DEFAULT_PLAYWRIGHT_MODULE}`);
    return { homeScreenshotPath: null, workspaceScreenshotPath: null };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launchBrowser(playwright);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    const home = await pageState(page, homeSelectors);

    assertCheck(checks, "home:title", home.title === "Video Learning Desk", home.title);
    assertCheck(checks, "home:no_mojibake", !hasMojibake(home.text), "visible text scan");
    assertCheck(checks, "home:health", /Local Ready|Checking|Backend Offline/.test(home.health), home.health);
    for (const text of homeText) {
      assertCheck(checks, `home:text:${text}`, home.text.includes(text), home.text.includes(text) ? "present" : "missing");
    }
    for (const selector of homeSelectors) {
      assertCheck(checks, `home:dom:${selector}`, home.selectors[selector], home.selectors[selector] ? "present" : "missing");
    }
    assertCheck(checks, "home:prism_canvas", home.prismCanvas, "canvas exists");
    assertCheck(checks, "home:first_viewport", (home.stageRect?.height || 0) >= 700, JSON.stringify(home.stageRect));

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const homeScreenshotPath = path.join(outDir, `web-ui-home-${timestamp}.png`);
    await page.screenshot({ path: homeScreenshotPath, fullPage: false });
    assertCheck(checks, "home:screenshot", fs.existsSync(homeScreenshotPath), homeScreenshotPath);

    await page.getByText("进入收藏盒", { exact: true }).click();
    await page.waitForSelector(".collection-screen", { timeout: 10000 });
    const collection = await pageState(page, collectionSelectors);

    assertCheck(checks, "collection:no_mojibake", !hasMojibake(collection.text), "visible text scan");
    for (const text of collectionText) {
      assertCheck(checks, `collection:text:${text}`, collection.text.includes(text), collection.text.includes(text) ? "present" : "missing");
    }
    for (const selector of collectionSelectors) {
      assertCheck(checks, `collection:dom:${selector}`, collection.selectors[selector], collection.selectors[selector] ? "present" : "missing");
    }

    await page.locator(".collection-input-row textarea").fill("https://v.douyin.com/example/");
    await page.getByText("加入收藏盒", { exact: true }).click();
    await page.waitForSelector(".video-card", { timeout: 10000 });
    const cardText = await page.locator(".video-card").first().innerText();
    assertCheck(checks, "collection:add_card", /抖音|未总结/.test(cardText), cardText.slice(0, 160));

    await page.getByRole("button", { name: "学习工作台" }).click();
    await page.waitForSelector(".workspace-screen", { timeout: 10000 });
    const workspace = await pageState(page, workspaceSelectors);

    assertCheck(checks, "workspace:no_mojibake", !hasMojibake(workspace.text), "visible text scan");
    for (const text of workspaceText) {
      assertCheck(checks, `workspace:text:${text}`, workspace.text.includes(text), workspace.text.includes(text) ? "present" : "missing");
    }
    for (const text of forbiddenText) {
      assertCheck(checks, `workspace:notext:${text}`, !workspace.text.includes(text), workspace.text.includes(text) ? "still present" : "absent");
    }
    for (const selector of workspaceSelectors) {
      assertCheck(checks, `workspace:dom:${selector}`, workspace.selectors[selector], workspace.selectors[selector] ? "present" : "missing");
    }
    assertCheck(checks, "workspace:layout", (workspace.workspaceRect?.height || 0) >= 860, JSON.stringify(workspace.workspaceRect));
    assertCheck(checks, "workspace:textarea_fixed", workspace.textareaStyle?.height === 132 && workspace.textareaStyle?.resize === "none", JSON.stringify(workspace.textareaStyle));

    await page.locator("textarea").fill("https://v.douyin.com/example/");
    const platformBadge = await page.locator(".platform-badge").innerText();
    assertCheck(checks, "workspace:platform_after_input", platformBadge === "douyin", platformBadge);

    const workspaceScreenshotPath = path.join(outDir, `web-ui-workspace-${timestamp}.png`);
    await page.screenshot({ path: workspaceScreenshotPath, fullPage: false });
    assertCheck(checks, "workspace:screenshot", fs.existsSync(workspaceScreenshotPath), workspaceScreenshotPath);

    return { homeScreenshotPath, workspaceScreenshotPath };
  } finally {
    await browser.close();
  }
}

async function main() {
  const url = readArg("--url", DEFAULT_URL);
  const outDir = path.resolve(readArg("--out", DEFAULT_OUT_DIR));
  const checks = [];

  const healthUrl = new URL("/api/health", url).toString();
  try {
    const { response, text } = await fetchText(healthUrl);
    assertCheck(checks, "health:http", response.ok, `${response.status} ${text.slice(0, 160)}`);
  } catch (error) {
    assertCheck(checks, "health:http", false, error.message);
  }

  try {
    const result = await fetchText(url);
    assertCheck(checks, "page:http", result.response.ok, `${result.response.status}`);
    assertCheck(checks, "page:has_root", result.text.includes("id=\"root\""), "Vite root");
  } catch (error) {
    assertCheck(checks, "page:http", false, error.message);
  }

  const browserResult = await runBrowserChecks({ url, outDir, checks });
  const ok = checks.every((check) => check.ok);
  const report = {
    ok,
    url,
    checkedAt: new Date().toISOString(),
    ...browserResult,
    checks
  };
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "latest-web-ui-check.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    ok,
    reportPath,
    homeScreenshotPath: browserResult.homeScreenshotPath,
    workspaceScreenshotPath: browserResult.workspaceScreenshotPath,
    failed: checks.filter((check) => !check.ok)
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
