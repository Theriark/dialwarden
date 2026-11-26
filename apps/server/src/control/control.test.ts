// The control resolver (contract C7): pack probe declarations plus per-server
// overrides become control clients, passwords resolve from the game's own
// settings or from the encrypted store, and the allow-list bounds every
// command. The packs here are the real Palworld pack (its shipped REST
// probe) and a small synthetic RCON pack, both against static values.
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { readFileValues } from "@dialwarden/packs-schema";
import { loadPacks } from "@dialwarden/packs-schema/node";
import { describe, expect, it } from "vitest";
import { createAead, type Aead } from "../crypto/aead.js";
import {
  CONTROL_PASSWORD_CONTEXT,
  decryptControlPassword,
  encryptControlPassword,
  hookClient,
  probeClients,
  probeOptions,
  type ControlContext,
} from "./control.js";
import type { JsonValue, Pack, Probe } from "@dialwarden/packs-schema";
import { SourceRcon } from "./source-rcon.js";
import { Telnet7dtd } from "./telnet-7dtd.js";
import { allowedCommand, isControlError, LIMITS } from "./types.js";

const PACKS = fileURLToPath(new URL("../../../../packs/", import.meta.url));
const { packs } = loadPacks(PACKS);
const palworld = packs.get("palworld");
if (palworld === undefined) throw new Error("the palworld pack is missing");

const key = randomBytes(32);
const aead: Aead = createAead(key);

/** The server connection host the resolver falls back to. */
const GAME_HOST = "game.example";

const context = (
  values: { readonly [key: string]: JsonValue },
  host: string | null = GAME_HOST,
): ControlContext => ({
  values: (name) => new Map(Object.entries(values)).get(name),
  secret: (encrypted) => decryptControlPassword(aead, encrypted),
  ...(host === null ? {} : { host }),
});

const palworldProbe = palworld.probes[0] as Probe;

describe("control resolver", () => {
  it("resolves the Palworld REST options from the pack's own probe", async () => {
    const resolved = await probeOptions({
      probe: palworldProbe,
      context: context({
        RESTAPIEnabled: true,
        RESTAPIPort: 8212,
        AdminPassword: "admin-file-secret",
      }),
    });
    expect(resolved?.kind).toBe("palworldRest");
    const options =
      resolved?.kind === "palworldRest" ? resolved.options : undefined;
    expect(options).toMatchObject({
      host: GAME_HOST,
      port: 8212,
      user: "admin",
      password: "admin-file-secret",
      infoPath: "/v1/api/info",
    });
  });

  it("stays silent when no host is known, never probing itself", async () => {
    const resolved = await probeOptions({
      probe: palworldProbe,
      context: context(
        { RESTAPIEnabled: true, RESTAPIPort: 8212, AdminPassword: "secret" },
        null,
      ),
    });
    expect(resolved).toBeNull();
  });

  it("stays silent when the pack's own switch is off", async () => {
    const resolved = await probeOptions({
      probe: palworldProbe,
      context: context({ RESTAPIEnabled: false, RESTAPIPort: 8212 }),
    });
    expect(resolved).toBeNull();
  });

  it("takes the host and port from the per-server override", async () => {
    const resolved = await probeOptions({
      probe: palworldProbe,
      override: { host: "10.0.0.8", port: 9999 },
      context: context({
        RESTAPIEnabled: true,
        RESTAPIPort: 8212,
        AdminPassword: "secret",
      }),
    });
    expect(
      resolved?.kind === "palworldRest" ? resolved.options : undefined,
    ).toMatchObject({ host: "10.0.0.8", port: 9999 });
  });

  it("refuses a probe whose port setting holds nothing usable", async () => {
    await expect(
      probeOptions({
        probe: palworldProbe,
        context: context({ RESTAPIEnabled: true, AdminPassword: "secret" }),
      }),
    ).rejects.toMatchObject({ code: "Refused" });
  });
});

/** A pack with an RCON probe whose allow-list bounds its commands. */
const rconPack: Pack = {
  ...palworld,
  id: "rcontest",
  probes: [
    {
      kind: "sourceRcon",
      portSetting: "port",
      passwordSetting: "password",
      allow: ["sav", "shutdown"],
      saveCommand: "sav",
      stopCommand: "shutdown",
    },
  ],
};

