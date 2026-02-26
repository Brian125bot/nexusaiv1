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

export const authEnv = authEnvSchema.parse(process.env);
export const publicEnv = publicEnvSchema.parse(process.env);
export const dbEnv = dbEnvSchema.parse(process.env);
export const kvEnv = kvEnvSchema.parse(process.env);
export const githubEnv = githubEnvSchema.parse(process.env);
export const julesEnv = julesEnvSchema.parse(process.env);
