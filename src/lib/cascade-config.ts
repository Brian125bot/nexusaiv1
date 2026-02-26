/**
 * Cascade Configuration - Core Files Definition
 * 
 * These files are considered "high-impact" - when modified, they trigger
 * a Blast Radius Cascade analysis to identify and repair downstream breakage.
 */

export const CORE_FILES = [
  // Database & Schema
  "src/db/schema.ts",
  "drizzle/schema.ts",
  
  // Type Definitions
  "src/lib/types.ts",
  "src/types/index.ts",
  "src/types/**/*.ts",
  
  // API Contracts
  "src/lib/api-contracts.ts",
  "src/lib/response-types.ts",
  
  // Shared Utilities (high-impact)
  "src/lib/auth/session.ts",
  "src/lib/config/index.ts",
];

/**
 * Patterns that indicate a file is a core dependency
 */
export const CORE_FILE_PATTERNS = [
  /src\/db\/schema\.ts$/,
  /src\/lib\/types\.ts$/,
  /src\/types\/.*\.ts$/,
  /src\/lib\/api-contracts\.ts$/,
  /src\/lib\/auth\/.*\.ts$/,
];

/**
 * Check if a file path matches a core file pattern
 */
export function isCoreFile(filePath: string): boolean {
  return CORE_FILE_PATTERNS.some(pattern => pattern.test(filePath));
}

/**
 * Cascade Analysis Configuration
 */
export const CASCADE_CONFIG = {
  // Maximum number of parallel Jules sessions to spawn
  maxParallelAgents: 5,
  
  // Timeout for cascade analysis (ms)
  analysisTimeout: 60000,
  
  // Minimum confidence score for Gemini's repair suggestions (0-1)
  minConfidenceScore: 0.7,
  
  // Enable auto-dispatch without human approval (dev only)
  autoDispatchInDev: false,
};
