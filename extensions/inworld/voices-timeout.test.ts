// Inworld voice list timeout proof.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listInworldVoices } from "./tts.js";

describe("listInworldVoices timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a hanging voice list request within the configured timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchStarted = createDeferred<void>();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("guarded fetch did not pass an abort signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () =>
              reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted")),
            { once: true },
          );
          fetchStarted.resolve();
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = listInworldVoices({
      apiKey: "test-key",
      baseUrl: "https://custom.inworld.example.com",
      timeoutMs: 250,
    });
    const rejection = expect(request).rejects.toThrow(/aborted|timeout|timed out/i);

    try {
      // Lazy imports are not fake-timer work; wait for the actual request boundary.
      await Promise.race([fetchStarted.promise, request]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(249);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      // Settle the request before restoring fetch, even when an earlier assertion fails.
      await vi.runAllTimersAsync();
      await rejection;
    }
  });
});
