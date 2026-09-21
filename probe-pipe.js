"use strict";
// 只读探测 \\.\pipe\codex-ipc：看它是不是 app-server 的控制端点
const net = require("net");

const PIPE = "\\\\.\\pipe\\codex-ipc";
const mode = process.argv[2] || "ws";

const sock = net.connect({ path: PIPE });
let got = Buffer.alloc(0);

sock.on("connect", () => {
  console.log("connected to", PIPE, "mode=", mode);
  if (mode === "ws") {
    sock.write(
      "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
  } else {
    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "probe", version: "0" }, capabilities: {} } }) + "\n");
  }
});
sock.on("data", (d) => {
  got = Buffer.concat([got, d]);
  console.log("DATA:", JSON.stringify(d.toString("utf8").slice(0, 400)));
  console.log("HEX :", d.subarray(0, 64).toString("hex"));
});
sock.on("error", (e) => console.log("ERROR:", e.code, e.message));
sock.on("close", () => console.log("CLOSED, total bytes", got.length));

setTimeout(() => { try { sock.destroy(); } catch {} process.exit(0); }, 6000);
