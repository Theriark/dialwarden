// The Rust WebRCON client against an in-process WebSocket server written
// for this test (dev-work-plan P6 tests: the Theriark Mock Server has no
// WebRCON scenario, so this is labelled simulated). The handshake is the
// game's own: the password rides in the URL path, and the frames are the
// { Identifier, Message } JSON the game answers with. A wrong password and a
// down console look the same on the wire, so the probe says unknown for
// both.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RustWebRcon } from "./rust-webrcon.js";
import type { AllowList } from "./types.js";

const PASSWORD = "fjord-web-secret";
const ALLOW: AllowList = ["server.write", "quit"];

/** A client command frame as the game reads it. */
interface Frame {
  readonly Identifier: number;
  readonly Message: string;
  readonly Name: string;
}

let port = 0;
let paths: string[] = [];
let frames: Frame[] = [];
let acceptHandshake = true;
let answerWith: (frame: Frame) => string | string[] = () => "Saved";
/** Upgraded sockets, which server.close() does not end by itself. */
const upgraded = new Set<Duplex>();
const server: Server = createServer(() => {
  // Plain HTTP requests never happen; the console only upgrades.
});

/** One RFC 6455 server text frame with a small payload. */
function textFrame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const head = Buffer.from([0x81, body.length]);
  return Buffer.concat([head, body]);
}

/** Answers the upgrade the way the game does. */
server.on("upgrade", (request, socket) => {
  upgraded.add(socket);
  socket.on("close", () => upgraded.delete(socket));
  const url = request.url ?? "";
  paths.push(url);
  if (!acceptHandshake || url !== `/${PASSWORD}`) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Client frames are masked; a small payload needs two length bytes at
    // most. Decode the JSON body of every complete frame.
    for (;;) {
      if (buffer.length < 2) return;
      let length = (buffer[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (buffer.length < offset + 4 + length) return;
      // RFC 6455: the four mask bytes come before the payload.
      const mask = buffer.subarray(offset, offset + 4);
      const masked = buffer.subarray(offset + 4, offset + 4 + length);
      const body = Buffer.from(
        masked.map((byte, index) => byte ^ (mask[index % 4] ?? 0)),
      );
      buffer = buffer.subarray(offset + 4 + length);
      try {
        const parsed = JSON.parse(body.toString("utf8")) as Frame;
        frames.push(parsed);
        const answers = [answerWith(parsed)].flat();
        for (const answer of answers) {
          socket.write(
            textFrame(
              JSON.stringify({
                Message: answer,
                Identifier: parsed.Identifier,
                Type: "Generic",
                Stacktrace: "",
              }),
            ),
          );
        }
      } catch {
        return;
      }
    }
  });
});

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

const client = () =>
  new RustWebRcon({
    host: "127.0.0.1",
    port,
    password: PASSWORD,
    allow: ALLOW,
    saveCommand: "server.write",
    stopCommand: "quit",
    readMs: 2_000,
  });

describe("Rust WebRCON client (simulated)", () => {
  it("puts the password in the URL path and probes the socket", async () => {
    paths = [];
    expect(await client().probe()).toEqual({ state: "running" });
    expect(paths).toEqual([`/${PASSWORD}`]);
  });

  it("sends the command frame and reads the answer frame", async () => {
    paths = [];
    frames = [];
    answerWith = () => "Map saved";
    await client().save?.();
    expect(frames.map((frame) => frame.Message)).toEqual(["server.write"]);
    expect(frames.at(0)?.Identifier).toBe(1);
    expect(frames.at(0)?.Name).toBe("Dialwarden");
  });

  it("settles the command on the first frame with its identifier", async () => {
    frames = [];
    // The game answers with the log line first, then the reply; the client
    // settles on the first frame that carries its identifier.
    answerWith = () => ["Saving world", "Saved"];
    await client().save?.();
    expect(frames.map((frame) => frame.Message)).toEqual(["server.write"]);
  });

  it("refuses a command that is not on the pack allow-list", async () => {
    const control = new RustWebRcon({
      host: "127.0.0.1",
      port,
      password: PASSWORD,
      allow: ALLOW,
      stopCommand: "status",
    });
    await expect(control.stop?.()).rejects.toMatchObject({ code: "Refused" });
  });

  it("says unknown for a refused password, which looks like a down console", async () => {
    acceptHandshake = false;
    const wrong = new RustWebRcon({
      host: "127.0.0.1",
      port,
      password: "not-the-password",
      allow: ALLOW,
      readMs: 2_000,
    });
    expect(await wrong.probe()).toEqual({ state: "unknown" });
    acceptHandshake = true;
  });

  it("reports stopped when the web port is closed", async () => {
    const down = new RustWebRcon({
      host: "127.0.0.1",
      port: 1,
      password: PASSWORD,
      allow: ALLOW,
      connectMs: 2_000,
    });
    expect(await down.probe()).toEqual({ state: "stopped" });
  });
});

