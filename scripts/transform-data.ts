import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import fs from "fs";
import path from "path";
import { sql } from "drizzle-orm";

neonConfig.webSocketConstructor = ws;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  const sqlPath = path.join(process.cwd(), "drizzle/0004_normalize_acceptance_criteria.sql");
  const query = fs.readFileSync(sqlPath, "utf8");

  console.log("🚀 Running normalization SQL...");
  
  try {
    await db.execute(sql.raw(query));
    console.log("✅ Transformation complete!");
  } catch (error) {
    console.error("❌ Transformation failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
