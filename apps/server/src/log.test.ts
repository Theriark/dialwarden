// The request line of the log (review of PR 29, L9): the OIDC callback
// carries the authorization code and the state in its query, so its query
// never reaches the log; every other URL is logged as it came.
import { describe, expect, it } from "vitest";
import { loggedUrl } from "./log.js";

describe("loggedUrl", () => {
  it("hides the query of the OIDC callback only", () => {
    const callback = "/api/v1/auth/oidc/callback";
    expect(loggedUrl(`${callback}?code=abc&state=def`)).toBe(
      `${callback}?[redacted]`,
    );
    expect(loggedUrl(callback)).toBe(callback);
    expect(loggedUrl("/api/v1/audit?limit=5")).toBe("/api/v1/audit?limit=5");
  });
});
