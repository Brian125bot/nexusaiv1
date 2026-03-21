import { Project, SourceFile } from "ts-morph";
import path from "path";

/**
 * Traces transitive dependents of modified files within the local project.
 * Uses a fresh ts-morph Project instance on each call to prevent stale ASTs
 * and allow V8 to garbage collect the memory-intensive graph.
 *
 * @param modifiedFiles - Array of relative file paths (e.g. 'src/lib/my-file.ts')
 * @returns Array of relative file paths that depend (transitively) on the modified files.
 */
export async function findDownstreamDependents(modifiedFiles: string[]): Promise<string[]> {
  // Use absolute path for TS config to be safe
  const tsConfigFilePath = path.join(process.cwd(), "tsconfig.json");

  // 1. FRESH INSTANTIATION: Read the current truth from disk
  const project = new Project({
    tsConfigFilePath,
  });

  const dependents = new Set<string>();
  const visited = new Set<string>();
  const queue: SourceFile[] = [];

  // Initialize the queue with the SourceFiles for the explicitly modified files
  for (const relativePath of modifiedFiles) {
    const absolutePath = path.resolve(process.cwd(), relativePath);

    try {
      // getSourceFileOrThrow throws if the file isn't found in the project's scope
      const sourceFile = project.getSourceFileOrThrow(absolutePath);
      queue.push(sourceFile);
      visited.add(absolutePath);
    } catch (error: unknown) {
      // If a file is unparseable or outside the scope, log and continue
      console.warn('[AST Engine] Skipped unparseable or untracked file:', absolutePath, error instanceof Error ? error.message : String(error));
    }
  }

  // 2. Recursive traversal logic
  while (queue.length > 0) {
    const currentFile = queue.shift()!;

    // Find files that reference (import/require) the current file
    const referencingFiles = currentFile.getReferencingSourceFiles();

    for (const refFile of referencingFiles) {
      const refPath = refFile.getFilePath(); // getFilePath returns an absolute path in ts-morph

      // Prevent infinite loops from circular dependencies
      if (!visited.has(refPath)) {
        visited.add(refPath);
        queue.push(refFile);

        // Convert the absolute path back to a relative path before adding to results
        const relativeRefPath = path.relative(process.cwd(), refPath);

        // Ensure we format it correctly (using standard Unix separators, mostly for cross-platform safety)
        const normalizedPath = relativeRefPath.split(path.sep).join('/');

        // Add to our set of dependents
        dependents.add(normalizedPath);
      }
    }
  }

  // 3. Return primitive strings, letting the `Project` be garbage collected
  return Array.from(dependents);
}
