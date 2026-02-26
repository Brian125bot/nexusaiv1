import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";
import ws from "ws";
import { dbEnv } from "@/lib/config";

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: dbEnv.DATABASE_URL });
export const db = drizzle(pool, { schema });
