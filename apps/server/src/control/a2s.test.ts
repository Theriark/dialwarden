// The A2S probe against a fake UDP query port that answers with recorded
// bytes (dev-work-plan P6 tests: recorded byte fixtures, labelled simulated,
// because the Theriark Mock Server has no A2S scenario). The request bytes
// are asserted exactly, including the challenge round newer servers ask for.
import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { A2sProbe } from "./a2s.js";

// A recorded A2S_INFO reply of a Source game, rewritten with synthetic names.
/** The zero byte every A2S string ends with. */
const NUL = String.fromCharCode(0);

function infoReply(): Buffer {
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x11]);
  const strings = [
    Buffer.from(`Quarry Lane${NUL}`, "latin1"),
    Buffer.from(`Dunninger${NUL}`, "latin1"),
    Buffer.from(`valheim${NUL}`, "latin1"),
    Buffer.from(`Valheim${NUL}`, "latin1"),
  ];
  // App id (2 bytes), players 5, max 32, bots 3, then the server type,
  // environment, visibility and VAC bytes.
  const tail = Buffer.from([0xa8, 0x24, 0x05, 0x20, 0x03, 0x64, 0x77, 0x01]);
  return Buffer.concat([head, ...strings, tail]);
}

// The player count byte follows the reply type: 5 players listed.
function playerReply(): Buffer {
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x44, 0x05]);
  const entries = [0, 1, 2, 3, 4].map((index) =>
    Buffer.concat([
      Buffer.from([index]),
      Buffer.from(`Player${index}${NUL}`, "latin1"),
      (() => {
        const time = Buffer.alloc(4);
        time.writeFloatLE(1200 + index, 0);
        return time;
      })(),
    ]),
  );
  return Buffer.concat([head, ...entries]);
}

function challengeReply(): Buffer {
  const challenge = Buffer.from([0xfe, 0xfd, 0xfc, 0xfb]);
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]),
    challenge,
  ]);
}

let port = 0;
let asked: Buffer[] = [];
let mode: "info" | "challenge" | "players" | "silent" = "info";
const server = createSocket("udp4");

const NO_CHALLENGE = Buffer.from([0xff, 0xff, 0xff, 0xff]);

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.on("message", (message, peer) => {
      asked.push(Buffer.from(message));
      if (mode === "silent") return;
      const type = message.length > 4 ? message[4] : 0;
      if (type === 0x54) {
        // A2S_INFO: the challenge round asks the client to resend with the
        // challenge appended.
        const retry = mode === "challenge" && message.length === 25;
        const reply = retry ? challengeReply() : infoReply();
        server.send(reply, peer.port, peer.address);
        return;
      }
      if (type === 0x55) {
        // A2S_PLAYER: the first ask carries the dummy challenge.
        const first =
          mode === "challenge" && message.subarray(5, 9).equals(NO_CHALLENGE);
        const reply = first ? challengeReply() : playerReply();
        server.send(reply, peer.port, peer.address);
      }
    });
    server.bind(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const probe = (players: boolean) =>
  new A2sProbe({ host: "127.0.0.1", port, players, readMs: 2_000 });

describe("A2S probe (simulated)", () => {
  it("asks A2S_INFO and reports the counts of the reply", async () => {
    asked = [];
    mode = "info";
    const result = await probe(false).probe();
    expect(result).toEqual({ state: "running", players: 5 });
    expect(asked[0]?.subarray(0, 6)).toEqual(
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54, 0x53]),
    );
    expect(asked[0]?.subarray(6).toString("latin1")).toBe(
      `ource Engine Query${NUL}`,
    );
  });

  it("follows the challenge round newer servers ask for", async () => {
    asked = [];
    mode = "challenge";
    const result = await probe(true).probe();
    expect(result).toEqual({ state: "running", players: 5 });
    // INFO (25), INFO with the challenge appended (29), PLAYER with the
    // dummy challenge (9), PLAYER with the real one (9).
    expect(asked.map((ask) => ask.length)).toEqual([25, 29, 9, 9]);
  });

  it("reports stopped when the UDP port is unreachable", async () => {
    const closed = new A2sProbe({
      host: "127.0.0.1",
      port: 1,
      readMs: 2_000,
      connectMs: 2_000,
    });
    const result = await closed.probe();
    expect(result.state).toBe("stopped");
  });

  it("reports unknown when nothing answers in time", async () => {
    mode = "silent";
    const result = await probe(false).probe();
    expect(result).toEqual({ state: "unknown" });
    mode = "info";
  });
});
