import { Project, SourceFile } from "ts-morph";
import path from "path";

/**
 * Traverses the AST to find an exact, deduplicated array of all file paths
 * in the project that import from any of the modifiedFiles (recursively).
 */
export async function findDownstreamDependents(
  modifiedFiles: string[]
): Promise<string[]> {
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
  });

  const dependentFiles = new Set<string>();
  const visitedFiles = new Set<string>();

  // Helper to resolve the absolute path and ensure it's comparable
  const normalizePath = (p: string) => path.resolve(p);
  const normalizedModifiedFiles = new Set(modifiedFiles.map(normalizePath));

  // Recursive function to trace dependents
  const traceDependents = (sourceFile: SourceFile) => {
    const filePath = normalizePath(sourceFile.getFilePath());

    if (visitedFiles.has(filePath)) {
      return; // Prevent infinite loops from circular dependencies
    }
    visitedFiles.add(filePath);

    try {
      // Find all files that reference this source file
      const referencingFiles = sourceFile.getReferencingSourceFiles();

      for (const refFile of referencingFiles) {
        const refFilePath = normalizePath(refFile.getFilePath());

        // If it's not one of the originally modified files, add it to dependents
        if (!normalizedModifiedFiles.has(refFilePath)) {
          dependentFiles.add(refFilePath);
        }

        // Recursively trace the dependents of this referencing file
        traceDependents(refFile);
      }
    } catch (error) {
      console.warn(`[AST Engine] Skipped unparseable file or encountered error: ${filePath}`, error);
    }
  };

  // Start the tracing from each modified file
  for (const modifiedFile of modifiedFiles) {
    const sourceFile = project.getSourceFile(normalizePath(modifiedFile));
    if (sourceFile) {
      traceDependents(sourceFile);
    } else {
      console.warn(`[AST Engine] Could not find SourceFile in project for: ${modifiedFile}`);
    }
  }

  // Convert absolute paths back to paths relative to the project root (optional, but cleaner)
  // Assuming process.cwd() is the project root, like it is for Next.js apps
  const cwd = process.cwd();
  return Array.from(dependentFiles).map((p) => {
    // Return relative path if it's within cwd, else return absolute
    if (p.startsWith(cwd)) {
      return path.relative(cwd, p); // or keep as is if the rest of the app expects absolute paths
    }
    return p;
  });
}
