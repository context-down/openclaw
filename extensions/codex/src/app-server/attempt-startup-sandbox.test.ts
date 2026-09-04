import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { bundleMcpThreadConfig, createAttemptParams } from "./attempt-startup.test-support.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { resolveCodexAppServerRuntimeOptions, resolveCodexComputerUseConfig } from "./config.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { prepareCodexSandboxNativeContext } from "./sandbox-native-context.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { createCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";
import { readCodexInheritedMcpServerNames } from "./thread-requests.js";
import { buildTurnStartParams } from "./turn-params.js";

describe("sandboxed Codex native context", () => {
  let root: string;
  beforeEach(async () => {
    resetCodexTestBindingStore();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-context-")));
    await fs.mkdir(path.join(root, "agent"), { mode: 0o700 });
    await fs.mkdir(path.join(root, "workspace"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function prepare(overrides: Partial<Parameters<typeof startCodexAttemptThread>[0]> = {}) {
    const paths = {
      agentDir: path.join(root, "agent"),
      cwd: path.join(root, "workspace"),
      workspaceDir: path.join(root, "workspace"),
      sessionFile: path.join(root, "session.jsonl"),
    };
    const pluginConfig = { appServer: { command: "codex" } };
    const appServer = resolveCodexAppServerRuntimeOptions({
      pluginConfig,
      requirementsToml: null,
      env: {},
    });
    const factory = vi.fn<CodexAppServerClientFactory>(async () => {
      throw new Error("captured startup options");
    });
    const sandbox = {
      ...createSandboxContext({}),
      workspaceDir: paths.workspaceDir,
      agentWorkspaceDir: paths.workspaceDir,
    };
    const params: Parameters<typeof startCodexAttemptThread>[0] = {
      attemptClientFactory: factory,
      bindingStore: testCodexAppServerBindingStore,
      appServer: { ...appServer, sandbox: "workspace-write" },
      pluginConfig,
      computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig }),
      startupAuthProfileId: null,
      startupAuthBindingFingerprint: undefined,
      startupAuthAccountCacheKey: undefined,
      startupEnvApiKeyCacheKey: undefined,
      agentDir: paths.agentDir,
      config: undefined,
      buildAttemptParams: () => ({
        ...createAttemptParams(paths),
        pluginHarnessToolPolicyRestricted: true,
      }),
      sessionAgentId: "agent-1",
      effectiveWorkspace: paths.workspaceDir,
      effectiveCwd: paths.cwd,
      dynamicTools: [],
      webSearchAllowed: false,
      developerInstructions: undefined,
      bundleMcpThreadConfig,
      nativeToolSurfaceEnabled: false,
      nativeProviderWebSearchSupport: "supported",
      sandboxExecServerEnabled: false,
      sandbox,
      contextEngineProjection: undefined,
      startupTimeoutMs: 5000,
      signal: new AbortController().signal,
      onStartupTimeout: vi.fn(),
      spawnedBy: undefined,
      ...overrides,
    };
    return { params, factory };
  }

  it("protects native process configuration before acquiring a client while preserving the tool workspace", async () => {
    const { params, factory } = prepare();
    await expect(startCodexAttemptThread(params)).rejects.toThrow("captured startup options");
    const start = factory.mock.calls[0]?.[0]?.startOptions;
    expect(start?.cwd).toBe(path.join(root, "workspace"));
    expect(start?.args).toContain("project_root_markers=[]");
    expect(start?.args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
    expect(start?.args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(params.effectiveWorkspace).toBe(path.join(root, "workspace"));
    expect(params.appServer.start.cwd).toBeUndefined();
    expect(start?.args).toContain(
      `projects={${JSON.stringify(params.effectiveWorkspace)}={trust_level="untrusted"}}`,
    );
  });

  it.each([
    ["workspace-write", "rw", "workspaceWrite"],
    ["read-only", "rw", "readOnly"],
    ["workspace-write", "ro", "readOnly"],
    ["workspace-write", "none", "readOnly"],
  ] as const)(
    "keeps %s/%s authority across thread startup, context restart and turn requests",
    async (mode, access, expectedType) => {
      const { params } = prepare();
      params.appServer.sandbox = mode;
      params.appServer.sessionRoot = params.effectiveWorkspace;
      params.sandbox!.workspaceAccess = access;
      let starts = 0;
      const requests: Array<{ method: string; params: unknown }> = [];
      const harness = createCodexLifecycleHarness({
        respond: (method, request) => {
          requests.push({ method, params: request });
          if (method === "config/read") {
            return {
              config: {
                project_root_markers: [],
                projects: { [params.effectiveWorkspace]: { trust_level: "untrusted" } },
              },
              layers: [],
            };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "skills/list" || method === "mcpServerStatus/list") {
            return { data: [], nextCursor: null };
          }
          if (method === "thread/start" || method === "thread/resume") {
            return threadStartResult(`protected-${++starts}`, (request as { cwd: string }).cwd);
          }
          throw new Error(`Unexpected native request ${method}`);
        },
      });
      params.attemptClientFactory = async () => harness.client;
      const result = await startCodexAttemptThread(params);
      try {
        const executionCwd = path.join(root, "workspace");
        expect(result.executionCwd).toBe(executionCwd);
        expect(result.sandboxPolicy?.type).toBe(expectedType);
        expect(result.pluginAppServer.sessionRoot).toBeUndefined();
        const turn = buildTurnStartParams(params.buildAttemptParams(), {
          threadId: result.thread.threadId,
          cwd: result.executionCwd,
          appServer: result.pluginAppServer,
          sandboxPolicy: result.sandboxPolicy,
          environmentSelection: result.environmentSelection,
        });
        expect(turn).toMatchObject({
          cwd: executionCwd,
          environments: [],
          sandboxPolicy: { type: expectedType, networkAccess: false },
        });
        expect(turn).not.toHaveProperty("runtimeWorkspaceRoots");
        if (expectedType === "workspaceWrite") {
          expect(turn.sandboxPolicy).toEqual({
            type: "workspaceWrite",
            writableRoots: [params.effectiveWorkspace],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          });
        }
        result.turnRoute.release();
        await result.restartContextEngineCodexThread();
        for (const request of requests.filter(({ method }) =>
          ["config/read", "thread/start", "thread/resume"].includes(method),
        )) {
          expect(request.params).toMatchObject({ cwd: executionCwd });
          if (request.method !== "config/read") {
            expect(request.params).toMatchObject({
              config: {
                project_root_markers: [],
                projects: { [executionCwd]: { trust_level: "untrusted" } },
                "features.shell_tool": false,
                "features.code_mode": false,
              },
              environments: [],
            });
            expect(request.params).not.toHaveProperty("runtimeWorkspaceRoots");
          }
        }
        expect(params.effectiveWorkspace).toBe(path.join(root, "workspace"));
      } finally {
        result.turnRoute.release();
        result.releaseSharedClientLease();
        await harness.client.closeAndWait();
      }
    },
  );

  it.each([
    "workspace",
    "bind",
    "shadowed-bind",
    "symlink",
    "permissions",
    "ancestor-bind",
    "shadowed-ancestor-bind",
    "permission-profile",
  ] as const)(
    "rejects an unsafe native context (%s) before acquiring any client",
    async (scenario) => {
      const { params, factory } = prepare();
      if (scenario === "workspace") {
        params.agentDir = path.join(params.effectiveWorkspace, "agent");
      } else if (scenario === "bind" || scenario === "shadowed-bind") {
        params.sandbox!.docker.binds = [
          `${root}:/shared:rw`,
          ...(scenario === "shadowed-bind" ? [`${path.join(root, "workspace")}:/readonly:ro`] : []),
        ];
      } else if (scenario === "permission-profile") {
        params.appServer.networkProxy = {} as NonNullable<typeof params.appServer.networkProxy>;
      } else if (scenario === "ancestor-bind" || scenario === "shadowed-ancestor-bind") {
        const parent = params.effectiveWorkspace;
        params.effectiveWorkspace = path.join(parent, "nested");
        await fs.mkdir(params.effectiveWorkspace);
        params.sandbox!.workspaceDir = params.effectiveWorkspace;
        params.sandbox!.agentWorkspaceDir = params.effectiveWorkspace;
        params.sandbox!.docker.binds = [
          `${parent}:/shared:rw`,
          ...(scenario === "shadowed-ancestor-bind"
            ? [`${params.effectiveWorkspace}:/readonly:ro`]
            : []),
        ];
      } else if (scenario === "symlink") {
        const alias = path.join(root, "agent-alias");
        await fs.symlink(params.agentDir, alias);
        params.agentDir = alias;
      } else {
        await fs.chmod(params.agentDir, 0o777);
      }
      await expect(startCodexAttemptThread(params)).rejects.toThrow(/Sandboxed Codex/u);
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("leaves native-enabled and unsandboxed startup options unchanged", async () => {
    const { params } = prepare();
    expect(
      await prepareCodexSandboxNativeContext({ ...params, nativeToolSurfaceEnabled: true }),
    ).toBeUndefined();
    expect(await prepareCodexSandboxNativeContext({ ...params, sandbox: null })).toBeUndefined();
    expect(params.appServer.start.cwd).toBeUndefined();
  });

  it("retains protected process options when startup retries after executable selection changes", async () => {
    const { params, factory } = prepare();
    factory.mockRejectedValueOnce(
      Object.assign(new Error("native selection changed"), {
        code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
      }),
    );
    await expect(startCodexAttemptThread(params)).rejects.toThrow("captured startup options");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls.map(([options]) => options?.startOptions)).toEqual([
      expect.objectContaining({
        cwd: path.join(root, "workspace"),
        args: expect.arrayContaining([
          "project_root_markers=[]",
          `projects={${JSON.stringify(params.effectiveWorkspace)}={trust_level="untrusted"}}`,
        ]),
      }),
      expect.objectContaining({
        cwd: path.join(root, "workspace"),
        args: expect.arrayContaining([
          "project_root_markers=[]",
          `projects={${JSON.stringify(params.effectiveWorkspace)}={trust_level="untrusted"}}`,
        ]),
      }),
    ]);
  });

  it.each([
    { name: "dotted", suffix: "with.dots", encodedSuffix: "with.dots" },
    { name: "control characters", suffix: "with.\n\t\u007f", encodedSuffix: "with.\\n\\t\\u007f" },
  ])(
    "canonicalizes a symlinked workspace with $name in its native trust key",
    async ({ suffix, encodedSuffix }) => {
      const { params } = prepare();
      const cwd = path.join(root, `workspace.${suffix}`);
      const alias = path.join(root, "workspace-alias");
      await fs.mkdir(cwd);
      await fs.symlink(cwd, alias);
      params.effectiveWorkspace = alias;
      params.sandbox!.workspaceDir = alias;
      params.sandbox!.agentWorkspaceDir = alias;

      const context = await prepareCodexSandboxNativeContext(params);

      expect(context?.cwd).toBe(cwd);
      expect(context?.appServer.start.cwd).toBe(cwd);
      expect(context?.appServer.start.args).toContain(
        `projects={"${root}/workspace.${encodedSuffix}"={trust_level="untrusted"}}`,
      );
      expect(context?.sandboxPolicy).toMatchObject({ writableRoots: [cwd] });
    },
  );

  it.each([
    {
      name: "missing trust",
      trust: undefined,
      disabledReason: "untrusted",
      error: "effective untrusted workspace",
    },
    {
      name: "managed trust override",
      trust: "trusted",
      disabledReason: "untrusted",
      error: "effective untrusted workspace",
    },
    {
      name: "enabled project layer",
      trust: "untrusted",
      disabledReason: undefined,
      error: "every project config layer to be disabled",
    },
    {
      name: "empty disabled reason",
      trust: "untrusted",
      disabledReason: "",
      error: "every project config layer to be disabled",
    },
  ])("rejects ineffective project isolation ($name)", async ({ trust, disabledReason, error }) => {
    const cwd = path.join(root, "workspace");
    const request = vi.fn(async () => ({
      config: { project_root_markers: [], projects: { [cwd]: { trust_level: trust } } },
      layers: [{ name: { type: "project" }, disabledReason }],
    }));
    await expect(
      readCodexInheritedMcpServerNames(
        { request } as unknown as Parameters<typeof readCodexInheritedMcpServerNames>[0],
        cwd,
        undefined,
        { requireProtectedNativeContext: true },
      ),
    ).rejects.toThrow(error);
  });

  it("admits native disabled project layers without importing their configuration", async () => {
    const cwd = path.join(root, "workspace");
    const request = vi.fn(async () => ({
      config: { project_root_markers: [], projects: { [cwd]: { trust_level: "untrusted" } } },
      layers: [
        {
          name: { type: "project" },
          disabledReason: "untrusted",
          config: { mcp_servers: { ignored: {} } },
        },
      ],
    }));
    await expect(
      readCodexInheritedMcpServerNames(
        { request } as unknown as Parameters<typeof readCodexInheritedMcpServerNames>[0],
        cwd,
        undefined,
        { requireProtectedNativeContext: true },
      ),
    ).resolves.toEqual([]);
  });

  it.each([undefined, [".git"]])(
    "rejects an effective native project root override %j",
    async (markers) => {
      const request = vi.fn(async () => ({
        config: { project_root_markers: markers },
        layers: [],
      }));
      await expect(
        readCodexInheritedMcpServerNames(
          { request } as unknown as Parameters<typeof readCodexInheritedMcpServerNames>[0],
          path.join(root, "agent"),
          undefined,
          { requireProtectedNativeContext: true },
        ),
      ).rejects.toThrow("effective project_root_markers=[]");
    },
  );
});