describe("control resolver: RCON packs", () => {
  it("resolves the password from the game file, the allow-list from the pack", async () => {
    const resolved = await probeOptions({
      probe: rconPack.probes[0] as Probe,
      context: context({ port: 27015, password: "file-rcon-secret" }),
    });
    expect(resolved?.kind).toBe("sourceRcon");
    const options =
      resolved?.kind === "sourceRcon" ? resolved.options : undefined;
    expect(options).toMatchObject({
      port: 27015,
      password: "file-rcon-secret",
      allow: ["sav", "shutdown"],
      saveCommand: "sav",
    });
  });

  it("decrypts a stored override password only for the one operation", async () => {
    const resolved = await probeOptions({
      probe: rconPack.probes[0] as Probe,
      override: {
        passwordEnc: encryptControlPassword(aead, "stored-rcon-secret"),
      },
      context: context({ port: 27015 }),
    });
    expect(
      resolved?.kind === "sourceRcon" ? resolved.options : undefined,
    ).toMatchObject({ password: "stored-rcon-secret" });
  });

  it("stays silent when no password can be resolved", async () => {
    const clients = await probeClients(
      rconPack,
      undefined,
      context({ port: 27015 }),
    );
    expect(clients).toEqual([]);
  });

  it("keeps every probe of a pack, in pack order", async () => {
    const both: Pack = {
      ...rconPack,
      probes: [
        ...rconPack.probes,
        { kind: "a2s", portSetting: "port", portOffset: 1 },
      ],
    };
    const clients = await probeClients(
      both,
      undefined,
      context({ port: 27015, password: "file-rcon-secret" }),
    );
    expect(clients.map((client) => client.kind)).toEqual(["sourceRcon", "a2s"]);
    // The A2S query port of the synthetic pack is the game port plus one.
    const a2s = await probeOptions({
      probe: both.probes[1] as Probe,
      context: context({ port: 27015, password: "file-rcon-secret" }),
    });
    expect(a2s?.kind === "a2s" ? a2s.options : undefined).toMatchObject({
      port: 27016,
    });
  });

  it("ignores hook kinds as probes", async () => {
    const hookPack: Pack = {
      ...rconPack,
      probes: [{ kind: "sshCommand" }, { kind: "dockerProxy" }],
    };
    expect(await probeClients(hookPack, undefined, context({}))).toEqual([]);
  });
});

describe("control resolver: overrides cannot redirect a client", () => {
  const values = {
    RESTAPIEnabled: true,
    RESTAPIPort: 8212,
    AdminPassword: "override-secret",
  };

  it.each([
    "evil.example/x?",
    "evil.example/x#",
    "user@evil.example",
    "http://evil.example",
    "[::1]:80",
    "",
  ])("refuses the override host %j", async (host) => {
    await expect(
      probeOptions({
        probe: palworldProbe,
        override: { host },
        context: context(values),
      }),
    ).rejects.toMatchObject({ code: "Refused" });
  });

  it.each([0, 70_000, 1.5, -1])(
    "refuses the override port %j",
    async (port) => {
      await expect(
        probeOptions({
          probe: palworldProbe,
          override: { port },
          context: context(values),
        }),
      ).rejects.toMatchObject({ code: "Refused" });
    },
  );

  it("refuses a port the offset pushes past 65535", async () => {
    await expect(
      probeOptions({
        probe: { kind: "a2s", portSetting: "port", portOffset: 1 },
        context: context({ port: 65_535 }),
      }),
    ).rejects.toMatchObject({ code: "Refused" });
  });

  it("accepts an IPv6 literal and a plain name", async () => {
    for (const host of ["::1", "game-01.lan"]) {
      const resolved = await probeOptions({
        probe: palworldProbe,
        override: { host },
        context: context(values),
      });
      expect(
        resolved?.kind === "palworldRest" ? resolved.options.host : undefined,
      ).toBe(host);
    }
  });
});

describe("control resolver: the allow-list at the resolver", () => {
  const rcon = (extra: { readonly [key: string]: JsonValue }): Probe =>
    ({
      kind: "sourceRcon",
      portSetting: "port",
      passwordSetting: "password",
      ...extra,
    }) as Probe;
  const values = { port: 27015, password: "file-rcon-secret" };

  it("refuses a save command that is not on the allow-list", async () => {
    await expect(
      probeOptions({
        probe: rcon({ allow: ["sav"], saveCommand: "kick all" }),
        context: context(values),
      }),
    ).rejects.toThrowError("the probe command is not allowed");
  });

  it("refuses a probe without an allow-list", async () => {
    await expect(
      probeOptions({ probe: rcon({}), context: context(values) }),
    ).rejects.toThrowError("the probe has no command allow-list");
  });

  it.each([
    [[1]],
    [[""]],
    [["sav\nquit"]],
    [["sav\rquit"]],
    [["x".repeat(129)]],
  ])("refuses the allow-list %j", async (allow) => {
    await expect(
      probeOptions({
        probe: rcon({ allow: allow as JsonValue }),
        context: context(values),
      }),
    ).rejects.toMatchObject({ code: "Refused" });
  });
});

