import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type LockRow = {
  sessionId: string;
  filePath: string;
  type: "shared" | "exclusive";
  lockedAt: Date;
};

type SessionRow = {
  id: string;
  status: string;
  branchName: string;
};

const state = {
  locks: [] as LockRow[],
  sessions: [] as SessionRow[],
};

const fileLocks = {
  sessionId: "sessionId",
  filePath: "filePath",
  type: "type",
  lockedAt: "lockedAt",
};

const sessions = {
  id: "id",
  status: "status",
  branchName: "branchName",
};

type Predicate =
  | { kind: "eq"; field: string; value: unknown }
  | { kind: "inArray"; field: string; values: unknown[] };

function matchesPredicate(row: Record<string, unknown>, predicate: Predicate): boolean {
  if (predicate.kind === "eq") {
    return row[predicate.field] === predicate.value;
  }

  return predicate.values.includes(row[predicate.field]);
}

function mapSelection(
  selection: Record<string, string>,
  lock: LockRow,
  session?: SessionRow,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, column] of Object.entries(selection)) {
    if (column in lock) {
      result[key] = lock[column as keyof LockRow];
      continue;
    }

    if (session && column in session) {
      result[key] = session[column as keyof SessionRow];
    }
  }

  return result;
}

vi.mock("drizzle-orm", () => ({
  eq: (field: string, value: unknown): Predicate => ({ kind: "eq", field, value }),
  inArray: (field: string, values: unknown[]): Predicate => ({ kind: "inArray", field, values }),
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => ({ values }),
}));

vi.mock("@/db/schema", () => ({
  fileLocks,
  sessions,
}));

vi.mock("@/db", () => ({
  db: {
    transaction: async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const tx = {
        execute: async (query: { values: unknown[] }) => {
          const uniquePaths = (query.values[0] as string[]) ?? [];
          const rows = state.locks
            .filter((lock) => uniquePaths.includes(lock.filePath))
            .map((lock) => ({
              sessionId: lock.sessionId,
              filePath: lock.filePath,
              type: lock.type,
            }));
          return { rows };
        },
        insert: (table: Record<string, string>) => ({
          values: async (rows: LockRow[] | LockRow) => {
            if (table !== fileLocks) {
              return;
            }

            const toInsert = Array.isArray(rows) ? rows : [rows];
            for (const row of toInsert) {
              const exists = state.locks.some(
                (existing) =>
                  existing.filePath === row.filePath && existing.sessionId === row.sessionId,
              );
              if (!exists) {
                state.locks.push({
                  ...row,
                  lockedAt: row.lockedAt ?? new Date(),
                });
              }
            }
          },
        }),
        select: (selection: Record<string, string>) => ({
          from: (table: Record<string, string>) => ({
            where: async (predicate: Predicate) =>
              // Keep the mock signature aligned with drizzle's builder.
              (void table,
              state.locks
                .filter((row) => matchesPredicate(row as unknown as Record<string, unknown>, predicate))
                .map((row) => mapSelection(selection, row))),
          }),
        }),
      };

      return fn(tx);
    },
    insert: (table: Record<string, string>) => ({
      values: async (rows: SessionRow[] | SessionRow) => {
        if (table !== sessions) {
          return;
        }

        const toInsert = Array.isArray(rows) ? rows : [rows];
        for (const row of toInsert) {
          if (!state.sessions.some((existing) => existing.id === row.id)) {
            state.sessions.push(row);
          }
        }
      },
    }),
    select: (selection: Record<string, string>) => ({
      from: (table: Record<string, string>) => ({
        innerJoin: (joinTable: Record<string, string>, joinPredicate: Predicate) => ({
          where: async (predicate: Predicate) =>
            // Keep the mock signature aligned with drizzle's builder.
            (void table,
            void joinTable,
            void joinPredicate,
            state.locks
              .filter((row) => matchesPredicate(row as unknown as Record<string, unknown>, predicate))
              .map((lock) => {
                const session = state.sessions.find((row) => row.id === lock.sessionId);
                return mapSelection(selection, lock, session);
              })),
        }),
      }),
    }),
    delete: (table: Record<string, string>) => ({
      where: async (predicate: Predicate) => {
        if (table === fileLocks) {
          state.locks = state.locks.filter(
            (row) => !matchesPredicate(row as unknown as Record<string, unknown>, predicate),
          );
          return;
        }

        if (table === sessions) {
          state.sessions = state.sessions.filter(
            (row) => !matchesPredicate(row as unknown as Record<string, unknown>, predicate),
          );
        }
      },
    }),
  },
}));

