"use strict";
// 极简 WebSocket 帧编解码（RFC 6455），供两处复用：
//  1) 网关作为服务端，接受手机浏览器的 WebSocket
//  2) 网关作为客户端，通过 ssh 管道连远程 app-server（它的 unix socket 说 WebSocket）
const crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

// opcode: 1 text, 2 binary, 8 close, 9 ping, 10 pong
function encodeFrame(payload, opcode, mask) {
  if (typeof payload === "string") payload = Buffer.from(payload, "utf8");
  const len = payload.length;
  let header;
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = maskBit | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  if (!mask) return Buffer.concat([header, payload]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, masked]);
}

// 增量解析器：喂入 Buffer，吐出完整消息 { opcode, data }
class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      if (masked) off += 4;
      if (b.length < off + len) break;
      let payload = b.subarray(off, off + len);
      if (masked) {
        const key = b.subarray(off - 4, off);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ key[i & 3];
        payload = un;
      } else {
        payload = Buffer.from(payload);
      }
      this.buf = b.subarray(off + len);
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        if (opcode !== 0x0) this.fragOpcode = opcode;
        this.fragments.push(payload);
        if (fin) {
          out.push({ opcode: this.fragOpcode, data: Buffer.concat(this.fragments) });
          this.fragments = [];
          this.fragOpcode = 0;
        }
      } else {
        out.push({ opcode, data: payload });
      }
    }
    return out;
  }
}

module.exports = { acceptKey, encodeFrame, FrameParser };
