// Minimal zero-dependency WebSocket server (RFC 6455) for Pakachess.
// Attaches to an existing http.Server "upgrade" event. Handles the handshake,
// single-frame text/close/ping/pong, and exposes a tiny per-connection object.
// Messages are small JSON blobs, so fragmentation across WS frames is not used.
"use strict";

const crypto = require("node:crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function accept(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

// pull complete frames out of an accumulated buffer; returns leftover bytes
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.subarray(p, p + 4); p += 4; }
    if (p + len > buf.length) break; // frame not fully arrived yet
    let payload = buf.subarray(p, p + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    frames.push({ opcode, payload: Buffer.from(payload) });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((kv) => {
    const i = kv.indexOf("=");
    if (i > -1) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return out;
}

// attach(server, { path, onConnection(conn, req) }) -> conn has .pid .send(obj) .close() .onMessage .onClose
function attach(server, { path, ensurePid, onConnection }) {
  const conns = new Set();

  server.on("upgrade", (req, socket) => {
    const url = req.url.split("?")[0];
    if (url !== path) return; // not ours; let other handlers (or nothing) deal with it
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }

    const cookies = parseCookies(req.headers.cookie);
    let pid = cookies.pid && /^[A-Za-z0-9-]+$/.test(cookies.pid) ? cookies.pid : null;
    const setCookie = !pid;
    if (!pid) pid = (ensurePid ? ensurePid() : crypto.randomUUID());

    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + accept(key),
    ];
    if (setCookie) {
      const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      headers.push(`Set-Cookie: pid=${pid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    }
    socket.write(headers.join("\r\n") + "\r\n\r\n");

    const conn = {
      pid, socket, alive: true, lastPong: Date.now(),
      onMessage: null, onClose: null,
      send(obj) { if (!conn.alive) return; try { socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj)))); } catch (_) {} },
      ping() { try { socket.write(encodeFrame(0x9, Buffer.alloc(0))); } catch (_) {} },
      close() { if (!conn.alive) return; conn.alive = false; try { socket.write(encodeFrame(0x8, Buffer.alloc(0))); socket.end(); } catch (_) {} },
    };
    conns.add(conn);

    let acc = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      let res;
      try { res = decodeFrames(acc); } catch (_) { socket.destroy(); return; }
      acc = res.rest;
      for (const f of res.frames) {
        if (f.opcode === 0x8) { teardown(); return; }
        if (f.opcode === 0x9) { try { socket.write(encodeFrame(0xA, f.payload)); } catch (_) {} continue; }
        if (f.opcode === 0xA) { conn.lastPong = Date.now(); continue; }
        if (f.opcode === 0x1 || f.opcode === 0x0) {
          let msg; try { msg = JSON.parse(f.payload.toString("utf8")); } catch (_) { continue; }
          if (conn.onMessage) conn.onMessage(msg);
        }
      }
    });
    function teardown() {
      if (!conn.alive) return;
      conn.alive = false; conns.delete(conn);
      try { socket.destroy(); } catch (_) {}
      if (conn.onClose) conn.onClose();
    }
    socket.on("close", teardown);
    socket.on("error", teardown);

    if (onConnection) onConnection(conn, req);
  });

  // keepalive: ping everyone, drop sockets that stopped ponging (nginx idles ~60s)
  setInterval(() => {
    const now = Date.now();
    for (const c of conns) {
      if (now - c.lastPong > 70000) { try { c.socket.destroy(); } catch (_) {} continue; }
      c.ping();
    }
  }, 25000).unref();

  return conns;
}

module.exports = { attach };
