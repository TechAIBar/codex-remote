"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const views = { chat: $("chatView"), project: $("projectView"), new: $("newView"), settings: $("settingsView") };
  const state = {
    ws: null, reqId: 1, pending: new Map(),
    hosts: [], host: localStorage.getItem("host") || "local",
    threads: {}, cursor: {}, // per host
    current: null, // { host, id, name, turns:[], activeTurnId, items: Map }
    approvals: new Map(), // key host:requestId -> params
    hostStatus: {},
    collapsed: loadCollapsed(), // Set of "host|cwd" 手动折叠
    expanded: loadExpanded(), // Set of "host|cwd" 手动展开
    query: "",
    project: null, // cwd shown in project overview
  };
  function loadCollapsed() {
    try { return new Set(JSON.parse(localStorage.getItem("collapsed") || "[]")); } catch { return new Set(); }
  }
  function loadExpanded() {
    try { return new Set(JSON.parse(localStorage.getItem("expanded") || "[]")); } catch { return new Set(); }
  }
  function saveCollapsed() {
    try {
      localStorage.setItem("collapsed", JSON.stringify([...state.collapsed]));
      localStorage.setItem("expanded", JSON.stringify([...state.expanded]));
    } catch {}
  }

  // ---------- utils ----------
  function toast(msg, ms) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms || 2200);
  }
  function show(name) {
    for (const [k, v] of Object.entries(views)) v.classList.toggle("hidden", k !== name);
    if (name === "chat") requestAnimationFrame(scrollBottom);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function fmtTime(sec) {
    const d = new Date(sec * 1000), now = new Date();
    const same = d.toDateString() === now.toDateString();
    const hm = d.toTimeString().slice(0, 5);
    if (same) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }
  function projectName(cwd) {
    if (!cwd) return "（未绑定项目）";
    const parts = String(cwd).split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join(" / ") || cwd;
  }
  // 极简 markdown：代码块、行内代码、标题、列表、粗体、链接、段落
  function md(text) {
    const blocks = [];
    text = String(text).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => { blocks.push("<pre><code>" + esc(code.replace(/\n$/, "")) + "</code></pre>"); return "\u0000" + (blocks.length - 1) + "\u0000"; });
    const lines = text.split("\n");
    const out = []; let list = null; let para = [];
    const flushPara = () => { if (para.length) { out.push("<p>" + inline(para.join("<br>")) + "</p>"); para = []; } };
    const flushList = () => { if (list) { out.push("<" + list.tag + ">" + list.items.map((i) => "<li>" + inline(i) + "</li>").join("") + "</" + list.tag + ">"); list = null; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (/^\u0000\d+\u0000$/.test(line.trim())) { flushPara(); flushList(); out.push(line.trim()); continue; }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push("<h3>" + inline(m[2]) + "</h3>"); continue; }
      if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(m[1]); continue; }
      if (line.trim() === "") { flushPara(); flushList(); continue; }
      if (/^\|.*\|$/.test(line.trim())) { flushList(); para.push(line); continue; }
      flushList(); para.push(line);
    }
    flushPara(); flushList();
    return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  // ---------- websocket ----------
  function connect() {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
    state.ws = ws;
    ws.onopen = () => { $("threadStatus").textContent = ""; loadHosts().then(() => loadThreads(state.host)).then(restoreLast).then(refreshPending); };
    ws.onclose = (e) => {
      if (e.code === 1006 || e.code === 1008) { /* likely unauthorized */ }
      fetch("/api/me").then((r) => r.json()).then((j) => { if (!j.authed) location.replace("/login"); else setTimeout(connect, 2000); }).catch(() => setTimeout(connect, 3000));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.kind === "reply") {
        const p = state.pending.get(msg.reqId); if (!p) return; state.pending.delete(msg.reqId);
        if (msg.error) p.reject(Object.assign(new Error(msg.error), { rpc: msg.rpc })); else p.resolve(msg.result);
      } else if (msg.kind === "notification") onNotification(msg.host, msg.method, msg.params);
      else if (msg.kind === "serverRequest") onServerRequest(msg);
      else if (msg.kind === "serverRequestResolved") { state.approvals.delete(msg.host + ":" + msg.requestId); renderApprovals(); renderList(); }
      else if (msg.kind === "hostStatus") { state.hostStatus[msg.host] = msg.status; renderHostTabs(); if (msg.status === "error") toast(msg.host + " 连接失败: " + msg.error, 4000); }
    };
  }
  function call(type, payload) {
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== 1) return reject(new Error("未连接"));
      const reqId = state.reqId++;
      state.pending.set(reqId, { resolve, reject });
      state.ws.send(JSON.stringify(Object.assign({ type, reqId }, payload || {})));
    });
  }
  const rpc = (host, method, params) => call("rpc", { host, method, params });

  // ---------- hosts ----------
  async function loadHosts() {
    state.hosts = await call("hosts");
    for (const h of state.hosts) state.hostStatus[h.id] = h.status;
    if (!state.hosts.find((h) => h.id === state.host)) state.host = state.hosts[0].id;
    renderHostTabs();
  }
  function renderHostTabs() {
    $("hostTabs").innerHTML = state.hosts.map((h) => '<button data-host="' + esc(h.id) + '" class="' + (h.id === state.host ? "active" : "") + '"><span class="dot ' + esc(state.hostStatus[h.id] || "") + '"></span>' + esc(h.label) + "</button>").join("");
    $("hostTabs").querySelectorAll("button").forEach((b) => b.onclick = () => { state.host = b.dataset.host; localStorage.setItem("host", state.host); renderHostTabs(); if (state.threads[state.host]) renderList(); else loadThreads(state.host); });
  }

  // ---------- drawer ----------
  function openDrawer() {
    const d = $("drawer"); d.classList.remove("hidden");
    requestAnimationFrame(() => d.classList.add("open"));
    renderList();
  }
  function closeDrawer() {
    const d = $("drawer"); d.classList.remove("open");
    setTimeout(() => d.classList.add("hidden"), 220);
  }
  function drawerOpen() { return !$("drawer").classList.contains("hidden"); }

  // ---------- thread list ----------
  async function loadThreads(host, more) {
    const list = $("drawerList");
    if (!more) { state.threads[host] = null; if (host === state.host) list.innerHTML = '<div class="center">连接 ' + esc(host) + ' 并加载…</div>'; }
    try {
      const params = { limit: 40, sortKey: "updated_at", sortDirection: "desc" };
      if (more && state.cursor[host]) params.cursor = state.cursor[host];
      const r = await rpc(host, "thread/list", params);
      const arr = (state.threads[host] || []).concat(r.data);
      state.threads[host] = arr;
      state.cursor[host] = r.nextCursor;
      state.hostStatus[host] = "connected"; renderHostTabs();
      if (host === state.host) { renderList(); renderProject(); }
    } catch (e) {
      if (host === state.host) list.innerHTML = '<div class="center">加载失败：' + esc(e.message) + '<br><br><button class="iconbtn" onclick="location.reload()">重试</button></div>';
    }
  }
  function pendingThreads(host) {
    const s = new Set();
    for (const [k, p] of state.approvals) if (k.startsWith(host + ":")) s.add(p.threadId);
    return s;
  }
  function threadLabel(t) { return t.name || t.preview || "(未命名)"; }
  function matches(t, q) {
    if (!q) return true;
    return (threadLabel(t) + " " + (t.preview || "") + " " + (t.cwd || "")).toLowerCase().includes(q);
  }
  // 按项目目录分组；返回 [{cwd, threads}]，无项目的归到 key ""
  function groupThreads(host, q) {
    const arr = (state.threads[host] || []).filter((t) => matches(t, q));
    const groups = new Map();
    for (const t of arr) { const k = t.cwd || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
    return groups;
  }
  function isCollapsed(host, cwd) {
    if (state.query) return false; // 搜索时全部展开
    const key = host + "|" + cwd;
    if (state.collapsed.has(key)) return true;
    if (state.expanded.has(key)) return false;
    // 默认折叠，只有当前对话所在项目自动展开（在 renderList 里处理）
    return true;
  }
  function renderList() {
    const host = state.host, arr = state.threads[host];
    const list = $("drawerList");
    if (!drawerOpen()) return;
    if (!arr) { list.innerHTML = '<div class="center">加载中…</div>'; return; }
    const q = state.query.trim().toLowerCase();
    const groups = groupThreads(host, q);
    if (!groups.size) { list.innerHTML = '<div class="center">' + (q ? "没有匹配的对话" : "没有对话") + "</div>"; return; }
    const pend = pendingThreads(host);
    const cur = state.current && state.current.host === host ? state.current.id : null;
    const loose = groups.get("") || []; groups.delete("");
    let html = "";
    // 置顶：最近 5 条（跨项目），项目多的时候不用翻
    if (!q) {
      const recent = (state.threads[host] || []).slice(0, 5);
      if (recent.length) html += '<div class="slabel">最近</div>' + recent.map((t) => crow(t, cur, pend, true)).join("");
    }
    if (groups.size) {
      html += '<div class="slabel">项目</div>';
      for (const [cwd, ts] of groups) {
        const open = !isCollapsed(host, cwd) || ts.some((t) => t.id === cur);
        const anyPend = ts.some((t) => pend.has(t.id));
        const anyActive = ts.some((t) => t.status && t.status.type === "active");
        html += '<div class="proj' + (open ? " open" : "") + '" data-cwd="' + esc(cwd) + '">';
        html += '<div class="projhead">';
        html += '<span class="caret" data-act="toggle">▶</span>';
        html += '<span class="pname" data-act="open" title="' + esc(cwd) + '">' + esc(projectName(cwd)) + "</span>";
        if (anyPend) html += '<span class="dot-badge pending"></span>';
        else if (anyActive) html += '<span class="dot-badge active"></span>';
        html += '<span class="cnt">' + ts.length + "</span>";
        html += '<span class="plus" data-act="new">＋</span>';
        html += "</div><div class=\"projbody\">";
        html += ts.map((t) => crow(t, cur, pend)).join("");
        html += "</div></div>";
      }
    }
    if (loose.length) {
      html += '<div class="slabel">最近对话</div>' + loose.map((t) => crow(t, cur, pend)).join("");
    }
    if (state.cursor[host] && !q) html += '<button class="more slim" id="btnMore">加载更多</button>';
    list.innerHTML = html;
    list.querySelectorAll(".projhead").forEach((h) => {
      const cwd = h.parentElement.dataset.cwd;
      h.onclick = (e) => {
        const act = (e.target.dataset && e.target.dataset.act) || "toggle";
        if (act === "new") { openNew(cwd); closeDrawer(); return; }
        if (act === "open") { showProject(cwd); closeDrawer(); return; }
        const key = host + "|" + cwd;
        const nowOpen = !h.parentElement.classList.contains("open");
        if (nowOpen) { state.collapsed.delete(key); state.expanded.add(key); }
        else { state.expanded.delete(key); state.collapsed.add(key); }
        saveCollapsed();
        h.parentElement.classList.toggle("open", nowOpen);
      };
    });
    list.querySelectorAll(".crow").forEach((b) => b.onclick = () => { openThread(host, b.dataset.id); closeDrawer(); });
    const more = $("btnMore"); if (more) more.onclick = () => { more.textContent = "加载中…"; loadThreads(host, true); };
  }
  function crow(t, cur, pend, withProject) {
    const active = t.status && t.status.type === "active";
    const badge = pend.has(t.id) ? '<span class="dot-badge pending"></span>' : active ? '<span class="dot-badge active"></span>' : "";
    const sub = withProject ? '<span class="csub">' + esc(projectName(t.cwd)) + "</span>" : "";
    return '<button class="crow' + (t.id === cur ? " cur" : "") + (withProject ? " two" : "") + '" data-id="' + esc(t.id) + '"><span class="cmain"><span class="ctitle">' + esc(threadLabel(t)) + "</span>" + sub + "</span>" + badge + '<span class="ct">' + fmtTime(t.updatedAt) + "</span></button>";
  }

  // ---------- project overview ----------
  function showProject(cwd) {
    state.project = cwd;
    $("projTitle").textContent = projectName(cwd);
    $("projPath").textContent = state.host + " · " + (cwd || "未绑定目录");
    show("project");
    renderProject();
  }
  function renderProject() {
    if (views.project.classList.contains("hidden")) return;
    const host = state.host, cwd = state.project;
    const ts = (state.threads[host] || []).filter((t) => (t.cwd || "") === cwd);
    const pend = pendingThreads(host);
    const list = $("projectList");
    if (!ts.length) { list.innerHTML = '<div class="center">这个项目下还没有对话</div>'; return; }
    list.innerHTML = '<div class="group">' + ts.map((t) => {
      const active = t.status && t.status.type === "active";
      return '<button class="thread" data-id="' + esc(t.id) + '"><div class="t"><span class="name">' + esc(threadLabel(t)) + "</span>" + (pend.has(t.id) ? '<span class="badge pending">待审批</span>' : active ? '<span class="badge active">运行中</span>' : "") + '</div><div class="p">' + esc((t.preview || "").slice(0, 80)) + '</div><div class="m">' + fmtTime(t.updatedAt) + "</div></button>";
    }).join("") + "</div>";
    list.querySelectorAll(".thread").forEach((b) => b.onclick = () => openThread(host, b.dataset.id));
  }

  // ---------- thread view ----------
  async function openThread(host, id, keepScroll) {
    const meta = (state.threads[host] || []).find((t) => t.id === id);
    state.current = { host, id, name: meta ? meta.name : "", turns: [], items: new Map(), activeTurnId: null, streaming: new Map(), cwd: meta ? meta.cwd : "" };
    try { localStorage.setItem("lastThread", host + "|" + id); } catch {}
    if (meta && meta.cwd) { state.expanded.add(host + "|" + meta.cwd); state.collapsed.delete(host + "|" + meta.cwd); saveCollapsed(); }
    $("threadTitle").textContent = (meta && (meta.name || meta.preview)) || "对话";
    $("messages").innerHTML = '<div class="center">加载历史…</div>';
    $("threadStatus").textContent = host + " · " + (meta ? projectName(meta.cwd) : "");
    show("chat"); updateComposer(); renderList();
    try {
      // resume 让 app-server 把这条对话加载进内存，之后才能 turn/start；同时拿到 turns
      const r = await rpc(host, "thread/resume", { threadId: id });
      let th = r.thread || r;
      if (!state.current || state.current.id !== id) return;
      // resume 返回的 turns 可能是摘要（itemsView != full）或为空，这时用 thread/read 补全历史
      const full = Array.isArray(th.turns) && th.turns.length && th.turns.every((t) => !t.itemsView || t.itemsView === "full");
      if (!full) {
        try {
          const rd = await rpc(host, "thread/read", { threadId: id, includeTurns: true });
          if (!state.current || state.current.id !== id) return;
          if (rd && rd.thread && Array.isArray(rd.thread.turns)) th = Object.assign({}, th, { turns: rd.thread.turns });
        } catch (e2) { console.warn("thread/read failed", e2); }
      }
      state.current.turns = th.turns || [];
      state.current.cwd = th.cwd || r.cwd;
      if (th.name) { state.current.name = th.name; $("threadTitle").textContent = th.name; }
      const active = th.status && th.status.type === "active";
      const turns = state.current.turns;
      if (turns.length) { const last = turns[turns.length - 1]; if (last.status === "inProgress" && (active || !th.status)) state.current.activeTurnId = last.id; }
      renderMessages();
      renderApprovals();
      updateComposer();
    } catch (e) {
      $("messages").innerHTML = '<div class="center">加载失败：' + esc(e.message) + "</div>";
    }
  }
  function itemHtml(it) {
    switch (it.type) {
      case "userMessage": {
        const txt = (it.content || []).map((c) => c.type === "text" ? c.text : "[" + c.type + "]").join("\n");
        return '<div class="msg user" data-item="' + esc(it.id) + '"><div class="role">你</div>' + md(txt) + "</div>";
      }
      case "agentMessage":
        return '<div class="msg agent" data-item="' + esc(it.id) + '"><div class="role">Codex</div><div class="body">' + md(it.text || "") + "</div></div>";
      case "plan":
        return '<details class="tool"><summary><span class="k">计划</span></summary><pre>' + esc(it.text || "") + "</pre></details>";
      case "reasoning": {
        const s = (it.summary || []).join("\n").trim();
        return s ? '<div class="reasoning">' + esc(s.slice(0, 400)) + "</div>" : "";
      }
      case "commandExecution":
        return '<details class="tool ' + (it.status === "failed" ? "failed" : "") + '" data-item="' + esc(it.id) + '"><summary><span>$</span><span class="k">' + esc((it.command || "").slice(0, 160)) + "</span><span>" + (it.status === "inProgress" ? "运行中…" : it.exitCode !== undefined && it.exitCode !== null ? "exit " + it.exitCode : esc(it.status || "")) + '</span></summary><pre class="out">' + esc((it.aggregatedOutput || "").slice(-4000)) + "</pre></details>";
      case "fileChange":
        return '<details class="tool"><summary><span>✎</span><span class="k">修改 ' + (it.changes || []).length + " 个文件</span><span>" + esc(it.status || "") + "</span></summary><pre>" + esc((it.changes || []).map((c) => c.kind + " " + c.path).join("\n")) + "</pre></details>";
      case "mcpToolCall":
        return '<details class="tool"><summary><span>⚙</span><span class="k">' + esc(it.server + "/" + it.tool) + "</span><span>" + esc(it.status || "") + "</span></summary><pre>" + esc(JSON.stringify(it.arguments || {}, null, 1).slice(0, 1500)) + "</pre></details>";
      case "webSearch":
        return '<div class="tool">🔍 搜索: ' + esc(it.query || "") + "</div>";
      case "dynamicToolCall":
        return '<details class="tool"><summary><span>⚙</span><span class="k">' + esc(it.tool) + "</span><span>" + esc(it.status || "") + "</span></summary><pre>" + esc(JSON.stringify(it.arguments || {}, null, 1).slice(0, 1500)) + "</pre></details>";
      case "imageGeneration":
        return '<div class="tool">🖼 生成图片' + (it.savedPath ? ": " + esc(it.savedPath) : "") + "</div>";
      case "contextCompaction":
        return '<div class="turnsep">— 上下文已压缩 —</div>';
      default:
        return "";
    }
  }
  function renderMessages() {
    const c = state.current; if (!c) return;
    let html = "";
    for (const turn of c.turns) {
      html += '<div class="turn" data-turn="' + esc(turn.id) + '">';
      for (const it of turn.items) html += itemHtml(it);
      if (turn.status === "failed" && turn.error) html += '<div class="tool failed">✖ ' + esc(turn.error.message || JSON.stringify(turn.error)) + "</div>";
      if (turn.status === "interrupted") html += '<div class="turnsep">已中断</div>';
      html += "</div>";
    }
    $("messages").innerHTML = '<div class="messages">' + (html || '<div class="center">这条对话还没有内容</div>') + "</div>";
    scrollBottom();
  }
  function scrollBottom() { const m = $("messages"); m.scrollTop = m.scrollHeight; }
  function nearBottom() { const m = $("messages"); return m.scrollHeight - m.scrollTop - m.clientHeight < 120; }
  function updateComposer() {
    const c = state.current; const btn = $("btnSend"); const ta = $("input");
    ta.disabled = !c; btn.disabled = !c;
    ta.placeholder = c ? "继续对话…" : "先从左上角 ☰ 选择一个对话";
    if (c && c.activeTurnId) { btn.textContent = "停止"; btn.classList.add("stop"); btn.disabled = false; $("threadStatus").textContent = c.host + " · 运行中…"; }
    else { btn.textContent = "发送"; btn.classList.remove("stop"); if (c) $("threadStatus").textContent = c.host + " · " + projectName(c.cwd); }
  }
  function renderWelcome() {
    $("threadTitle").textContent = "Codex Remote";
    $("threadStatus").textContent = state.host || "";
    $("messages").innerHTML = '<div class="welcome"><div class="big">选择一个对话开始</div><div>左上角 ☰ 里按项目查看全部对话</div><button id="wOpen">浏览对话</button><button id="wNew">＋ 新对话</button></div>';
    const a = $("wOpen"); if (a) a.onclick = openDrawer;
    const b = $("wNew"); if (b) b.onclick = () => openNew();
    updateComposer();
  }
  // 恢复上次查看的对话；没有就展示欢迎屏
  function restoreLast() {
    if (state.current) return;
    const saved = localStorage.getItem("lastThread") || "";
    const i = saved.indexOf("|");
    if (i > 0) {
      const host = saved.slice(0, i), id = saved.slice(i + 1);
      if ((state.threads[host] || []).some((t) => t.id === id)) { openThread(host, id); return; }
    }
    renderWelcome();
  }

  // ---------- live updates ----------
  function turnEl(turnId) { return $("messages").querySelector('[data-turn="' + CSS.escape(turnId) + '"]'); }
  function ensureTurn(turnId) {
    const c = state.current; let t = c.turns.find((x) => x.id === turnId);
    if (!t) { t = { id: turnId, items: [], status: "inProgress" }; c.turns.push(t); const wrap = $("messages").querySelector(".messages") || (($("messages").innerHTML = '<div class="messages"></div>'), $("messages").firstChild); wrap.insertAdjacentHTML("beforeend", '<div class="turn" data-turn="' + esc(turnId) + '"></div>'); }
    return t;
  }
  function upsertItem(turnId, item) {
    const c = state.current; const t = ensureTurn(turnId);
    const idx = t.items.findIndex((x) => x.id === item.id);
    if (idx >= 0) t.items[idx] = item; else t.items.push(item);
    const el = turnEl(turnId); if (!el) return;
    const wasBottom = nearBottom();
    const existing = el.querySelector('[data-item="' + CSS.escape(item.id) + '"]');
    const html = itemHtml(item);
    if (existing) { if (html) existing.outerHTML = html; else existing.remove(); }
    else if (html) el.insertAdjacentHTML("beforeend", html);
    if (wasBottom) scrollBottom();
  }
  function onNotification(host, method, p) {
    const c = state.current;
    // 列表状态更新
    if (method === "thread/status/changed" || method === "turn/completed" || method === "turn/started" || method === "thread/name/updated") {
      const arr = state.threads[host]; if (arr) { const t = arr.find((x) => x.id === p.threadId); if (t) { if (method === "thread/status/changed") t.status = p.status; if (method === "thread/name/updated") t.name = p.threadName || p.name; if (method === "turn/completed") t.updatedAt = Date.now() / 1000; renderList(); renderProject(); } }
      if (method === "thread/name/updated" && c && c.host === host && c.id === p.threadId && (p.threadName || p.name)) { c.name = p.threadName || p.name; $("threadTitle").textContent = c.name; }
    }
    if (method === "thread/started" && p.thread) { const arr = state.threads[host]; if (arr && !arr.find((x) => x.id === p.thread.id)) { arr.unshift(p.thread); renderList(); renderProject(); } }
    if (!c || c.host !== host || p.threadId !== c.id) return;
    switch (method) {
      case "turn/started":
        c.activeTurnId = p.turn.id; ensureTurn(p.turn.id); for (const it of p.turn.items || []) upsertItem(p.turn.id, it); updateComposer(); break;
      case "item/started":
      case "item/completed":
        upsertItem(p.turnId, p.item); if (method === "item/completed") c.streaming.delete(p.item.id); break;
      case "item/agentMessage/delta": {
        const t = ensureTurn(p.turnId); let it = t.items.find((x) => x.id === p.itemId);
        if (!it) { it = { id: p.itemId, type: "agentMessage", text: "" }; t.items.push(it); }
        it.text = (it.text || "") + p.delta;
        const el = turnEl(p.turnId); if (!el) break;
        let node = el.querySelector('[data-item="' + CSS.escape(p.itemId) + '"]');
        const wasBottom = nearBottom();
        if (!node) { el.insertAdjacentHTML("beforeend", '<div class="msg agent streaming" data-item="' + esc(p.itemId) + '"><div class="role">Codex</div><div class="body"></div></div>'); node = el.lastElementChild; }
        node.classList.add("streaming");
        // 流式期间用轻量渲染，避免每个 delta 都跑 markdown
        const body = node.querySelector(".body"); if (body) { body.textContent = it.text; body.style.whiteSpace = "pre-wrap"; }
        if (wasBottom) scrollBottom();
        break;
      }
      case "item/commandExecution/outputDelta": {
        const el = turnEl(p.turnId); if (!el) break;
        const node = el.querySelector('[data-item="' + CSS.escape(p.itemId) + '"] .out');
        if (node) { node.textContent = (node.textContent + p.delta).slice(-4000); }
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        $("threadStatus").textContent = c.host + " · 思考中… " + (p.delta || "").slice(0, 60).replace(/\n/g, " ");
        break;
      }
      case "turn/completed": {
        const t = ensureTurn(p.turn.id); Object.assign(t, p.turn); c.activeTurnId = null;
        const el = turnEl(p.turn.id); if (el) { el.innerHTML = p.turn.items.map(itemHtml).join("") + (p.turn.status === "failed" && p.turn.error ? '<div class="tool failed">✖ ' + esc(p.turn.error.message || "") + "</div>" : p.turn.status === "interrupted" ? '<div class="turnsep">已中断</div>' : ""); }
        updateComposer(); scrollBottom(); break;
      }
      case "thread/status/changed":
        if (p.status && p.status.type !== "active") { c.activeTurnId = null; updateComposer(); }
        break;
      case "error":
        toast("错误: " + (p.error && p.error.message || p.message || JSON.stringify(p)).slice(0, 200), 5000); break;
    }
  }

  // ---------- approvals / server requests ----------
  function onServerRequest(msg) {
    state.approvals.set(msg.host + ":" + msg.requestId, Object.assign({ method: msg.method, requestId: msg.requestId, host: msg.host }, msg.params));
    renderApprovals(); renderList();
    if (navigator.vibrate) navigator.vibrate(80);
    if (!state.current || state.current.id !== msg.params.threadId) toast("有一条对话在等待你的审批", 3000);
  }
  async function refreshPending() {
    try { const arr = await call("pendingRequests"); state.approvals.clear(); for (const p of arr) state.approvals.set(p.host + ":" + p.requestId, Object.assign({ method: p.method, requestId: p.requestId, host: p.host }, p.params)); renderApprovals(); renderList(); } catch {}
  }
  function renderApprovals() {
    const box = $("approvals"); const c = state.current;
    if (!c) { box.innerHTML = ""; return; }
    let html = "";
    for (const [key, a] of state.approvals) {
      if (a.host !== c.host || a.threadId !== c.id) continue;
      if (a.method === "item/commandExecution/requestApproval" || a.method === "execCommandApproval") {
        const cmd = a.command || (a.commandActions || []).map((x) => x.command || "").join(" ") || "";
        html += '<div class="approval" data-key="' + esc(key) + '"><div class="h">请求执行命令</div>' + (a.reason ? '<div class="muted">' + esc(a.reason) + "</div>" : "") + "<pre>" + esc(cmd) + "</pre><div class=\"muted\">cwd: " + esc(a.cwd || "") + '</div><div class="btns"><button class="ok" data-d="accept">允许一次</button><button data-d="acceptForSession">本会话都允许</button><button class="no" data-d="decline">拒绝</button></div></div>';
      } else if (a.method === "item/fileChange/requestApproval" || a.method === "applyPatchApproval") {
        html += '<div class="approval" data-key="' + esc(key) + '"><div class="h">请求修改文件</div>' + (a.reason ? '<div class="muted">' + esc(a.reason) + "</div>" : "") + (a.grantRoot ? "<pre>写入根目录: " + esc(a.grantRoot) + "</pre>" : "") + '<div class="btns"><button class="ok" data-d="accept">允许一次</button><button data-d="acceptForSession">本会话都允许</button><button class="no" data-d="decline">拒绝</button></div></div>';
      } else if (a.method === "item/permissions/requestApproval") {
        html += '<div class="approval" data-key="' + esc(key) + '"><div class="h">请求额外权限</div>' + (a.reason ? '<div class="muted">' + esc(a.reason) + "</div>" : "") + "<pre>" + esc(JSON.stringify(a.permissions || {}, null, 1).slice(0, 1200)) + '</pre><div class="btns"><button class="ok" data-d="grantTurn">本轮允许</button><button data-d="grantSession">本会话允许</button><button class="no" data-d="denyPerm">拒绝</button></div></div>';
      } else if (a.method === "item/tool/requestUserInput") {
        html += '<div class="approval" data-key="' + esc(key) + '"><div class="h">Codex 有问题要问你</div>';
        (a.questions || []).forEach((q, i) => {
          html += '<div class="q" data-qid="' + esc(q.id || i) + '"><div><b>' + esc(q.header || "") + "</b> " + esc(q.question || q.prompt || "") + "</div>";
          if (q.options && q.options.length) html += '<div class="btns">' + q.options.map((o) => '<button data-opt="' + esc(o.label) + '">' + esc(o.label) + "</button>").join("") + "</div>";
          html += '<textarea placeholder="或者自由输入…"></textarea></div>';
        });
        html += '<div class="btns"><button class="ok" data-d="answer">提交回答</button></div></div>';
      } else if (a.method === "mcpServer/elicitation/request") {
        html += '<div class="approval" data-key="' + esc(key) + '"><div class="h">' + esc(a.serverName || "MCP") + ' 需要你确认</div><div class="muted">' + esc(a.message || "") + '</div>' + (a.url ? '<pre>' + esc(a.url) + '</pre>' : '') + '<div class="btns"><button class="ok" data-d="elicitAccept">接受</button><button class="no" data-d="elicitDecline">拒绝</button></div></div>';
      } else {
        html += '<div class="approval" data-key="' + esc(key) + '"><div class="h">' + esc(a.method) + '</div><pre>' + esc(JSON.stringify(a, null, 1).slice(0, 1000)) + '</pre><div class="btns"><button class="no" data-d="declineGeneric">拒绝</button></div></div>';
      }
    }
    box.innerHTML = html;
    box.querySelectorAll(".approval").forEach((card) => {
      const key = card.dataset.key; const a = state.approvals.get(key);
      card.querySelectorAll("[data-opt]").forEach((b) => b.onclick = () => { const q = b.closest(".q"); q.querySelector("textarea").value = b.dataset.opt; q.querySelectorAll("[data-opt]").forEach((x) => x.style.outline = x === b ? "2px solid var(--accent)" : ""); });
      card.querySelectorAll("[data-d]").forEach((b) => b.onclick = () => answer(a, b.dataset.d, card));
    });
  }
  async function answer(a, decision, card) {
    let result;
    if (decision === "answer") {
      const answers = {};
      card.querySelectorAll(".q").forEach((q) => { const v = q.querySelector("textarea").value.trim(); answers[q.dataset.qid] = { answers: v ? [v] : [] }; });
      result = { answers };
    } else if (decision === "grantTurn") result = { permissions: a.permissions, scope: "turn" };
    else if (decision === "grantSession") result = { permissions: a.permissions, scope: "session" };
    else if (decision === "denyPerm") result = { permissions: {}, scope: "turn" };
    else if (decision === "elicitAccept") result = { action: "accept", content: {} };
    else if (decision === "elicitDecline") result = { action: "decline" };
    else if (decision === "declineGeneric") result = { decision: "decline" };
    else result = { decision };
    card.querySelectorAll("button").forEach((b) => b.disabled = true);
    try { await call("respond", { host: a.host, requestId: a.requestId, result }); state.approvals.delete(a.host + ":" + a.requestId); renderApprovals(); renderList(); }
    catch (e) { toast("提交失败: " + e.message, 4000); card.querySelectorAll("button").forEach((b) => b.disabled = false); }
  }

  // ---------- send / interrupt ----------
  async function send() {
    const c = state.current; if (!c) return;
    if (c.activeTurnId) {
      try { await rpc(c.host, "turn/interrupt", { threadId: c.id, turnId: c.activeTurnId }); toast("已请求停止"); } catch (e) { toast("停止失败: " + e.message, 4000); }
      return;
    }
    const ta = $("input"); const text = ta.value.trim(); if (!text) return;
    ta.value = ""; autoGrow(ta); $("btnSend").disabled = true;
    try {
      const r = await rpc(c.host, "turn/start", { threadId: c.id, input: [{ type: "text", text }] });
      c.activeTurnId = r.turn.id; ensureTurn(r.turn.id); for (const it of r.turn.items || []) upsertItem(r.turn.id, it);
      if (!(r.turn.items || []).some((i) => i.type === "userMessage")) upsertItem(r.turn.id, { id: "local-" + Date.now(), type: "userMessage", content: [{ type: "text", text }] });
      updateComposer(); scrollBottom();
    } catch (e) { toast("发送失败: " + e.message, 5000); ta.value = text; }
    $("btnSend").disabled = false;
  }
  function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; }

  // ---------- new thread ----------
  function openNew(cwd) {
    $("newHost").innerHTML = state.hosts.map((h) => '<option value="' + esc(h.id) + '"' + (h.id === state.host ? " selected" : "") + ">" + esc(h.label) + "</option>").join("");
    if (typeof cwd === "string" && cwd) $("newCwd").value = cwd;
    fillCwds(); $("newHost").onchange = () => fillCwds();
    show("new");
    setTimeout(() => $("newInput").focus(), 60);
  }
  function fillCwds() {
    const host = $("newHost").value; const set = new Set(); for (const t of state.threads[host] || []) if (t.cwd) set.add(t.cwd);
    $("cwdList").innerHTML = [...set].map((c) => '<option value="' + esc(c) + '">').join("");
    const first = [...set][0]; if (first && !$("newCwd").value) $("newCwd").value = first;
  }
  async function startNew() {
    const host = $("newHost").value, cwd = $("newCwd").value.trim(), text = $("newInput").value.trim();
    if (!cwd) return toast("请填写项目目录");
    if (!text) return toast("请输入第一条消息");
    $("btnNewStart").disabled = true;
    try {
      const r = await rpc(host, "thread/start", { cwd, approvalPolicy: "on-request" });
      const th = r.thread;
      state.threads[host] = [th].concat(state.threads[host] || []);
      state.host = host; localStorage.setItem("host", host); renderHostTabs();
      $("newInput").value = "";
      state.current = { host, id: th.id, name: th.name || "", turns: [], items: new Map(), activeTurnId: null, streaming: new Map(), cwd };
      $("threadTitle").textContent = "新对话"; $("messages").innerHTML = '<div class="messages"></div>'; $("threadStatus").textContent = host + " · " + projectName(cwd);
      state.expanded.add(host + "|" + cwd); state.collapsed.delete(host + "|" + cwd); saveCollapsed();
      show("chat"); $("input").value = text; await send();
    } catch (e) { toast("创建失败: " + e.message, 5000); }
    $("btnNewStart").disabled = false;
  }

  // ---------- settings ----------
  async function openSettings() {
    show("settings");
    const body = $("settingsBody"); body.innerHTML = '<div class="center">加载…</div>';
    try {
      const r = await call("loginAttempts");
      let html = "<h3>已登录设备</h3><table>" + (r.sessions.map((s) => "<tr><td>" + new Date(s.at).toLocaleString() + "</td><td>" + esc(s.ip) + "</td><td>" + esc(s.ua) + "</td></tr>").join("") || "<tr><td>无</td></tr>") + "</table>";
      html += "<h3>最近登录尝试</h3><table>" + (r.attempts.map((a) => "<tr><td>" + new Date(a.at).toLocaleString() + '</td><td class="' + (a.ok ? "ok" : "fail") + '">' + (a.ok ? "成功" : "失败") + "</td><td>" + esc(a.ip) + "</td><td>" + esc(a.ua) + "</td></tr>").join("") || "<tr><td>无</td></tr>") + "</table>";
      html += '<h3>操作</h3><button id="btnLogout">退出登录</button> <button id="btnRevoke" class="danger">注销所有设备</button>';
      html += '<p class="muted" style="margin-top:16px;font-size:12px">主机：' + state.hosts.map((h) => esc(h.label) + " (" + esc(state.hostStatus[h.id] || "idle") + ")").join("，") + "</p>";
      body.innerHTML = html;
      $("btnLogout").onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.replace("/login"); };
      $("btnRevoke").onclick = async () => { if (!confirm("注销所有设备（包括本机）？")) return; await call("revokeAll"); await fetch("/api/logout", { method: "POST" }); location.replace("/login"); };
    } catch (e) { body.innerHTML = '<div class="center">' + esc(e.message) + "</div>"; }
  }

  // ---------- wire up ----------
  // 抽屉
  $("btnMenu").onclick = openDrawer;
  $("btnDrawerClose").onclick = closeDrawer;
  $("drawerScrim").onclick = closeDrawer;
  $("btnRefresh").onclick = () => loadThreads(state.host);
  $("btnNew").onclick = () => { closeDrawer(); openNew(); };
  $("btnSettings").onclick = () => { closeDrawer(); openSettings(); };
  let searchTimer = null;
  $("search").addEventListener("input", (e) => {
    const v = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = v; renderList(); }, 140);
  });
  // 对话主屏
  $("btnNewTop").onclick = () => openNew(state.current && state.current.cwd);
  $("btnReload").onclick = () => { if (state.current) openThread(state.current.host, state.current.id); else openDrawer(); };
  $("btnSend").onclick = send;
  $("input").addEventListener("input", (e) => autoGrow(e.target));
  $("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  // 项目概览
  $("btnProjBack").onclick = () => show("chat");
  $("btnProjNew").onclick = () => openNew(state.project || "");
  // 其它子页
  $("btnSettingsBack").onclick = () => show("chat");
  $("btnNewBack").onclick = $("btnNewCancel").onclick = () => show("chat");
  $("btnNewStart").onclick = startNew;
  // 手机返回键：优先关抽屉，其次退回对话主屏
  window.addEventListener("popstate", () => {
    if (drawerOpen()) { closeDrawer(); return; }
    if (!views.chat.classList.contains("hidden")) return;
    show("chat");
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.ws && state.ws.readyState !== 1) connect(); });

  renderWelcome();
  connect();
})();
