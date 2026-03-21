import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { findDownstreamDependents } from "./dependency-graph";

// Hoist the mock of ts-morph so it applies before imports
vi.mock("ts-morph", async () => {
  const actual = await vi.importActual<typeof import("ts-morph")>("ts-morph");

  class MockProject {
    sourceFiles: Map<string, unknown>;

    constructor() {
      this.sourceFiles = new Map();

      const createMockSourceFile = (filePath: string, referencingFiles: string[]) => ({
        getFilePath: () => filePath,
        getReferencingSourceFiles: () => referencingFiles.map(rf => this.sourceFiles.get(rf))
      });

      const aPath = path.resolve(process.cwd(), "src/a.ts");
      const bPath = path.resolve(process.cwd(), "src/b.ts");
      const cPath = path.resolve(process.cwd(), "src/c.ts");
      const dPath = path.resolve(process.cwd(), "src/d.ts");
      const ePath = path.resolve(process.cwd(), "src/e.ts");

      const fPath = path.resolve(process.cwd(), "src/f.ts");
      const gPath = path.resolve(process.cwd(), "src/g.ts");

      // In-memory mapping
      this.sourceFiles.set(aPath, createMockSourceFile(aPath, [bPath]));
      this.sourceFiles.set(bPath, createMockSourceFile(bPath, [cPath]));
      this.sourceFiles.set(cPath, createMockSourceFile(cPath, [ePath]));
      this.sourceFiles.set(dPath, createMockSourceFile(dPath, []));
      this.sourceFiles.set(ePath, createMockSourceFile(ePath, []));

      // F is modified -> G references F
      this.sourceFiles.set(fPath, createMockSourceFile(fPath, [gPath]));
      // G is modified -> F references G
      this.sourceFiles.set(gPath, createMockSourceFile(gPath, [fPath]));
    }

    getSourceFileOrThrow(absolutePath: string) {
      if (absolutePath === path.resolve(process.cwd(), "src/invalid.ts")) {
        throw new Error("Syntax Error");
      }

      const sf = this.sourceFiles.get(absolutePath);
      if (!sf) {
        throw new Error(`File not found: ${absolutePath}`);
      }
      return sf;
    }
  }

  return {
    ...actual,
    Project: MockProject
  };
});

describe("Dependency Graph AST Engine", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should trace transitive dependents (A -> B -> C -> E)", async () => {
    const dependents = await findDownstreamDependents(["src/a.ts"]);

    expect(dependents).toContain("src/b.ts");
    expect(dependents).toContain("src/c.ts");
    expect(dependents).toContain("src/e.ts");
    expect(dependents).not.toContain("src/a.ts");
    expect(dependents).not.toContain("src/d.ts");

    expect(dependents.length).toBe(3);
  });

  it("should handle circular dependencies without infinite loops", async () => {
    const dependents = await findDownstreamDependents(["src/f.ts"]);

    // In our implementation, since modifiedFiles puts F in visited,
    // G referencing F is returned, and F referencing G is skipped because visited has it.
    // However, because we input 'src/f.ts' which translates to absolute path during init
    // `visited` stores the absolute path.
    // So the output should contain just G! (F is an input, not a downstream dependent)
    expect(dependents).toContain("src/g.ts");
    expect(dependents.length).toBe(1);
  });

  it("should provide fault tolerance for unparseable files", async () => {
    const dependents = await findDownstreamDependents(["src/a.ts", "src/invalid.ts"]);

    expect(dependents).toContain("src/b.ts");
    expect(dependents).toContain("src/c.ts");

    expect(warnSpy).toHaveBeenCalledWith(
      "[AST Engine] Skipped unparseable or untracked file:",
      path.resolve(process.cwd(), "src/invalid.ts"),
      "Syntax Error"
    );
  });
});