let LockManager: typeof import("./lock-manager").LockManager;

describe("LockManager", () => {
  const TEST_SESSION_1 = "test-session-1";
  const TEST_SESSION_2 = "test-session-2";

  beforeAll(async () => {
    ({ LockManager } = await import("./lock-manager"));
  });

  beforeEach(() => {
    state.locks = [];
    state.sessions = [
      { id: TEST_SESSION_1, branchName: "feature/test-1", status: "executing" },
      { id: TEST_SESSION_2, branchName: "feature/test-2", status: "queued" },
    ];
  });

  it("should successfully lock a file", async () => {
    const filePath = "/src/app/page.tsx";
    const result = await LockManager.requestLock(TEST_SESSION_1, [{ filePath, type: "exclusive" }]);
    expect(result).toBe(true);

    const conflicts = await LockManager.getConflictStatus([filePath]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].sessionId).toBe(TEST_SESSION_1);
  });

  it("should fail to lock an already locked file by another session", async () => {
    const filePath = "/src/app/page.tsx";
    await LockManager.requestLock(TEST_SESSION_1, [{ filePath, type: "exclusive" }]);

    const result = await LockManager.requestLock(TEST_SESSION_2, [{ filePath, type: "exclusive" }]);
    expect(result).toBe(false);
  });

  it("should return conflict metadata from acquireLocks", async () => {
    const filePath = "/src/app/page.tsx";
    await LockManager.requestLock(TEST_SESSION_1, [{ filePath, type: "exclusive" }]);

    const result = await LockManager.acquireLocks(TEST_SESSION_2, [{ filePath, type: "exclusive" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("conflict");
      expect(result.conflicts.some((conflict) => conflict.filePath === filePath)).toBe(true);
    }
  });

  it("should allow the same session to lock the same file again (idempotent-ish)", async () => {
    const filePath = "/src/app/page.tsx";
    await LockManager.requestLock(TEST_SESSION_1, [{ filePath, type: "exclusive" }]);

    const result = await LockManager.requestLock(TEST_SESSION_1, [{ filePath, type: "exclusive" }]);
    expect(result).toBe(true);
  });

  it("should allow locking multiple files at once", async () => {
    const filePaths = ["/src/lib/utils.ts", "/src/lib/db.ts"];
    const result = await LockManager.requestLock(
      TEST_SESSION_2,
      filePaths.map((filePath) => ({ filePath, type: "exclusive" as const })),
    );
    expect(result).toBe(true);

    const conflicts = await LockManager.getConflictStatus(filePaths);
    expect(conflicts.length).toBe(2);
    expect(conflicts.every((conflict) => conflict.sessionId === TEST_SESSION_2)).toBe(true);
  });

  it("should fail if ANY file in the batch is locked by another session", async () => {
    await LockManager.requestLock(TEST_SESSION_1, [{ filePath: "/src/app/page.tsx", type: "exclusive" }]);

    const filePaths = ["/src/app/layout.tsx", "/src/app/page.tsx"];
    const result = await LockManager.requestLock(
      TEST_SESSION_2,
      filePaths.map((filePath) => ({ filePath, type: "exclusive" as const })),
    );
    expect(result).toBe(false);

    const conflicts = await LockManager.getConflictStatus(["/src/app/layout.tsx"]);
    expect(conflicts.length).toBe(0);
  });

  it("should release locks", async () => {
    const filePath = "/src/app/page.tsx";
    await LockManager.requestLock(TEST_SESSION_1, [{ filePath, type: "exclusive" }]);

    await LockManager.releaseLocks(TEST_SESSION_1);
    const conflicts = await LockManager.getConflictStatus([filePath]);
    expect(conflicts.length).toBe(0);
  });
});
