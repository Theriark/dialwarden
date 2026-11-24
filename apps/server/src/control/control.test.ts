// The control resolver (contract C7): pack probe declarations plus per-server
// overrides become control clients, passwords resolve from the game's own
// settings or from the encrypted store, and the allow-list bounds every
// command. The packs here are the real Palworld pack (its shipped REST
// probe) and a small synthetic RCON pack, both against static values.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
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
import { isControlError } from "./types.js";

const PACKS = fileURLToPath(new URL("../../../../packs/", import.meta.url));
const { packs } = loadPacks(PACKS);
const palworld = packs.get("palworld");
if (palworld === undefined) throw new Error("the palworld pack is missing");

const key = randomBytes(32);
const aead: Aead = createAead(key);

const context = (values: {
  readonly [key: string]: JsonValue;
}): ControlContext => ({
  values: (name) => new Map(Object.entries(values)).get(name),
  secret: (encrypted) => decryptControlPassword(aead, encrypted),
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
      host: "127.0.0.1",
      port: 8212,
      user: "admin",
      password: "admin-file-secret",
      infoPath: "/v1/api/info",
    });
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
    expect(docker).toThrowError();
    expect(isControlError(new Error("x"))).toBe(false);
  });
});