describe("allow-list bound", () => {
  it("matches exactly, up to 128 characters and one line", () => {
    const edge = "x".repeat(128);
    const long = "x".repeat(129);
    expect(LIMITS.maxCommandLength).toBe(128);
    expect(allowedCommand([edge], edge)).toBe(edge);
    expect(allowedCommand([long], long)).toBeUndefined();
    expect(allowedCommand(["sav"], "sav ")).toBeUndefined();
    expect(allowedCommand(["sav"], "SAV")).toBeUndefined();
    expect(allowedCommand(["sav\nquit"], "sav\nquit")).toBeUndefined();
    expect(allowedCommand(["sav\0"], "sav\0")).toBeUndefined();
  });

  it("refuses an over-long command before any connection", async () => {
    const long = "x".repeat(129);
    const client = new SourceRcon({
      host: "127.0.0.1",
      port: 1,
      password: "short",
      allow: [long],
      saveCommand: long,
      connectMs: 500,
    });
    await expect(client.save()).rejects.toMatchObject({ code: "Refused" });
  });
});

describe("control secrets", () => {
  it("encrypts a control password for its own column", () => {
    const secret = "hook-rcon-secret";
    const stored = encryptControlPassword(aead, secret);
    expect(stored.startsWith("dwenc1.")).toBe(true);
    expect(stored).not.toContain(secret);
    expect(decryptControlPassword(aead, stored)).toBe(secret);
  });

  it("cannot be decrypted under another column's name", () => {
    const stored = encryptControlPassword(aead, "hook-rcon-secret");
    expect(() => aead.decryptText(stored, "another.column")).toThrowError();
    expect(CONTROL_PASSWORD_CONTEXT).toBe("control.password");
  });
});

describe("hook client", () => {
  it("refuses unusable hook shapes at construction", () => {
    const ssh = () =>
      hookClient({
        kind: "sshCommand",
        options: {
          host: "127.0.0.1",
          port: 22,
          username: "dw",
          auth: { method: "password", password: "p" },
          pinnedFingerprint: null,
          command: "",
        },
      });
    expect(ssh).toThrowError(/not usable/);
    const docker = () =>
      hookClient({
        kind: "dockerProxy",
        options: { url: "not-a-url", containerLabel: "dialwarden.game" },
      });
    expect(docker).toThrowError(/proxy URL is not usable/);
    expect(isControlError(new Error("x"))).toBe(false);
  });
});

describe("control resolver: 7 Days to Die telnet password", () => {
  // P10-A G3.8: an encoded line break in serverconfig.xml decodes to a real
  // one; the password is refused before any connection is made.
  it("G3.8 refuses a password with an encoded LF before connecting", async () => {
    const sevenDays = packs.get("7dtd");
    const probe = sevenDays?.probes.find((p) => p.kind === "telnet7dtd");
    if (sevenDays === undefined || probe === undefined) {
      throw new Error("the 7dtd pack or its telnet probe is missing");
    }
    let connections = 0;
    const listener = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const port = (listener.address() as AddressInfo).port;
      const xml = [
        '<?xml version="1.0"?>',
        "<ServerSettings>",
        '  <property name="TelnetPassword" value="pw&#10;shutdown"/>',
        `  <property name="TelnetPort" value="${String(port)}"/>`,
        "</ServerSettings>",
        "",
      ].join("\n");
      const read = readFileValues(
        sevenDays,
        "serverconfig",
        new TextEncoder().encode(xml),
      );
      expect(read.values.get("TelnetPassword")).toBe("pw\nshutdown");
      const resolved = await probeOptions({
        probe,
        context: context(Object.fromEntries(read.values), "127.0.0.1"),
      });
      if (resolved?.kind !== "telnet7dtd") {
        throw new Error("the telnet probe did not resolve");
      }
      const client = new Telnet7dtd(resolved.options);
      for (const action of [() => client.save(), () => client.stop()]) {
        let caught: unknown;
        try {
          await action();
        } catch (error) {
          caught = error;
        }
        expect(isControlError(caught, "Refused")).toBe(true);
        expect((caught as Error).message).not.toContain("shutdown");
      }
      expect(connections).toBe(0);
    } finally {
      listener.close();
    }
  });
});
