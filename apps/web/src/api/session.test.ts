// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError, currentCsrf, setCsrf } from "./client";
import { keys } from "./queries";
import { forgetSession, isSessionEnded, safeRedirect } from "./session";

describe("safeRedirect", () => {
  it("keeps same-origin paths and refuses everything else", () => {
    expect(safeRedirect("/settings/licence?x=1")).toBe("/settings/licence?x=1");
    expect(safeRedirect("/about#top")).toBe("/about#top");
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect("")).toBe("/");
    expect(safeRedirect("https://example.test/")).toBe("/");
    expect(safeRedirect("//example.test/")).toBe("/");
    expect(safeRedirect("/\\example.test")).toBe("/");
    expect(safeRedirect("settings")).toBe("/");
  });

  it("is not fooled by characters the browser drops from an address", () => {
    expect(safeRedirect("/\t/example.test/")).toBe("/");
    expect(safeRedirect("/\n/example.test/")).toBe("/");
    expect(safeRedirect("/\\\\example.test")).toBe("/");
    expect(safeRedirect("/settings\t/licence")).toBe("/settings/licence");
  });
});

describe("session end", () => {
  it("recognises only the unauthenticated answer", () => {
    expect(
      isSessionEnded(new ApiError(401, { error: "unauthenticated" })),
    ).toBe(true);
    expect(
      isSessionEnded(new ApiError(401, { error: "invalid_credentials" })),
    ).toBe(false);
    expect(isSessionEnded(new ApiError(403, { error: "forbidden" }))).toBe(
      false,
    );
    expect(isSessionEnded(new Error("unauthenticated"))).toBe(false);
  });

  it("drops the local session and the CSRF token", () => {
    const client = new QueryClient();
    setCsrf("csrf-value");
    client.setQueryData(keys.session, { status: "ok" });
    forgetSession(client);
    expect(client.getQueryData(keys.session)).toBeNull();
    expect(currentCsrf()).toBeNull();
  });
});
