// The 7 Days to Die telnet client against an in-process console that speaks
// the lines the game writes (dev-work-plan P6 tests: recorded bytes,
// labelled simulated; the Theriark Mock Server has no telnet scenario). The
// greeting, the password prompt, the wrong-password line and the command
// echo are asserted exactly, telnet negotiation bytes are mixed in, and a
// wrong password closes the socket after ONE attempt, because the game bans
// addresses after failed logins.
import type { AddressInfo, Server as TcpServer, Socket } from "node:net";
import { createServer as createTcpServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Telnet7dtd } from "./telnet-7dtd.js";
import type { AllowList } from "./types.js";

const PASSWORD = "fjord-telnet-secret";
const ALLOW: AllowList = ["sav", "shutdown"];

let port = 0;
let requirePassword = true;
let refusePassword = false;
let sent: string[] = [];
let iac = false;
const sockets = new Set<Socket>();
const server: TcpServer = createTcpServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  // The negotiation bytes a telnet server sends at connect.
  const greeting =
    "*** Connected with 7DTD server.\r\n" +
    "*** Server version: Alpha 21.2 (Compatibility 21.213)\r\n";
  const hello = iac
    ? Buffer.concat([Buffer.from([0xff, 0xfd, 0x01]), Buffer.from(greeting)])
    : Buffer.from(greeting);
  socket.write(hello);
  if (requirePassword) {
    socket.write("Please enter password:\r\n");
  } else {
    socket.write("Logon successful.\r\n");
  }
  socket.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      const word = line.replace(/\r$/, "");
      if (word === "") continue;
      sent.push(word);
      if (requirePassword && sent.length === 1) {
        if (refusePassword || word !== PASSWORD) {
          socket.write("Password incorrect, please enter password:\r\n");
          // The game bans after failed logins: this server closes at once.
          socket.end();
          return;
        }
        socket.write("Logon successful.\r\n");
        socket.write("Press 'help' to get a list of all commands.\r\n");
        return;
      }
      socket.write(
        `Executing command '${word}' by Telnet from 127.0.0.1:50000\r\n`,
      );
      if (word === "sav") {
        socket.write("Saving game...\r\nGame saved\r\n");
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
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
);

const client = () =>
  new Telnet7dtd({
    host: "127.0.0.1",
    port,
    password: PASSWORD,
    allow: ALLOW,
    saveCommand: "sav",
    stopCommand: "shutdown",
    readMs: 2_000,
  });

describe("7 Days to Die telnet client (simulated)", () => {
  it("probes a running server from its greeting alone", async () => {
    requirePassword = true;
    sent = [];
    const result = await client().probe();
    expect(result).toEqual({ state: "running" });
    // A probe never sends the password.
    expect(sent).toEqual([]);
  });

  it("logs in once, saves, and reads the echo line", async () => {
    requirePassword = true;
    sent = [];
    await client().save?.();
    expect(sent[0]).toBe(PASSWORD);
    expect(sent[1]).toBe("sav");
  });

  it("strips the telnet negotiation bytes the stream carries", async () => {
    iac = true;
    requirePassword = true;
    sent = [];
    await client().save?.();
    expect(sent[0]).toBe(PASSWORD);
    expect(sent[1]).toBe("sav");
    iac = false;
  });

  it("closes after one refused password and never tries again", async () => {
    requirePassword = true;
    refusePassword = true;
    sent = [];
    const control = client();
    await expect(control.save?.()).rejects.toMatchObject({ code: "Auth" });
    // Exactly one password was sent.
    expect(sent.filter((line) => line === PASSWORD)).toHaveLength(1);
    refusePassword = false;
  });

  it("works on a server with no password set", async () => {
    requirePassword = false;
    sent = [];
    await client().save?.();
    expect(sent).toEqual(["sav"]);
    requirePassword = true;
  });

  it("refuses a command that is not on the pack allow-list", async () => {
    const control = new Telnet7dtd({
      host: "127.0.0.1",
      port,
      password: PASSWORD,
      allow: ALLOW,
      stopCommand: "decomgr",
    });
    await expect(control.stop?.()).rejects.toMatchObject({ code: "Refused" });
  });

  it("reports stopped when the telnet port is closed", async () => {
    const down = new Telnet7dtd({
      host: "127.0.0.1",
      port: 1,
      password: PASSWORD,
      allow: ALLOW,
      connectMs: 2_000,
    });
    expect(await down.probe()).toEqual({ state: "stopped" });
  });
});
