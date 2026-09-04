import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  preload: undefined as string | undefined,
  materializedBytes: 0,
  atReady: undefined as (() => void) | undefined,
  fault: undefined as "lost-ready" | "lost-result" | "exit-ready" | "duplicate-ready" | undefined,
  workers: [] as import("node:worker_threads").Worker[],
  beforeMaterialize: undefined as (() => Promise<void>) | undefined,
  beforeReclamation: undefined as (() => void) | undefined,
}));

// Wrap only the exact real reclamation Worker. Its SQL, control cell, and exit are real.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        if (archiveMaterializationHook.preload) {
          args[1] = {
            ...args[1],
            execArgv: [
              ...(args[1]?.execArgv ?? []),
              "--import",
              archiveMaterializationHook.preload,
            ],
          };
        }
        if (args[1]?.workerData?.operation === "reclaim-guarded") {
          archiveMaterializationHook.materializedBytes =
            args[1]?.workerData.plan.materializedPlans.reduce(
              (total: number, plan: { archive?: { bytes: Uint8Array } }) =>
                total + (plan.archive?.bytes.byteLength ?? 0),
              0,
            );
        }
        super(...args);
        if (args[1]?.workerData?.operation !== "reclaim-guarded") {
          return;
        }
        archiveMaterializationHook.workers.push(this);
        const emit = this.emit.bind(this);
        vi.spyOn(this as import("node:worker_threads").Worker, "emit").mockImplementation(
          (event, ...values) => {
            const message = values[0] as { type?: string } | undefined;
            if (event === "message" && message?.type === "reclamation-ready") {
              archiveMaterializationHook.atReady?.();
              if (archiveMaterializationHook.fault === "exit-ready") {
                void this.terminate();
                return true;
              }
              if (archiveMaterializationHook.fault === "lost-ready") {
                return true;
              }
              if (archiveMaterializationHook.fault === "duplicate-ready") {
                emit(event, ...values);
              }
            }
            if (
              event === "message" &&
              message?.type === "reclaimed" &&
              archiveMaterializationHook.fault === "lost-result"
            ) {
              return true;
            }
            return emit(event, ...values);
          },
        );
      }
    },
  };
});

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      await archiveMaterializationHook.beforeMaterialize?.();
      return await actual.materializeSessionStateDeletePlans(...args);
    },
  };
});

