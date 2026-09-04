import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveWritableSandboxBindHostRoots,
  type resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/file-access-runtime";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { isCodexAppServerProxyLaunch, normalizeCodexAppServerArgs } from "./launch-args.js";
import type { CodexSandboxPolicy } from "./protocol.js";

/** Own native configuration outside all model-writable mounts before starting its process. */
export async function prepareCodexSandboxNativeContext(params: {
  appServer: CodexAppServerRuntimeOptions;
  agentDir: string;
  effectiveWorkspace: string;
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>>;
  nativeToolSurfaceEnabled: boolean;
}) {
  const { appServer, sandbox } = params;
  if (!sandbox?.enabled || params.nativeToolSurfaceEnabled) {
    return undefined;
  }
  if (
    appServer.start.transport !== "stdio" ||
    appServer.connectionClass === "remote" ||
    appServer.start.homeScope === "user" ||
    isCodexAppServerProxyLaunch(appServer.start.args) ||
    appServer.networkProxy
  ) {
    throw new Error(
      "Sandboxed Codex without native tools requires an agent-owned local stdio runtime without a native network permission profile.",
    );
  }
  const agentDir = await canonicalPathFromExistingAncestor(path.resolve(params.agentDir));
  const codexHome = await canonicalPathFromExistingAncestor(
    resolveCodexAppServerLocalHomeDir(appServer.start, params.agentDir),
  );
  if (!isPathInside(agentDir, codexHome) || codexHome === agentDir) {
    throw new Error(
      "Sandboxed Codex requires its native home inside the protected agent directory.",
    );
  }
  const cwd = await fs.realpath(params.effectiveWorkspace);
  // Check each bind independently: a read-only shadow must not hide a broader writable mount.
  const modelRoots = [
    params.effectiveWorkspace,
    sandbox.workspaceDir,
    sandbox.agentWorkspaceDir,
    ...(sandbox.docker.binds ?? []).flatMap((bind) => resolveWritableSandboxBindHostRoots([bind])),
  ];
  for (const modelRoot of new Set(modelRoots)) {
    const resolvedRoot = await canonicalPathFromExistingAncestor(path.resolve(modelRoot));
    if (isPathInside(resolvedRoot, agentDir) || isPathInside(agentDir, resolvedRoot)) {
      throw new Error(
        "Sandboxed Codex native configuration overlaps a model-accessible workspace or writable bind.",
      );
    }
    if (resolvedRoot !== cwd && isPathInside(resolvedRoot, cwd)) {
      // Replacing cwd with a symlink could select another canonical project's
      // trust before our exact workspace pin. The model may write inside cwd,
      // but must not own an ancestor that can replace the workspace mount root.
      throw new Error(
        "Sandboxed Codex cannot protect workspace identity through a model-writable ancestor mount.",
      );
    }
  }
  if (appServer.sessionRoot) {
    const sessionRoot = await canonicalPathFromExistingAncestor(appServer.sessionRoot);
    if (!isPathInside(sessionRoot, cwd)) {
      throw new Error("Sandboxed Codex workspace is outside the resolved session permission root.");
    }
  }
  await fs.mkdir(params.agentDir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(params.agentDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw new Error(
      "Sandboxed Codex requires a real protected agent directory without group or other write access.",
    );
  }
  // JSON string escapes are valid TOML basic-string escapes; also escape DEL,
  // which JSON permits literally but TOML prohibits inside basic strings.
  const workspaceTrustKey = JSON.stringify(cwd).replace(/\u007f/gu, "\\u007f");
  let args = appServer.start.args;
  for (const override of [
    "project_root_markers=[]",
    // Native override keys split on dots; preserve the opaque path in a TOML value.
    // Hook commands still execute from the real workspace while its config is disabled.
    `projects={${workspaceTrustKey}={trust_level="untrusted"}}`,
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "sandbox_workspace_write.network_access=false",
    "sandbox_workspace_write.writable_roots=[]",
  ]) {
    args = normalizeCodexAppServerArgs(args, override);
  }
  const writable = appServer.sandbox === "workspace-write" && sandbox.workspaceAccess === "rw";
  const sandboxPolicy: CodexSandboxPolicy = writable
    ? {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      }
    : { type: "readOnly", networkAccess: false };
  return {
    cwd,
    sandboxPolicy,
    appServer: {
      ...appServer,
      // Explicit turn policy carries the permitted root without reopening project discovery.
      sessionRoot: undefined,
      sandbox: writable ? "workspace-write" : "read-only",
      start: { ...appServer.start, cwd, args },
    } satisfies CodexAppServerRuntimeOptions,
  };
}
