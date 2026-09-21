"use strict";
// Isolated browser regression: all HTTP and WebSocket traffic is mocked.
// Never reads auth tokens, contacts an app-server, or sends a real model turn.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.CR_NODE_MODULES ? path.join(process.env.CR_NODE_MODULES, "playwright-core") : "playwright-core");
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const errors = [];

function installMock(config) {
  const nativeTimeout = window.setTimeout.bind(window);
  if (config.fastTimeout) window.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 20000 ? 50 : ms, ...args);
  localStorage.setItem("host", "local");
  localStorage.setItem("lastThread", "local|same");
  const model = (slug, extra = {}) => Object.assign({ id: "catalog-id-" + slug, model: slug, displayName: slug.toUpperCase(), supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium", hidden: false }, extra);
  const mock = window.mock = { requests: [], held: [], modes: {}, defer: [], currentModel: { local: "custom-session", remote: "remote-a" }, failSend: false, autoComplete: false, ...config };
  const thread = (host, id = "same") => ({
    id, name: host + " / " + id, cwd: host === "local" ? "C:/demo" : "/remote/demo", updatedAt: 1700000000, status: { type: "idle" },
    turns: [{ id: "old", status: "completed", items: [{ id: "old-agent", type: "agentMessage", text: "这是一条模拟对话，可在上方选择下一轮使用的模型。" }] }]
  });
  mock.notify = (host, method, params) => mock.ws.onmessage({ data: JSON.stringify({ kind: "notification", host, method, params }) });
  mock.reply = (m, result, error) => mock.ws.onmessage({ data: JSON.stringify({ kind: "reply", reqId: m.reqId, result, error }) });
  mock.respond = (m) => {
    if (m.type === "hosts") return mock.reply(m, [{ id: "local", label: "本机", status: "ready" }, { id: "remote", label: "远程主机", status: "ready" }]);
    if (m.type === "pendingRequests") return mock.reply(m, []);
    if (m.method === "thread/list") return mock.reply(m, { data: [thread(m.host), thread(m.host, "other")], nextCursor: null });
    if (m.method === "thread/resume") return mock.reply(m, { thread: thread(m.host, m.params.threadId), model: mock.currentModel[m.host], reasoningEffort: "xhigh" });
    if (m.method === "thread/start") return mock.reply(m, { thread: { ...thread(m.host, "created"), turns: [] }, model: mock.currentModel[m.host], reasoningEffort: "xhigh" });
    if (m.method === "model/list") {
      const mode = mock.modes[m.host];
      if (mode === "error") return mock.reply(m, null, "模型服务暂不可用");
      if (mode === "timeout") return;
      if (mode === "empty") return mock.reply(m, { data: [], nextCursor: null });
      if (mode === "loop") return mock.reply(m, { data: [], nextCursor: "repeat" });
      if (m.host === "remote") return mock.reply(m, { data: [model("remote-a"), model("remote-b")], nextCursor: null });
      return mock.reply(m, m.params.cursor ? { data: [model("local-b", { displayName: "Long model name for a very narrow mobile screen — 长模型名称兼容测试" }), model("hidden-model", { hidden: true }), model("local-a")], nextCursor: null } : { data: [model("local-a", { isDefault: true })], nextCursor: "page-2" });
    }
    if (m.method === "turn/start") {
      if (mock.failSend) return mock.reply(m, null, "模拟发送失败");
      const turn = { id: "new-" + m.reqId, status: "inProgress", items: [{ id: "user-" + m.reqId, type: "userMessage", content: m.params.input }] };
      mock.lastTurn = turn;
      if (m.params.model) mock.currentModel[m.host] = m.params.model;
      if (mock.autoComplete) {
        mock.notify(m.host, "turn/started", { threadId: m.params.threadId, turn });
        mock.notify(m.host, "turn/completed", { threadId: m.params.threadId, turn: { ...turn, status: "completed" } });
      }
      return mock.reply(m, { turn });
    }
    if (m.method === "turn/interrupt") {
      mock.notify(m.host, "turn/completed", { threadId: m.params.threadId, turn: { ...mock.lastTurn, status: "interrupted" } });
      return mock.reply(m, {});
    }
    throw new Error("Unexpected mocked request: " + JSON.stringify(m));
  };
  mock.release = () => { const held = mock.held.splice(0); mock.defer = []; held.forEach(mock.respond); };
  window.WebSocket = class {
    constructor() { this.readyState = 0; mock.ws = this; nativeTimeout(() => { this.readyState = 1; this.onopen(); }, 0); }
    send(data) {
      const m = JSON.parse(data); mock.requests.push(m);
      if (mock.defer.includes(m.host + ":" + m.method)) mock.held.push(m);
      else nativeTimeout(() => mock.respond(m), 0);
    }
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    async function fixture(config = {}) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "zh-CN" });
      await ctx.route("**/*", (route) => {
        const file = new URL(route.request().url()).pathname;
        if (file === "/api/me") return route.fulfill({ json: { authed: true } });
        const files = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/icon.svg": "icon.svg", "/manifest.webmanifest": "manifest.webmanifest" };
        if (!files[file]) return route.abort();
        const contentType = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file === "/" ? "text/html" : "application/json";
        return route.fulfill({ body: fs.readFileSync(path.join(__dirname, "public", files[file])), contentType });
      });
      await ctx.addInitScript(installMock, config);
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("https://model-picker.test/");
      await page.waitForFunction(() => document.getElementById("threadTitle").textContent === "local / same");
      return { ctx, page };
    }
    const ready = (page) => page.waitForFunction(() => !document.getElementById("modelSelect").disabled);
    const open = async (page, host, id = "same") => {
      await page.click("#btnMenu");
      await page.click('#hostTabs [data-host="' + host + '"]');
      await page.locator('#drawerList .crow[data-id="' + id + '"]').first().click();
    };
    const sent = (page) => page.evaluate(() => mock.requests.filter((m) => m.method === "turn/start"));

    {
      const { ctx, page } = await fixture(); await ready(page);
      assert.equal(await page.inputValue("#modelSelect"), "custom-session");
      assert.deepEqual(await page.locator("#modelSelect option").evaluateAll((els) => els.map((e) => e.value)), ["", "local-a", "local-b", "custom-session"]);
      assert.equal(await page.evaluate(() => mock.requests.filter((m) => m.method === "model/list").length), 2);
      // Changing the drawer host must not redirect the current chat's model RPC/send.
      await page.click("#btnMenu"); await page.click('#hostTabs [data-host="remote"]'); await page.click("#btnDrawerClose");
      await page.waitForSelector("#drawer.hidden", { state: "attached" });
      const count = await page.evaluate(() => mock.requests.length);
      await page.selectOption("#modelSelect", "local-b");
      assert.equal(await page.evaluate(() => mock.requests.length), count, "selection alone must not mutate the server");
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile overflow at " + width);
        const box = await page.locator("#modelSelect").boundingBox();
        assert.ok(box.width > 100 && box.height >= 44);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.selectOption("#modelSelect", "local-a");
      const shots = path.join(__dirname, "data", "shots"); fs.mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, "model-picker-mobile.png") });
      await page.selectOption("#modelSelect", "local-b");
      await page.evaluate(() => { mock.defer = ["local:turn/start"]; });
      await page.fill("#input", "mock only"); await page.click("#btnSend");
      assert.equal(await page.isDisabled("#modelSelect"), true);
      await page.evaluate(() => document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true })));
      assert.equal((await sent(page)).length, 1, "no duplicate sends");
      const req = (await sent(page))[0];
      assert.equal(req.host, "local"); assert.equal(req.params.model, "local-b"); assert.equal(req.params.effort, "medium");
      assert.equal(req.params.threadId, "same");
      await page.evaluate(() => mock.release());
      await page.waitForFunction(() => document.getElementById("btnSend").textContent === "停止");
      assert.equal(await page.isDisabled("#modelSelect"), true);
      await page.click("#btnSend"); await ready(page);
      assert.equal(await page.inputValue("#modelSelect"), "local-b");
      await page.click("#btnReload"); await ready(page);
      assert.equal(await page.inputValue("#modelSelect"), "local-b", "resume restores server model");
      await open(page, "remote"); await ready(page);
      assert.deepEqual(await page.locator("#modelSelect option").evaluateAll((els) => els.map((e) => e.value)), ["", "remote-a", "remote-b"]);
      await page.selectOption("#modelSelect", "remote-b");
      await page.fill("#input", "remote mock"); await page.click("#btnSend");
      assert.equal((await sent(page)).at(-1).host, "remote");
      assert.equal((await sent(page)).at(-1).params.model, "remote-b");
      await ctx.close(); console.log("PASS catalog pagination, custom model, correct host/slug, next-turn selection, no duplicates, stop/resume, mobile layout");
    }
    {
      const { ctx, page } = await fixture(); await ready(page);
      await page.evaluate(() => mock.notify("local", "thread/settings/updated", { threadId: "same", threadSettings: { model: "local-a", effort: "medium" } }));
      assert.equal(await page.inputValue("#modelSelect"), "local-a");
      await page.selectOption("#modelSelect", "local-b");
      await page.evaluate(() => { mock.failSend = true; mock.notify("local", "thread/settings/updated", { threadId: "same", threadSettings: { model: "external-model", effort: "medium" } }); });
      assert.equal(await page.inputValue("#modelSelect"), "local-b", "pending choice survives settings notifications");
      await page.fill("#input", "preserved draft"); await page.click("#btnSend"); await ready(page);
      assert.equal(await page.inputValue("#input"), "preserved draft");
      assert.equal(await page.inputValue("#modelSelect"), "local-b");
      assert.ok(!("effort" in (await sent(page))[0].params), "keep supported effort");
      await page.selectOption("#modelSelect", "");
      assert.equal(await page.inputValue("#modelSelect"), "external-model");
      await page.evaluate(() => { mock.failSend = false; mock.autoComplete = true; });
      await page.click("#btnSend"); await ready(page);
      assert.ok(!("model" in (await sent(page)).at(-1).params), "unchanged model must omit override");
      assert.equal(await page.textContent("#btnSend"), "发送", "completion before start reply stays complete");
      await ctx.close(); console.log("PASS settings notifications, send failure preserves draft/choice, inherit model, fast turn completion");
    }
    for (const mode of ["error", "empty", "loop", "timeout"]) {
      const { ctx, page } = await fixture({ modes: { local: mode }, fastTimeout: mode === "timeout" });
      await page.waitForFunction(() => /列表加载失败|未提供可选模型/.test(document.getElementById("modelHint").textContent));
      assert.equal(await page.isDisabled("#modelSelect"), true);
      assert.equal(await page.isDisabled("#btnSend"), false);
      assert.equal(await page.inputValue("#modelSelect"), "custom-session");
      await page.evaluate(() => { mock.modes.local = "ok"; });
      await page.click("#btnModelsReload"); await ready(page);
      await ctx.close(); console.log("PASS model list " + mode + " fallback and retry");
    }
    {
      const { ctx, page } = await fixture({ defer: ["local:thread/resume", "local:model/list"] });
      assert.equal(await page.isDisabled("#modelSelect"), true);
      assert.equal(await page.isDisabled("#btnSend"), true);
      await open(page, "remote"); await ready(page);
      await page.evaluate(() => mock.release());
      assert.equal(await page.inputValue("#modelSelect"), "remote-a");
      assert.equal(await page.textContent("#threadTitle"), "remote / same");
      assert.equal(await page.locator('#modelSelect option[value="local-a"]').count(), 0);
      await ctx.close(); console.log("PASS late model/resume responses do not overwrite another host with the same thread id");
    }
    {
      const { ctx, page } = await fixture(); await ready(page);
      await page.evaluate(() => { mock.defer = ["local:turn/start"]; });
      await page.selectOption("#modelSelect", "local-b");
      await page.fill("#input", "old thread draft"); await page.click("#btnSend");
      await open(page, "local", "other"); await ready(page);
      await page.fill("#input", "new thread draft");
      await page.evaluate(() => mock.release());
      assert.equal(await page.inputValue("#input"), "new thread draft");
      assert.equal(await page.inputValue("#modelSelect"), "custom-session");
      assert.equal(await page.locator("#messages .msg.user").count(), 0);
      await ctx.close(); console.log("PASS late send reply cannot pollute another conversation");
    }
    {
      const { ctx, page } = await fixture(); await ready(page);
      await page.evaluate(() => { mock.defer = ["local:turn/start"]; });
      await page.selectOption("#modelSelect", "local-b");
      await page.fill("#input", "canonical settings test"); await page.click("#btnSend");
      await page.evaluate(() => {
        mock.notify("local", "thread/settings/updated", { threadId: "same", threadSettings: { model: "canonical-server-model", effort: "medium" } });
        mock.release();
      });
      await page.waitForFunction(() => document.getElementById("modelSelect").value === "canonical-server-model");
      await ctx.close(); console.log("PASS newer server settings take precedence over delayed start reply");
    }
    {
      const { ctx, page } = await fixture({ defer: ["local:model/list"] });
      await page.waitForFunction(() => !document.getElementById("btnSend").disabled);
      await page.evaluate(() => { mock.ws.readyState = 3; mock.ws.onclose({ code: 1006 }); });
      await page.waitForFunction(() => document.getElementById("modelHint").textContent.includes("连接已断开"));
      assert.equal(await page.isDisabled("#btnModelsReload"), false);
      await ctx.close(); console.log("PASS disconnect clears pending model load");
    }
    {
      const { ctx, page } = await fixture(); await ready(page);
      await page.click("#btnNewTop");
      await page.fill("#newCwd", "C:/demo"); await page.fill("#newInput", "new mock conversation");
      await page.click("#btnNewStart");
      await page.waitForFunction(() => document.getElementById("btnSend").textContent === "停止");
      const req = (await sent(page)).at(-1);
      assert.equal(req.params.threadId, "created"); assert.ok(!("model" in req.params));
      assert.equal(await page.inputValue("#modelSelect"), "custom-session");
      await page.click("#btnSend"); await ready(page);
      await page.selectOption("#modelSelect", "local-a");
      await ctx.close(); console.log("PASS newly created conversation inherits host model and enables subsequent model selection");
    }
    assert.deepEqual(errors, [], "browser runtime errors");
    console.log("ALL MODEL PICKER TESTS PASSED (mock traffic only)");
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
