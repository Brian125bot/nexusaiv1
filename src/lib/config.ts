import { z } from "zod";

const authEnvSchema = z.object({
  DESCOPE_PROJECT_ID: z.string().trim().min(1),
  ALLOWED_USER_ID: z.string().trim().min(1),
  ALLOWED_USER_EMAIL: z.string().trim().email().optional(),
});

const publicEnvSchema = z.object({
  NEXT_PUBLIC_DESCOPE_PROJECT_ID: z.string().trim().min(1),
});

const dbEnvSchema = z.object({
  DATABASE_URL: z.string().trim().min(1),
});

const kvEnvSchema = z.object({
  KV_REST_API_URL: z.string().trim().url(),
  KV_REST_API_TOKEN: z.string().trim().min(1),
});

const githubEnvSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().trim().min(1),
  GITHUB_TOKEN: z.string().trim().min(1),
});

const julesEnvSchema = z.object({
  JULES_API_KEY: z.string().trim().min(1),
  JULES_API_BASE_URL: z.string().trim().url(),
});

function validateEnv<T>(schema: z.ZodSchema<T>, env: unknown, name: string): T {
  try {
    return schema.parse(env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingKeys = error.issues.map(i => i.path.join(".")).join(", ");
      console.error(`❌ Missing or invalid environment variables for ${name}: ${missingKeys}`);
    }
    // During build phase, we might want to continue if these aren't strictly required
    // But for NexusAI, they are mostly required for server-side logic.
    if (process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
       throw new Error(`Environment validation failed for ${name}`);
    }
    // Return partial/empty object cast to T to allow build to proceed if possible
    return env as T;
  }
}

export const authEnv = validateEnv(authEnvSchema, process.env, "Auth");
export const publicEnv = validateEnv(publicEnvSchema, process.env, "Public");
export const dbEnv = validateEnv(dbEnvSchema, process.env, "Database");
export const kvEnv = validateEnv(kvEnvSchema, process.env, "KV/RateLimit");
export const githubEnv = validateEnv(githubEnvSchema, process.env, "GitHub");
export const julesEnv = validateEnv(julesEnvSchema, process.env, "Jules");
