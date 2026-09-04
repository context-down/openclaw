import type { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

const PREPARING = 0;
const READY = 1;
const PERMITTED = 2;
const CLAIMED = 3;
const COMMITTED = 4;
const ABORTED = 5;
const AUTHORIZATION_TIMEOUT_MS = 5_000;
const CLAIM_TIMEOUT_MS = 100;

/** A fresh, private cell belongs to exactly one reclamation Worker and one outer transaction. */
export function createReclamationCommitControl(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
}

function controlView(control: SharedArrayBuffer): Int32Array {
  if (
    !(control instanceof SharedArrayBuffer) ||
    control.byteLength !== Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("Invalid guarded reclamation commit control");
  }
  return new Int32Array(control);
}

function abortBeforeClaim(state: Int32Array): void {
  for (const expected of [PREPARING, READY, PERMITTED]) {
    Atomics.compareExchange(state, 0, expected, ABORTED);
  }
  Atomics.notify(state, 0);
}

export function prepareReclamationCommit(
  control: SharedArrayBuffer,
  ready: () => void,
): { beforeCommit: () => void; committed: () => void } {
  const state = controlView(control);
  if (Atomics.load(state, 0) !== PREPARING) {
    throw new Error("Guarded reclamation commit control has already been used");
  }
  return {
    beforeCommit() {
      if (Atomics.compareExchange(state, 0, PREPARING, READY) !== PREPARING) {
        throw new Error("Guarded reclamation closed before preparation");
      }
      ready();
      Atomics.wait(state, 0, READY, AUTHORIZATION_TIMEOUT_MS);
      // This CAS starts the one synchronous COMMIT. No await, message, or callback
      // follows the claim before returning directly to the transaction owner's db.exec.
      if (Atomics.compareExchange(state, 0, PERMITTED, CLAIMED) !== PERMITTED) {
        abortBeforeClaim(state);
        throw new Error("Guarded reclamation commit was not authorized");
      }
    },
    committed() {
      if (Atomics.compareExchange(state, 0, CLAIMED, COMMITTED) !== CLAIMED) {
        throw new Error("Guarded reclamation committed without its claim");
      }
    },
  };
}

export function bindReclamationCommit(
  worker: Worker,
  control: SharedArrayBuffer,
  guard: () => void,
): { ready: () => void; finish: (error?: Error) => Error | undefined } {
  const state = controlView(control);
  let closed = false;
  let guardFailure: Error | undefined;
  let coordinationError: Error | undefined;
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    ready() {
      if (closed || Atomics.load(state, 0) !== READY) {
        return;
      }
      // Ready is sent only after rollbackable SQL. Bound the remaining settlement;
      // terminate only this Worker, and still wait for its exit before rejecting.
      settlementTimer = setTimeout(() => {
        coordinationError = new Error(
          "Guarded reclamation Worker did not settle after preparation",
        );
        abortBeforeClaim(state);
        void worker.terminate();
      }, AUTHORIZATION_TIMEOUT_MS);
      try {
        if (isPromiseLike(guard())) {
          throw new Error("Guarded reclamation authority must be synchronous");
        }
        const deadline = performance.now() + CLAIM_TIMEOUT_MS;
        if (Atomics.compareExchange(state, 0, READY, PERMITTED) !== READY) {
          throw new Error("Guarded reclamation closed during authority validation");
        }
        Atomics.notify(state, 0);
        // Keep the parent's authority owner synchronous until claim or atomic abort.
        // Polling the cell avoids requiring any Worker message after the commit claim.
        while (Atomics.load(state, 0) === PERMITTED && performance.now() < deadline) {
          Atomics.wait(state, 0, PERMITTED, 1);
        }
        if (Atomics.compareExchange(state, 0, PERMITTED, ABORTED) === PERMITTED) {
          Atomics.notify(state, 0);
          coordinationError = new Error("Guarded reclamation Worker did not claim commit in time");
        }
      } catch (error) {
        guardFailure = toStringifiedError(error);
        abortBeforeClaim(state);
      }
    },
    finish(error) {
      closed = true;
      clearTimeout(settlementTimer);
      abortBeforeClaim(state);
      // Preserve the caller's exact error (including Gateway error subclasses).
      if (guardFailure) {
        return guardFailure;
      }
      const failure = coordinationError ?? error;
      const phase = Atomics.load(state, 0);
      if (phase === CLAIMED) {
        return new Error(
          "Guarded reclamation commit started; outcome is uncertain; do not retry automatically",
          { cause: failure },
        );
      }
      if (failure && phase === COMMITTED) {
        return new Error(
          "Guarded reclamation committed but Worker settlement failed; do not retry automatically",
          { cause: failure },
        );
      }
      if (failure || phase !== COMMITTED) {
        return failure ?? new Error("Guarded reclamation exited without committing");
      }
      return undefined;
    },
  };
}
