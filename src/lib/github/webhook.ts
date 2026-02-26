import { createHmac, timingSafeEqual } from "crypto";
import { githubEnv } from "@/lib/config";

export function computeGitHubSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyGitHubSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = computeGitHubSignature(rawBody, secret);
  const signatureBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(signatureBuffer, expectedBuffer);
}

export function getRequiredEnv(name: "GITHUB_WEBHOOK_SECRET" | "GITHUB_TOKEN"): string {
  return githubEnv[name];
}