vi.mock("./session-accessor.sqlite-reclamation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-reclamation.js")>();
  return {
    ...actual,
    runSqliteSessionReclamation: async (
      ...args: Parameters<typeof actual.runSqliteSessionReclamation>
    ) => {
      archiveMaterializationHook.beforeReclamation?.();
      return await actual.runSqliteSessionReclamation(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite reclamation admission races", () => {
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-session-reclamation-admission-race-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(async () => {
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      path: resolveSqliteTargetFromSessionStorePath(storePath).path,
    });
    const workers = archiveMaterializationHook.workers.splice(0);
    const live = workers.filter((worker) => worker.threadId !== -1);
    await Promise.all(live.map((worker) => worker.terminate()));
    expect(live).toHaveLength(0);
    archiveMaterializationHook.preload = undefined;
    archiveMaterializationHook.materializedBytes = 0;
    archiveMaterializationHook.atReady = undefined;
    archiveMaterializationHook.fault = undefined;
    vi.restoreAllMocks();
    archiveMaterializationHook.beforeMaterialize = undefined;
    archiveMaterializationHook.beforeReclamation = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it.each(["current", "historical"] as const)(
    "rechecks caller authority at %s reclamation instead of trusting the dispatch check",
    async (generation) => {
      const sessionKey = "agent:main:reclamation-authority";
      const sessionId = "reclamation-authority-current";
      const event = { type: "session" as const, id: sessionId, content: "retain after revocation" };
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [event]);
      if (generation === "historical") {
        await replaceSessionEntry(
          { sessionKey, storePath },
          { sessionId: "reclamation-authority-next", updatedAt: 2 },
        );
      }
      let authorized = true;
      archiveMaterializationHook.beforeReclamation = () => {
        authorized = false;
      };

      const outcome = await deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        commitGuard: () => {
          if (!authorized) {
            throw new Error("caller authority closed");
          }
        },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      expect
        .soft(outcome)
        .toHaveProperty("error", expect.objectContaining({ message: "caller authority closed" }));
      expect(await loadTranscriptEvents({ sessionKey, sessionId, storePath })).toEqual([event]);
    },
  );

  it.each(["current", "historical"] as const)(
    "rolls back prepared %s SQL and rethrows the exact parent authority error",
    async (generation) => {
      const sessionKey = "agent:main:guarded-rollback";
      const sessionId = "guarded-rollback";
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
        {
          type: "message",
          id: "rollback-message",
          message: { role: "user", content: "retain searchable text" },
        },
      ]);
      if (generation === "historical") {
        await replaceSessionEntry(
          { sessionKey, storePath },
          { sessionId: "guarded-next", updatedAt: 2 },
        );
      }
      const options = {
        agentId: "main",
        path: resolveSqliteTargetFromSessionStorePath(storePath).path,
      };
      await waitForSessionTranscriptIndexReconcile(options);
      const database = openOpenClawAgentDatabase(options);
      const tables = [
        "session_nodes",
        "session_windows",
        "transcript_events",
        "session_transcript_active_events",
        "session_transcript_index_state",
        "session_transcript_fts",
        "transcript_rewrite_watermarks",
        "session_transcript_archives",
      ];
      const snapshot = () =>
        tables.map((table) => database.db.prepare(`SELECT * FROM ${table}`).all());
      const before = snapshot();
      expect(before[2]).toHaveLength(1);
      expect(before[3]).toHaveLength(1);
      expect(before[4]).toHaveLength(1);
      expect(before[5]).toHaveLength(1);
      const rejection = new Error("parent authority revoked after SQL preparation");
      let prepared = false;
      archiveMaterializationHook.atReady = () => {
        prepared = true;
      };
      await expect(
        deleteSessionEntryLifecycle({
          archiveTranscript: true,
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          commitGuard: () => {
            if (prepared) {
              // A parent guard sees the committed WAL snapshot, without waiting on the writer.
              expect(snapshot()).toEqual(before);
              throw rejection;
            }
          },
        }),
      ).rejects.toBe(rejection);
      expect(prepared).toBe(true);
      expect(snapshot()).toEqual(before);
    },
  );

  // POSIX statfs emulates only mount classification; the journals, locks and Workers are real.
  // Windows uses UNC classification instead and retains the existing Worker-close coverage.
  it.skipIf(process.platform === "win32").each([
    { journal: "wal", reject: false },
    { journal: "wal", reject: true },
    { journal: "delete", reject: false },
    { journal: "delete", reject: true },
  ])(
    "keeps spill-sized $journal preparation readable (reject=$reject)",
    async ({ journal, reject }) => {
      if (journal === "delete") {
        const root = fs.realpathSync(path.resolve(storePath, "../../../.."));
        const statfs = fs.statfsSync;
        vi.spyOn(fs, "statfsSync").mockImplementation((...args) => {
          const result = statfs(...args);
          if (String(args[0]).startsWith(`${root}${path.sep}`)) {
            result.type = typeof result.type === "bigint" ? 0x6969n : 0x6969;
          }
          return result;
        });
        const preload = path.join(root, "rollback-mount.mjs");
        fs.writeFileSync(
          preload,
          `
        import fs from "node:fs";
        import path from "node:path";
        import { syncBuiltinESMExports } from "node:module";
        const statfs = fs.statfsSync;
        fs.statfsSync = (...args) => {
          const result = statfs(...args);
          if (String(args[0]).startsWith(${JSON.stringify(root)} + path.sep)) {
            result.type = typeof result.type === "bigint" ? 0x6969n : 0x6969;
          }
          return result;
        };
        syncBuiltinESMExports();
      `,
        );
        archiveMaterializationHook.preload = pathToFileURL(preload).href;
      }
      const sessionKey = "agent:main:spill-sized";
      const sessionId = "spill-sized";
      const unrelatedKey = "agent:main:spill-unrelated";
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
      await replaceSessionEntry(
        { sessionKey: unrelatedKey, storePath },
        { sessionId: "unrelated", updatedAt: 2 },
      );
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
        {
          type: "session",
          id: sessionId,
          content: randomBytes(8 * 1024 * 1024).toString("base64"),
        },
        {
          type: "message",
          id: "searchable",
          message: { role: "user", content: "retain searchable text" },
        },
      ]);
      const options = {
        agentId: "main",
        path: resolveSqliteTargetFromSessionStorePath(storePath).path,
      };
      await waitForSessionTranscriptIndexReconcile(options);
      const { db } = openOpenClawAgentDatabase(options);
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: journal });
      const spill = db.prepare("PRAGMA cache_spill").get();
      expect(Number(spill?.cache_spill)).toBeGreaterThan(0);
      const tables = [
        "session_nodes",
        "session_windows",
        "transcript_events",
        "session_transcript_active_events",
        "session_transcript_index_state",
        "session_transcript_fts",
        "transcript_rewrite_watermarks",
        "session_transcript_archives",
      ];
      const hash = (value: string) => createHash("sha256").update(value).digest("hex");
      const snapshot = () =>
        tables.map((table) => hash(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())));
      const before = snapshot();
      for (const table of tables.slice(3, 6)) {
        expect(
          Number(
            db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId)?.n,
          ),
        ).toBeGreaterThan(0);
      }
      const expectedArchiveHash = hash(
        db
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
          .all(sessionId)
          .map((row) => `${String(row.event_json)}\n`)
          .join(""),
      );
      const rejection = new Error("spill-sized authority rejected");
      let prepared = false;
      let guardMs = 0;
      const rssBefore = process.memoryUsage.rss();
      let rssReady = 0;
      archiveMaterializationHook.atReady = () => {
        prepared = true;
        rssReady = process.memoryUsage.rss();
      };
      let previous = performance.now();
      let maxGapMs = 0;
      const heartbeat = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - previous);
        previous = now;
      }, 10);
      const result = await deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        commitGuard: () => {
          if (!prepared) {
            return;
          }
          const start = performance.now();
          try {
            expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
          } finally {
            guardMs = performance.now() - start;
          }
          if (reject) {
            throw rejection;
          }
        },
      })
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        )
        .finally(() => {
          maxGapMs = Math.max(maxGapMs, performance.now() - previous);
          clearInterval(heartbeat);
        });
      if (process.env.OPENCLAW_TEST_RECLAMATION_LOG === "1") {
        process.stdout.write(
          `${JSON.stringify({
            owner: "guarded-spill",
            journal,
            reject,
            prepared,
            guardMs,
            maxGapMs,
            rssBefore,
            rssReady,
            rssAfter: process.memoryUsage.rss(),
            materializedBytes: archiveMaterializationHook.materializedBytes,
            error: result.error instanceof Error ? result.error.message : null,
          })}\n`,
        );
      }
      expect.soft(prepared).toBe(true);
      expect.soft(guardMs).toBeLessThan(500);
      expect.soft(maxGapMs).toBeLessThan(500);
      expect(archiveMaterializationHook.materializedBytes).toBeGreaterThan(4 * 1024 * 1024);
      if (reject) {
        expect(result.error).toBe(rejection);
        expect(snapshot()).toEqual(before);
      } else {
        expect(result.error).toBeUndefined();
        expect(result.value?.deleted).toBe(true);
        expect(result.value?.archivedTranscripts).toHaveLength(1);
        expect(
          hash(readSessionArchiveContentSync(result.value!.archivedTranscripts[0]!.archivedPath!)),
        ).toBe(expectedArchiveHash);
        expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
        for (const table of tables.slice(1, -1)) {
          expect(
            db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId),
          ).toEqual({ n: 0 });
        }
        expect(
          db
            .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
            .get(sessionId),
        ).toEqual({ published_at: expect.any(Number) });
      }
      expect(loadSessionEntry({ sessionKey: unrelatedKey, storePath })).toMatchObject({
        sessionId: "unrelated",
      });
      expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: journal });
      expect(db.prepare("PRAGMA cache_spill").get()).toEqual(spill);
    },
  );

  it.each(["lost-ready", "exit-ready", "lost-result", "duplicate-ready"] as const)(
    "settles a real guarded Worker with %s without replaying authority",
    async (fault) => {
      const sessionKey = "agent:main:guarded-settlement";
      const sessionId = "guarded-settlement";
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
        { type: "session", id: sessionId },
      ]);
      archiveMaterializationHook.fault = fault;
      let ready = false;
      let readyGuardCalls = 0;
      archiveMaterializationHook.atReady = () => {
        ready = true;
      };
      const deletion = deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        commitGuard: () => {
          if (ready) {
            readyGuardCalls += 1;
          }
        },
      });
      if (fault === "duplicate-ready") {
        await expect(deletion).resolves.toMatchObject({
          deleted: true,
          archivedTranscripts: [expect.objectContaining({ sessionId })],
        });
      } else {
        await expect(deletion).rejects.toThrow(
          fault === "lost-result"
            ? "committed but Worker settlement failed"
            : /not authorized|exited with code/,
        );
      }
      expect(ready).toBe(true);
      expect(readyGuardCalls).toBe(fault === "lost-ready" || fault === "exit-ready" ? 0 : 1);
      expect(archiveMaterializationHook.workers.every((worker) => worker.threadId === -1)).toBe(
        true,
      );
      const committed = fault === "lost-result" || fault === "duplicate-ready";
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: resolveSqliteTargetFromSessionStorePath(storePath).path,
      });
      const archives = database.db
        .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
        .all(sessionId);
      expect(archives).toEqual(
        committed ? [{ published_at: fault === "lost-result" ? null : expect.any(Number) }] : [],
      );
      expect(loadSessionEntry({ sessionKey, storePath }) === undefined).toBe(committed);
      expect(await loadTranscriptEvents({ sessionKey, sessionId, storePath })).toHaveLength(
        committed ? 0 : 1,
      );
    },
  );

  it("fences new historical-generation work through the Worker commit", async () => {
    const sessionKey = "agent:main:historical-admission-race";
    const historicalSessionId = "historical-admission-previous";
    const currentSessionId = "historical-admission-current";
    const historicalEvent = {
      type: "session" as const,
      id: historicalSessionId,
      content: "historical admission transcript",
    };
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: historicalSessionId, updatedAt: 1 },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }, [
      historicalEvent,
    ]);
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: currentSessionId, updatedAt: 2 },
    );

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await materializationStarted;
    const assertHistoricalGenerationExists = async () => {
      const events = await loadTranscriptEvents({
        sessionKey,
        sessionId: historicalSessionId,
        storePath,
      });
      if (events.length === 0) {
        throw new Error("historical generation no longer exists");
      }
    };
    let admissionSettled = false;
    const admissionOutcome = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, historicalSessionId],
      assertAllowed: assertHistoricalGenerationExists,
      revalidateAllowed: assertHistoricalGenerationExists,
    })
      .then((lease) => {
        lease.release();
        return "admitted";
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .finally(() => {
        admissionSettled = true;
      });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(admissionSettled).toBe(false);
    releaseMaterialization();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(admissionOutcome).resolves.toBe("historical generation no longer exists");
    await expect(
      loadTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }),
    ).resolves.toEqual([]);
  });

  it("fences new current-generation work through the Worker commit", async () => {
    const sessionKey = "agent:main:current-admission-race";
    const sessionId = "current-admission-run";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      { type: "session", id: sessionId, content: "current admission transcript" },
    ]);

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await materializationStarted;
    const assertCurrentGenerationExists = async () => {
      const events = await loadTranscriptEvents({ sessionKey, sessionId, storePath });
      if (events.length === 0) {
        throw new Error("current generation no longer exists");
      }
    };
    let admissionSettled = false;
    const admissionOutcome = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: assertCurrentGenerationExists,
      revalidateAllowed: assertCurrentGenerationExists,
    })
      .then((lease) => {
        lease.release();
        return "admitted";
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .finally(() => {
        admissionSettled = true;
      });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(admissionSettled).toBe(false);
    releaseMaterialization();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(admissionOutcome).resolves.toBe("current generation no longer exists");
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([]);
  });
});
