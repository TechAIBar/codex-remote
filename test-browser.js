// 用本机 Chrome + 打包自带的 playwright-core 打开网关页面，走一遍手机端流程并截图。
// 用法: node test-browser.js <口令>
const path = require("path");
const fs = require("fs");
const { chromium } = require(process.env.CR_NODE_MODULES ? path.join(process.env.CR_NODE_MODULES, "playwright-core") : "playwright-core");
const PW = process.argv[2];
const OUT = path.join(__dirname, "data", "shots");
fs.mkdirSync(OUT, { recursive: true });
const exe = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--ignore-certificate-errors"] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true, locale: "zh-CN" });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => logs.push("[console." + m.type() + "] " + m.text()));
  page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
  if (!PW || PW === "--cookie") {
    // 没给口令：直接复用 data/auth.json 里已有的 token，跳过登录页
    const st = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "auth.json"), "utf8"));
    const tok = Object.keys(st.tokens || {})[0];
    if (!tok) throw new Error("data/auth.json 里没有可用 token，请传口令：node test-browser.js <口令>");
    await ctx.addCookies([{ name: "crt", value: tok, domain: "127.0.0.1", path: "/", httpOnly: true, secure: true, sameSite: "Strict" }]);
    await page.goto("https://127.0.0.1:8443/", { waitUntil: "networkidle" });
    console.log("[1] cookie auth, url:", page.url());
  } else {
    await page.goto("https://127.0.0.1:8443/", { waitUntil: "networkidle" });
    console.log("[1] title:", await page.title(), "url:", page.url());
    await page.screenshot({ path: path.join(OUT, "1-login.png") });
    await page.fill("#pw", "wrong");
    await page.click("#btn");
    await page.waitForFunction(() => document.getElementById("err").textContent.length > 0);
    console.log("[2] wrong pw ->", await page.textContent("#err"));
    await page.fill("#pw", PW);
    await page.click("#btn");
  }
  // 新 UI：主屏就是对话视图；先看欢迎屏或恢复的对话
  await page.waitForSelector("#chatView:not(.hidden)", { timeout: 30000 });
  await page.waitForTimeout(2500);
  console.log("[3] chat view. title:", await page.textContent("#threadTitle"), "| welcome:", await page.locator(".welcome").count());
  await page.screenshot({ path: path.join(OUT, "2-chat-initial.png") });
  // 打开抽屉
  await page.click("#btnMenu");
  await page.waitForSelector("#drawer.open", { timeout: 10000 });
  await page.waitForTimeout(500);
  console.log("[4] drawer projects:", await page.locator("#drawerList .proj").count(),
    "| open:", await page.locator("#drawerList .proj.open").count(),
    "| visible rows:", await page.locator("#drawerList .crow:visible").count());
  console.log("    host tabs:", await page.locator("#hostTabs button").allTextContents());
  console.log("    project names:", (await page.locator("#drawerList .pname").allTextContents()).slice(0, 8));
  await page.screenshot({ path: path.join(OUT, "3-drawer.png") });
  // 展开第一个项目
  const firstProj = page.locator("#drawerList .proj").first();
  await firstProj.locator(".caret").click();
  await page.waitForTimeout(350);
  console.log("[5] after caret click, first proj open:", await firstProj.evaluate((e) => e.classList.contains("open")),
    "| visible rows:", await page.locator("#drawerList .crow:visible").count());
  await page.screenshot({ path: path.join(OUT, "4-expanded.png") });
  // 搜索
  await page.fill("#search", (process.env.CR_TEST_QUERY || "test"));
  await page.waitForTimeout(500);
  console.log("[6] search query -> rows:", await page.locator("#drawerList .crow:visible").count());
  await page.screenshot({ path: path.join(OUT, "5-search.png") });
  await page.fill("#search", "");
  await page.waitForTimeout(400);
  // 进项目概览
  await page.locator("#drawerList .pname").first().click();
  await page.waitForSelector("#projectView:not(.hidden)", { timeout: 10000 });
  await page.waitForTimeout(400);
  console.log("[7] project view:", await page.textContent("#projTitle"), "| threads:", await page.locator("#projectList .thread").count());
  await page.screenshot({ path: path.join(OUT, "6-project.png") });
  // 从项目页进对话
  await page.locator("#projectList .thread").first().click();
  await page.waitForSelector("#messages .messages .msg", { timeout: 30000 });
  console.log("[8] thread opened:", await page.textContent("#threadTitle"), "| msgs:", await page.locator("#messages .msg").count(), "| tools:", await page.locator("#messages .tool").count());
  console.log("    status:", await page.textContent("#threadStatus"));
  await page.screenshot({ path: path.join(OUT, "7-thread.png") });
  // 切远程主机
  await page.click("#btnMenu");
  await page.waitForSelector("#drawer.open");
  const tabs = page.locator("#hostTabs button");
  if ((await tabs.count()) > 1) {
    await tabs.nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll("#drawerList .proj, #drawerList .crow").length > 0, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    console.log("[9] remote host projects:", await page.locator("#drawerList .proj").count());
    await page.screenshot({ path: path.join(OUT, "8-remote-drawer.png") });
    await page.locator("#drawerList .proj").first().locator(".caret").click();
    await page.waitForTimeout(350);
    await page.locator("#drawerList .crow:visible").first().click();
    await page.waitForSelector("#messages .messages .msg", { timeout: 60000 });
    console.log("[10] remote thread:", await page.textContent("#threadTitle"), "| msgs:", await page.locator("#messages .msg").count());
    await page.screenshot({ path: path.join(OUT, "9-remote-thread.png") });
    await page.click("#btnMenu");
    await page.waitForSelector("#drawer.open");
    await tabs.nth(0).click();
    await page.waitForTimeout(1200);
  }
  // 新对话页（从项目 ＋）
  await page.locator("#drawerList .proj .plus").first().click();
  await page.waitForSelector("#newView:not(.hidden)");
  console.log("[11] new view cwd prefilled:", await page.inputValue("#newCwd"));
  await page.screenshot({ path: path.join(OUT, "10-new.png") });
  await page.click("#btnNewBack");
  // 设置页
  await page.click("#btnMenu");
  await page.waitForSelector("#drawer.open");
  await page.click("#btnSettings");
  await page.waitForSelector("#settingsBody table");
  console.log("[12] settings sessions rows:", await page.locator("#settingsBody table").first().locator("tr").count());
  await page.screenshot({ path: path.join(OUT, "11-settings.png") });
  await page.click("#btnSettingsBack");

  if (process.argv.includes("--send")) {
    // Send only to the dedicated test conversation selected by CR_TEST_QUERY.
    await page.click("#btnMenu");
    await page.waitForSelector("#drawer.open");
    await page.fill("#search", (process.env.CR_TEST_QUERY || "test"));
    await page.waitForTimeout(500);
    await page.locator("#drawerList .crow:visible").first().click();
    await page.waitForSelector("#messages .messages .msg", { timeout: 30000 });
    const before = await page.locator("#messages .msg").count();
    await page.fill("#input", "测试二：请只回复三个字\"已收到\"，不要执行任何命令。");
    await page.click("#btnSend");
    await page.waitForFunction(() => document.getElementById("btnSend").textContent === "停止", null, { timeout: 15000 });
    console.log("[9] sending, button =", await page.textContent("#btnSend"));
    await page.waitForFunction(() => document.getElementById("btnSend").textContent === "发送", null, { timeout: 120000 });
    const after = await page.locator("#messages .msg").count();
    const lastAgent = await page.locator("#messages .msg.agent").last().textContent();
    console.log("[10] turn done. msgs", before, "->", after, "| last agent:", lastAgent.replace(/\s+/g, " ").slice(0, 120));
    await page.screenshot({ path: path.join(OUT, "8-after-send.png") });
  }
  console.log("--- browser logs ---");
  for (const l of logs) console.log(l);
  await browser.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