// Threat tests T5 and T11 (security review THE-2598): a command with a line
// break never reaches the console, and a refusal never names the secret or
// the console URL that carries it.
describe("Rust WebRCON client: refusals (simulated)", () => {
  it("refuses an allow-listed command holding a line break", async () => {
    paths = [];
    frames = [];
    const control = new RustWebRcon({
      host: "127.0.0.1",
      port,
      password: PASSWORD,
      allow: ["server.write\nquit"],
      saveCommand: "server.write\nquit",
      readMs: 2_000,
    });
    await expect(control.save?.()).rejects.toMatchObject({ code: "Refused" });
    expect(frames).toEqual([]);
    expect(paths).toEqual([]);
  });

  it("keeps the secret and the console URL out of a failed save", async () => {
    acceptHandshake = false;
    const control = new RustWebRcon({
      host: "127.0.0.1",
      port,
      password: PASSWORD,
      allow: ALLOW,
      saveCommand: "server.write",
      readMs: 2_000,
    });
    const error: unknown = await control
      .save?.()
      .catch((caught: unknown) => caught);
    const { code, message } = error as { code: string; message: string };
    const shown = JSON.stringify({ code, message });
    expect(shown).not.toContain(PASSWORD);
    expect(shown).not.toContain(`ws://127.0.0.1:${port}`);
    acceptHandshake = true;
  });
});

// P10-A L5: the console URL is built by the URL parser, so an IPv6 host
// works and a host that would move the URL is refused before any connection.
describe("Rust WebRCON client: the console address (simulated)", () => {
  it("L5 saves through an IPv6 host", async (context) => {
    const server6 = createServer();
    server6.on("upgrade", (request, socket, head) => {
      server.emit("upgrade", request, socket, head);
    });
    const listening = await new Promise<boolean>((resolve) => {
      server6.once("error", () => resolve(false));
      server6.listen(0, "::1", () => resolve(true));
    });
    if (!listening) {
      // No IPv6 loopback on this machine.
      context.skip();
      return;
    }
    try {
      paths = [];
      frames = [];
      answerWith = () => "Saved";
      const control = new RustWebRcon({
        host: "::1",
        port: (server6.address() as AddressInfo).port,
        password: PASSWORD,
        allow: ALLOW,
        saveCommand: "server.write",
        readMs: 2_000,
      });
      await control.save?.();
      expect(paths).toEqual([`/${PASSWORD}`]);
      expect(frames.map((frame) => frame.Message)).toEqual(["server.write"]);
    } finally {
      for (const socket of upgraded) socket.destroy();
      server6.closeAllConnections();
      await new Promise<void>((resolve) => server6.close(() => resolve()));
    }
  });

  it("L5 refuses a host that would move the URL, with no connection", async () => {
    paths = [];
    for (const host of ["evil.example/x?", "a@b", "host:1", "[::1]"]) {
      const control = new RustWebRcon({
        host,
        port,
        password: PASSWORD,
        allow: ALLOW,
        saveCommand: "server.write",
        connectMs: 500,
      });
      await expect(control.save?.(), host).rejects.toMatchObject({
        code: "Refused",
      });
    }
    expect(paths).toEqual([]);
  });
});
