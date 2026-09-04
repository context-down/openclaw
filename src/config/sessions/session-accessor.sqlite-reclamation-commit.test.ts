import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  bindReclamationCommit,
  createReclamationCommitControl,
} from "./session-accessor.sqlite-reclamation-commit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["missed-claim", "exit-after-claim", "slow-guard", "lost-exit"] as const)(
  "closes a %s handoff without a stale permit or an invented commit outcome",
  async (fault) => {
    const databasePath = path.join(tempDirs.make("openclaw-reclamation-handoff-"), "test.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY); INSERT INTO entries VALUES ('kept');",
    );
    const control = createReclamationCommitControl();
    // The real transaction/gate run on a real Worker/SQLite connection. Faults bracket
    // the claim edge only; neither the mutation nor the coordination is reimplemented.
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { register } = await import(workerData.tsxUrl);
        register({ tsconfig: workerData.tsconfig });
        const { DatabaseSync } = require('node:sqlite');
        const { prepareReclamationCommit } = await import(workerData.gateUrl);
        const { runSqliteImmediateTransactionSync } = await import(workerData.transactionUrl);
        const db = new DatabaseSync(workerData.databasePath);
        const gate = prepareReclamationCommit(workerData.control, () => {
          parentPort.postMessage('ready');
          if (workerData.fault === 'missed-claim') {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
          }
        });
        try {
          runSqliteImmediateTransactionSync(db, () => db.exec('DELETE FROM entries'), {
            beforeCommit() {
              gate.beforeCommit();
              if (workerData.fault === 'exit-after-claim') process.exit(17);
            },
          });
          gate.committed();
          if (workerData.fault === 'lost-exit') setInterval(() => {}, 1000);
        } finally {
          db.close();
          parentPort.close();
        }
      })().catch(error => { throw error; });
    `,
      {
        eval: true,
        execArgv: [],
        workerData: {
          tsxUrl: import.meta.resolve("tsx/esm/api"),
          tsconfig: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
          control,
          databasePath,
          fault,
          gateUrl: new URL("./session-accessor.sqlite-reclamation-commit.ts", import.meta.url).href,
          transactionUrl: new URL("../../infra/sqlite-transaction.ts", import.meta.url).href,
        },
      },
    );
    const guard = vi.fn(() => {
      // The old row is still visible while the Worker's delete is rollbackable.
      expect(db.prepare("SELECT id FROM entries").all()).toEqual([{ id: "kept" }]);
      if (fault === "slow-guard") {
        // Guard work is not time spent waiting for a permitted Worker to claim.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    });
    const parent = bindReclamationCommit(worker, control, guard);
    let workerError: Error | undefined;
    worker.on("error", (error) => {
      workerError = toStringifiedError(error);
    });
    worker.on("message", () => {
      parent.ready();
    });
    try {
      const code = await new Promise<number>((resolve) => {
        worker.once("exit", resolve);
      });
      const outcome = parent.finish(
        workerError ?? (code === 0 ? undefined : new Error(`Worker exited ${code}`)),
      );
      if (fault === "slow-guard") {
        expect(outcome).toBeUndefined();
      } else {
        expect(outcome).toBeInstanceOf(Error);
        expect(outcome?.message).toContain(
          fault === "missed-claim"
            ? "did not claim commit in time"
            : fault === "lost-exit"
              ? "committed but Worker settlement failed"
              : "outcome is uncertain",
        );
      }
      expect(guard).toHaveBeenCalledTimes(1);
      parent.ready();
      expect(guard).toHaveBeenCalledTimes(1);
      expect(worker.threadId).toBe(-1);
      expect(db.prepare("SELECT id FROM entries").all()).toEqual(
        fault === "slow-guard" || fault === "lost-exit" ? [] : [{ id: "kept" }],
      );
    } finally {
      parent.finish();
      await worker.terminate();
      db.close();
    }
  },
);
