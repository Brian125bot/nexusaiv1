import { describe, expect, it } from "vitest";

import { computeGitHubSignature, verifyGitHubSignature } from "@/lib/github/webhook";

describe("GitHub webhook signature verification", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ hello: "world" });

  it("accepts a valid signature", () => {
    const signature = computeGitHubSignature(body, secret);
    expect(verifyGitHubSignature(body, signature, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const signature = computeGitHubSignature(body, "wrong-secret");
    expect(verifyGitHubSignature(body, signature, secret)).toBe(false);
  });

  it("rejects missing signature", () => {
    expect(verifyGitHubSignature(body, null, secret)).toBe(false);
  });
});
