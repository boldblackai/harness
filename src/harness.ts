#!/usr/bin/env node

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import minimist, { type ParsedArgs } from "minimist";

const SECCOMP_PROFILE = path.join(
  __dirname,
  "seccomp-profiles",
  "block-af-alg.json",
);

interface Args extends ParsedArgs {
  help: boolean;
  h: boolean;
  // minimist --no- prefix: --no-verify / --no-skills / --no-context-files set these to false; NOT in boolean[] to avoid double-negation
  verify?: boolean;
  ephemeral: boolean;
  local: boolean;
  skills?: boolean;
  "context-files"?: boolean;
  "mount-entire-home"?: boolean;
  "env-file"?: string[] | string;
  e?: string[] | string;
  file?: string;
  f?: string;
  prompt?: string;
  p?: string;
  model?: string;
  m?: string;
  agent?: string;
  a?: string;
  volumes?: string[];
  port?: string[];
  network?: string;
  egress?: string;
}

interface AgentOptions {
  prompt: string | null;
  model: string | null;
  envFilePaths: string[];
}

interface PersistMount {
  hostSubpath: string;
  containerPath: string;
}

interface LocalImage {
  exists: boolean;
  digest: string | null;
}

/** Semantic inputs to a `run` invocation; each runtime formats its own flags. */
interface RunInput {
  interactive: boolean;
  envFileArgs: string[];
  envArgs: string[]; // cloud-mode, adapter, mise envs
  volumeArgs: string[];
  userVolumeArgs: string[];
  portArgs: string[]; // --port publish flags (-p <spec>), runtime-agnostic
  network: string | null; // --network passthrough (egress RFC Tier 1)
  addHostArgs: string[]; // --add-host tokens (egress host-local reachability)
  workdir: string;
  image: string;
  containerCmd: string[];
}

/**
 * Abstraction over the host container runtime (docker, apple/container, ...).
 * The rest of harness (adapters, persistence, skills, cosign) is runtime-
 * agnostic; only image inspection, pulling, and the final `run` argv go
 * through here. By default harness auto-detects the runtime: on macOS, if
 * Apple's `container` CLI is on PATH it is preferred; on every other
 * platform docker is used (apple/container is macOS-only, so a same-named
 * binary elsewhere is an unrelated tool and must not hijack selection).
 * Set HARNESS_CONTAINER_RUNTIME=docker to force docker; `=apple` is a
 * deprecated explicit alias for the apple runtime.
 */
interface ContainerRuntime {
  /** Binary name on PATH (e.g. "docker", "container"). */
  binary(): string;
  /** Token list for the image pull command (without the image, which is appended). */
  pullArgs(image: string): string[];
  /** Resolve a local image's existence and its registry digest (repo@sha256:...). */
  inspectImage(image: string): LocalImage;
  /** Build the full `run` argv (everything after the binary name). */
  runArgs(input: RunInput): string[];
  /** Verify the runtime binary is installed; exit with a hint if not. */
  ensureReady(): void;
}

class DockerRuntime implements ContainerRuntime {
  binary(): string {
    return "docker";
  }

  pullArgs(image: string): string[] {
    return ["pull", image];
  }

  inspectImage(image: string): LocalImage {
    try {
      const out = execFileSync(
        "docker",
        [
          "image",
          "inspect",
          "--format",
          "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}",
          image,
        ],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      )
        .toString()
        .trim();
      return {
        exists: true,
        digest: /@sha256:[0-9a-f]{64}$/.test(out) ? out : null,
      };
    } catch {
      return { exists: false, digest: null };
    }
  }

  runArgs(input: RunInput): string[] {
    const ttyFlags = input.interactive ? ["-it"] : ["-i"];
    return [
      "run",
      "--rm",
      ...ttyFlags,
      "--cap-drop=ALL",
      "--cap-add=NET_RAW",
      "--security-opt",
      "no-new-privileges:true",
      "--security-opt",
      `seccomp=${SECCOMP_PROFILE}`,
      ...(input.network ? ["--network", input.network] : []),
      ...input.addHostArgs,
      ...input.envFileArgs,
      ...input.envArgs,
      ...input.volumeArgs,
      ...input.userVolumeArgs,
      ...input.portArgs,
      "-w",
      input.workdir,
      input.image,
      ...input.containerCmd,
    ];
  }

  ensureReady(): void {
    // docker is the fallback; assume present. (A missing docker surfaces as a
    // clear spawn ENOENT at run time, same as pre-runtime-abstraction behavior.)
  }
}

const HOST_DOCKER_INTERNAL = "host.docker.internal";
// Documentation-range IP apple/container uses to route a custom DNS name to the
// host's localhost. See apple/container how-to: "Access a host service from a
// container".
const APPLE_HOST_LOCALHOST_IP = "203.0.113.113";

function appleHostDockerInternalDnsConfigured(): boolean {
  try {
    const out = execFileSync("container", ["system", "dns", "list"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString();
    return out.includes(HOST_DOCKER_INTERNAL);
  } catch {
    // If we cannot inspect DNS config, do not block the run.
    return true;
  }
}

class AppleContainerRuntime implements ContainerRuntime {
  binary(): string {
    return "container";
  }

  pullArgs(image: string): string[] {
    // apple/container nests pull under the `image` subgroup. Pass
    // --platform so the correct arch variant is pulled: without it (and
    // without CONTAINER_DEFAULT_PLATFORM), `image pull` resolves the
    // platform to nil and selects the first entry in the manifest list
    // (linux/amd64), pulling the wrong arch on Apple Silicon. `container
    // run` defaults to the host arch via its own path, so the image was
    // being pulled twice — once wrong, once right.
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    return ["image", "pull", "--platform", `linux/${arch}`, image];
  }

  inspectImage(image: string): LocalImage {
    let out: string;
    try {
      out = execFileSync("container", ["image", "inspect", image], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).toString();
    } catch {
      return { exists: false, digest: null };
    }
    // apple/container's `image inspect` always emits a JSON array (no
    // --format flag). The image-index/manifest-list digest it reports at
    // data[0].configuration.descriptor.digest is exactly what cosign signs
    // for a multi-arch image and what docker exposes as the RepoDigest.
    try {
      const parsed = JSON.parse(out);
      const digest = Array.isArray(parsed)
        ? parsed[0]?.configuration?.descriptor?.digest
        : null;
      if (typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest)) {
        const repo = image.split(":")[0];
        return { exists: true, digest: `${repo}@${digest}` };
      }
      return { exists: true, digest: null };
    } catch {
      return { exists: true, digest: null };
    }
  }

  runArgs(input: RunInput): string[] {
    // apple/container (Swift ArgumentParser) wants -i and -t as separate
    // tokens (no clustered -it) and space-separated capability values (no
    // `=` join). It has no --security-opt at all: each workload is a microVM
    // with its own guest kernel, so the block-af-alg seccomp profile's
    // host-kernel role is subsumed by the VM boundary and no-new-privileges
    // is only a minor in-guest defense-in-depth loss. Capability
    // restrictions ARE supported, so --cap-drop=ALL --cap-add=NET_RAW stays.
    const ttyFlags = input.interactive ? ["-i", "-t"] : ["-i"];
    // --network is forwarded identically under both runtimes (Tier 1
    // passthrough; apple/container accepts --network natively).
    return [
      "run",
      "--rm",
      ...ttyFlags,
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_RAW",
      ...(input.network ? ["--network", input.network] : []),
      ...input.addHostArgs,
      ...input.envFileArgs,
      ...input.envArgs,
      ...input.volumeArgs,
      ...input.userVolumeArgs,
      ...input.portArgs,
      "-w",
      input.workdir,
      input.image,
      ...input.containerCmd,
    ];
  }

  ensureReady(): void {
    // selectRuntime() already probed `container --version` (memoized); a false
    // here means the probe failed there too — same evidence, one exec.
    if (!appleContainerAvailable()) {
      console.error(
        "harness: the `container` CLI failed its version probe (Apple container, v1.0.0+). Install from https://github.com/apple/container/releases and run `container system start`, or set HARNESS_CONTAINER_RUNTIME=docker to use docker instead.",
      );
      process.exit(1);
    }
    if (!appleHostDockerInternalDnsConfigured()) {
      console.error(
        `harness: ${HOST_DOCKER_INTERNAL} is not configured for Apple's container runtime.\nLocal services on the Mac (e.g. LM Studio on :1234) will not be reachable from the container.\nOne-time fix (requires administrator):\n  sudo container system dns create ${HOST_DOCKER_INTERNAL} --localhost ${APPLE_HOST_LOCALHOST_IP}\nSee https://github.com/apple/container/blob/main/docs/how-to.md#access-a-host-service-from-a-container`,
      );
    }
  }
}

function selectRuntime(): ContainerRuntime {
  const raw = (process.env.HARNESS_CONTAINER_RUNTIME ?? "").toLowerCase();
  if (raw === "docker") {
    return new DockerRuntime();
  }
  if (raw === "apple") {
    // Deprecated: the apple runtime is now auto-detected on macOS. Keep the
    // value working (with a warning) so existing configs don't hard-fail.
    console.error(
      'harness: HARNESS_CONTAINER_RUNTIME=apple is deprecated (the apple runtime is now auto-detected on macOS); unset the variable, or use "auto" or "docker".',
    );
    return new AppleContainerRuntime();
  }
  if (raw !== "" && raw !== "auto") {
    console.error(
      `harness: unknown HARNESS_CONTAINER_RUNTIME="${raw}". Valid values: auto (default), docker, apple (deprecated) — or unset for auto-detect.`,
    );
    process.exit(1);
  }
  // Auto-detect: prefer Apple's container CLI when it actually executes —
  // but only on macOS. apple/container ships for macOS only, so on any other
  // platform a binary named `container` is an unrelated tool and docker stays
  // default. Probing `--version` (not just a PATH lookup) proves the binary
  // runs at all; broken installs, quarantine attributes, and wrong-arch
  // builds all fail here, and execution is what selection depends on.
  if (process.platform === "darwin" && appleContainerAvailable()) {
    return new AppleContainerRuntime();
  }
  return new DockerRuntime();
}

/**
 * Whether Apple's `container` CLI exists and executes. Reuses the same
 * `--version` probe `AppleContainerRuntime.ensureReady()` runs, which is
 * strictly stronger evidence than a PATH lookup. The result is memoized for
 * the process lifetime so `selectRuntime()` and `ensureReady()` share one
 * probe instead of running it twice; it is never persisted across runs, since
 * the CLI's install state can change between invocations.
 */
let appleContainerAvailableMemo: boolean | null = null;

function appleContainerAvailable(): boolean {
  if (appleContainerAvailableMemo === null) {
    try {
      execFileSync("container", ["--version"], {
        stdio: "ignore",
        timeout: 5000,
      });
      appleContainerAvailableMemo = true;
    } catch {
      appleContainerAvailableMemo = false;
    }
  }
  return appleContainerAvailableMemo;
}

interface AgentAdapter {
  buildCommand(options: AgentOptions): string[];
  extraDockerArgs?(options: AgentOptions): string[];
  persistMounts?(): PersistMount[];
  // Container directory where this agent loads global context files. The
  // host's ~/.agents/AGENTS.md and ~/.claude/CLAUDE.md are bind-mounted into
  // this directory (as AGENTS.md / CLAUDE.md) when present.
  contextDir?(): string;
}

class PiAdapter implements AgentAdapter {
  buildCommand({ prompt, model, envFilePaths }: AgentOptions): string[] {
    // In local mode (no env file), pass --provider ollama so pi routes
    // the model to the local LM Studio provider. Without this, model names
    // containing slashes (e.g. HuggingFace IDs like "qwen/qwen3.5-9b") are
    // misinterpreted as provider/model format, causing pi to silently ignore
    // --model and fall back to a default that may require cloud credentials.
    const providerArgs =
      envFilePaths.length === 0 && model ? ["--provider", "ollama"] : [];
    const modelArgs = model ? ["--model", model] : [];
    if (prompt !== null) {
      return ["pi", "-p", prompt, ...providerArgs, ...modelArgs];
    }
    return ["pi", ...providerArgs, ...modelArgs];
  }

  persistMounts(): PersistMount[] {
    return [
      { hostSubpath: "", containerPath: "/home/harness/.pi/agent" },
      { hostSubpath: "npm", containerPath: "/home/harness/.local/share/npm" },
    ];
  }

  contextDir(): string {
    return "/home/harness/.pi/agent";
  }
}

class OpenCodeAdapter implements AgentAdapter {
  buildCommand({ prompt }: AgentOptions): string[] {
    if (prompt !== null) {
      return ["opencode", "run", prompt];
    }
    return ["opencode"];
  }

  extraDockerArgs({ model }: AgentOptions): string[] {
    return model ? ["-e", `OPENCODE_MODEL=${model}`] : [];
  }

  persistMounts(): PersistMount[] {
    return [
      {
        hostSubpath: "config",
        containerPath: "/home/harness/.config/opencode",
      },
      {
        hostSubpath: "share",
        containerPath: "/home/harness/.local/share/opencode",
      },
      {
        hostSubpath: "state",
        containerPath: "/home/harness/.local/state/opencode",
      },
    ];
  }

  contextDir(): string {
    return "/home/harness/.config/opencode";
  }
}

class HermesAdapter implements AgentAdapter {
  buildCommand({ prompt, model }: AgentOptions): string[] {
    const args = ["hermes", "chat"];
    if (model) args.push("-m", model);
    if (prompt !== null) args.push("-q", prompt);
    return args;
  }

  persistMounts(): PersistMount[] {
    return [{ hostSubpath: "", containerPath: "/home/harness/.hermes" }];
  }

  contextDir(): string {
    return "/home/harness/.hermes";
  }
}

const IDENTITY_REGEXP =
  "https://github.com/boldblackai/harness/.github/workflows/docker.yml@refs/heads/main";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";

interface CosignError extends NodeJS.ErrnoException {
  stderr?: string;
}

interface CacheFile {
  version: number;
  verified: Record<string, { tag: string; verifiedAt: string }>;
}

const CACHE_VERSION = 1;

function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "harness", "cosign-verified.json");
}

function readCache(): CacheFile {
  try {
    const raw = fs.readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.version === CACHE_VERSION &&
      parsed.verified &&
      typeof parsed.verified === "object"
    ) {
      return parsed as CacheFile;
    }
  } catch {}
  return { version: CACHE_VERSION, verified: {} };
}

function writeCacheAtomic(cache: CacheFile): void {
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // best-effort; never break verify path
  }
}

function cosign(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("cosign", args, { timeout: 30000 }, (err, _stdout, stderr) => {
      if (err) {
        const e = err as CosignError;
        e.stderr = stderr;
        reject(e);
      } else {
        resolve();
      }
    });
  });
}

async function verifyImage(
  runtime: ContainerRuntime,
  image: string,
): Promise<void> {
  let { exists, digest: digestRef } = runtime.inspectImage(image);
  const cache = readCache();

  if (digestRef && cache.verified[digestRef]) {
    return;
  }

  if (exists && !digestRef) {
    console.error(
      `harness: refusing to verify ${image}: image exists locally but has no registry digest (locally-built?).`,
    );
    console.error(
      "harness: verifying the tag would check registry bytes, not the local image the runtime would run.",
    );
    console.error(
      "harness: use --no-verify, or set HARNESS_IMAGE_TAG for an implicit skip.",
    );
    process.exit(1);
  }

  if (!digestRef) {
    console.error(`harness: pulling ${image} for verification...`);
    try {
      execFileSync(runtime.binary(), runtime.pullArgs(image), {
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 600000,
      });
    } catch {
      console.error(`harness: ${runtime.binary()} pull failed for ${image}`);
      process.exit(1);
    }
    digestRef = runtime.inspectImage(image).digest;
    if (!digestRef) {
      console.error(
        `harness: failed to resolve digest for ${image} after pull`,
      );
      process.exit(1);
    }
    if (cache.verified[digestRef]) {
      return;
    }
  }

  const identityArgs = [
    "--certificate-identity-regexp",
    IDENTITY_REGEXP,
    "--certificate-oidc-issuer",
    OIDC_ISSUER,
  ];

  const verifyP = cosign(["verify", ...identityArgs, digestRef]);
  const attestP = cosign([
    "verify-attestation",
    "--type",
    "slsaprovenance",
    ...identityArgs,
    digestRef,
  ]);

  const [verifyResult, attestResult] = await Promise.allSettled([
    verifyP,
    attestP,
  ]);

  if (verifyResult.status === "rejected") {
    const e = verifyResult.reason as CosignError;
    if (e.code === "ENOENT") {
      console.error(
        "harness: cosign not found — cannot verify image without it.",
      );
      console.error(
        "harness: install cosign (brew install cosign) or pass --no-verify to skip verification.",
      );
      process.exit(1);
    }
    console.error(
      `harness: image signature verification failed for ${digestRef}`,
    );
    console.error(e.stderr?.trim() || e.message);
    process.exit(1);
  }

  if (attestResult.status === "rejected") {
    console.error(
      `harness: WARNING: no provenance attestation found for ${digestRef}`,
    );
  }

  cache.verified[digestRef] = {
    tag: image,
    verifiedAt: new Date().toISOString(),
  };
  writeCacheAtomic(cache);
}

const AGENT_NAMES = ["pi", "opencode", "hermes"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

const ADAPTERS: Record<AgentName, AgentAdapter> = {
  pi: new PiAdapter(),
  opencode: new OpenCodeAdapter(),
  hermes: new HermesAdapter(),
};

function isAgentName(name: string): name is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(name);
}

const USAGE = `Usage: harness [options]

Options:
  -p, --prompt <text>    Pass a prompt directly to the coding agent
  -e, --env-file <file>  Load environment variables from a file into the container; may be repeated
  -f, --file <file>      Mount a single file into the container instead of the current directory
  -m, --model <model>    Override the model used by the agent
  -a, --agent <name>     Select the coding agent adapter: pi, opencode, hermes (default: pi)
  -v, --volumes <spec>   Additional volume mount (host:container[:opts]); may be repeated
  --port <spec>          Publish a container port to the host ([host-ip:]host-port:container-port[/protocol]); may be repeated
  --no-verify            Skip cosign image signature and provenance verification
  --no-skills            Disable mounting user skills directories (~/.agents/skills, ~/.claude/skills)
  --no-context-files     Disable mounting global context files (~/.agents/AGENTS.md, ~/.claude/CLAUDE.md); alias -nc
  --ephemeral            Disable session persistence (implied by -p and piped stdin)
  --local                Force local mode even with -e (use LM Studio / local defaults)
  --mount-entire-home    Allow running from your home directory (mounts all of $HOME as the workspace)
  --network <name>       Attach the container to an existing network (e.g. one wired to a corp proxy)
  --egress <list>        Restrict outbound traffic to an allowlist (comma-separated hosts, .suffix domains,
                         host.docker.internal, @file, or "none" for airgap); managed proxy network
  -h, --help             Show this help message

Environment variables:
  HARNESS_IMAGE_TAG           Override the Docker image tag (defaults to package version)
  HARNESS_REGISTRY            Override the container registry (defaults to ghcr.io/boldblackai/harness)
  HARNESS_CONTAINER_RUNTIME   Container runtime: auto (default; prefers Apple container on macOS), docker, apple (deprecated)
  HARNESS_EGRESS_SUBNET       Override the egress network subnet pool (IPv4 CIDR, default 192.0.2.0/24 split into /29s)
  XDG_DATA_HOME              Override the base directory for persistence data (defaults to ~/.local/share)
  XDG_CACHE_HOME             Override the base directory for cosign cache (defaults to ~/.cache)

Persistence data is stored at $XDG_DATA_HOME/harness/<project>/<agent>/.

You can also pipe text to harness as an implied -p:
  echo "write me a fizzbuzz in Go" | harness
`;

const workspace = process.cwd();
const REGISTRY = process.env.HARNESS_REGISTRY ?? "ghcr.io/boldblackai/harness";
const VERSION: string = require("../package.json").version;
const IMAGE_TAG = process.env.HARNESS_IMAGE_TAG ?? VERSION;

function normalizeCwd(cwd: string): string {
  const home = os.homedir();
  let normalized = cwd;
  if (normalized.startsWith(home)) {
    normalized = normalized.slice(home.length);
  }
  normalized = normalized.replace(/\//g, "_");
  if (normalized === "") {
    normalized = "_home";
  }
  return normalized;
}

function xdgDataDir(): string {
  return (
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  );
}

function getImage(agent: string): string {
  const tag = agent === "pi" ? IMAGE_TAG : `${agent}-${IMAGE_TAG}`;
  return `${REGISTRY}:${tag}`;
}

const MINIMIST_OPTS = {
  boolean: ["help", "h", "ephemeral", "local", "mount-entire-home"],
  string: [
    "env-file",
    "e",
    "file",
    "f",
    "prompt",
    "p",
    "model",
    "m",
    "agent",
    "a",
    "volumes",
    "port",
    "network",
    "egress",
  ],
  alias: {
    e: "env-file",
    f: "file",
    p: "prompt",
    m: "model",
    h: "help",
    a: "agent",
    v: "volumes",
  },
};

// Translate pi's short context-files flag (-nc) to its long form before
// minimist, which would otherwise split -nc into clustered -n -c flags.
const rawArgs = process.argv
  .slice(2)
  .map((a) => (a === "-nc" ? "--no-context-files" : a));
const argv = minimist<Args>(rawArgs, MINIMIST_OPTS);

// Warn on unrecognized flags
{
  const knownKeys = new Set([
    "_", // minimist internal positional args
    ...MINIMIST_OPTS.boolean,
    ...MINIMIST_OPTS.string,
    ...Object.keys(MINIMIST_OPTS.alias),
    ...Object.values(MINIMIST_OPTS.alias),
    "verify", // --no-verify sets verify=false
    "skills", // --no-skills sets skills=false
    "context-files", // --no-context-files / -nc sets context-files=false
    "local",
  ]);
  const unknown = Object.keys(argv).filter((k) => !knownKeys.has(k));
  if (unknown.length > 0) {
    process.stderr.write(
      `warning: unrecognized flag(s): ${unknown.map((k) => `--${k}`).join(", ")}\n`,
    );
  }
}

if (argv.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const noVerify = argv.verify === false;
const noSkills = argv.skills === false;
const noContextFiles = argv["context-files"] === false;
const mountEntireHome = argv["mount-entire-home"] === true;
const localMode = argv.local;
const envFilePaths: string[] = Array.isArray(argv["env-file"])
  ? argv["env-file"]
  : argv["env-file"]
    ? [argv["env-file"]]
    : [];
const fileArg = argv.file || null;
const promptArg = argv.prompt || null;
const modelArg = argv.model || null;
const effectiveEphemeral =
  argv.ephemeral || promptArg !== null || !process.stdin.isTTY;

const agentName: AgentName = (() => {
  const name = argv.agent ?? "pi";
  if (!isAgentName(name)) {
    console.error(
      `harness: unknown agent: "${name}". Available: ${Object.keys(ADAPTERS).join(", ")}`,
    );
    process.exit(1);
  }
  return name;
})();

for (const ep of envFilePaths) {
  if (!fs.existsSync(ep)) {
    console.error(`harness: env file not found: ${ep}`);
    process.exit(1);
  }
}

if (fileArg && !fs.existsSync(fileArg)) {
  console.error(`harness: file not found: ${fileArg}`);
  process.exit(1);
}

if (fileArg && fs.statSync(fileArg).isDirectory()) {
  console.error(`harness: --file requires a file, not a directory: ${fileArg}`);
  process.exit(1);
}

// Guard against accidentally mounting the entire home directory as the
// workspace. Running from $HOME mounts all dotfiles/credentials into the
// container and gives the agent a noisy, unfocused workspace. Only relevant
// when the cwd is what gets mounted (not --file mode). --mount-entire-home
// is the explicit opt-in for the rare case where this is intended.
if (!fileArg && !mountEntireHome) {
  const resolvedCwd = fs.realpathSync(workspace);
  const resolvedHome = fs.realpathSync(os.homedir());
  if (resolvedCwd === resolvedHome) {
    console.error(
      `harness: refusing to run from your home directory (${resolvedHome}).\nThis would mount your entire home into the container, exposing dotfiles and credentials.\nPass --mount-entire-home to proceed, or cd into a project directory first.`,
    );
    process.exit(1);
  }
}

const volumeArgList: string[] = Array.isArray(argv.volumes)
  ? argv.volumes
  : argv.volumes
    ? [argv.volumes]
    : [];
for (const spec of volumeArgList) {
  const parts = spec.split(":");
  if (parts.length < 2) {
    console.error(
      `harness: invalid volume spec "${spec}" (expected host:container[:opts])`,
    );
    process.exit(1);
  }
  if (parts[0] && !fs.existsSync(parts[0])) {
    console.error(`harness: volume source path does not exist: ${parts[0]}`);
    process.exit(1);
  }
}

// Publish specs use the shared docker/apple-container syntax
// [host-ip:]host-port:container-port[/protocol]. Validate up front so a
// typo fails fast with a clear message instead of an opaque runtime error
// after image verification/pulling.
const PORT_SPEC_REGEXP =
  /^(?:(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\]):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp|sctp))?$/;

function isValidPortSpec(spec: string): boolean {
  const match = spec.match(PORT_SPEC_REGEXP);
  if (!match) {
    return false;
  }
  const portInRange = (p: string) => {
    const n = Number.parseInt(p, 10);
    return n >= 1 && n <= 65535;
  };
  return portInRange(match[1]) && portInRange(match[2]);
}

const portArgList: string[] = Array.isArray(argv.port)
  ? argv.port
  : argv.port
    ? [argv.port]
    : [];
for (const spec of portArgList) {
  if (!isValidPortSpec(spec)) {
    console.error(
      `harness: invalid port spec "${spec}" (expected [host-ip:]host-port:container-port[/protocol], e.g. 8080:3000)`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Egress control (rfcs/2026-10-08_egress_allowlist.md), Tier 1: pass an
// existing container network through to the runtime. Brings your own
// topology (e.g. a network wired to an existing corp proxy). Strictly
// opt-in; without the flag the argv is unchanged.
// ---------------------------------------------------------------------------

const networkArg: string | null = (() => {
  const flag = argv.network ?? null;
  if (flag !== null && flag.trim() === "") {
    console.error("harness: --network requires a non-empty network name");
    process.exit(1);
  }
  return flag;
})();

if (networkArg === "host") {
  console.error(
    "harness: WARNING: --network host removes network isolation between the container and the host.",
  );
}

// ---------------------------------------------------------------------------
// Egress control Tier 2: harness-managed allowlisting (per-run --internal
// network + squid egress gateway). All helpers are pure/testable; lifecycle
// side effects happen in run() below. Without --egress nothing here runs.
// ---------------------------------------------------------------------------

/** One parsed --egress allowlist entry. */
interface EgressEntry {
  /** Exact hostname, suffix domain (leading dot/star stripped), or IP literal. */
  host: string;
  /** True for `.domain` / `*.domain` suffix entries. */
  suffix: boolean;
  /** host.docker.internal[:port] — direct connection, never proxied. */
  hostLocal: boolean;
  /** Advisory in v1 (only meaningful for host-local entries). */
  port: number | null;
}

/** Parsed representation of the whole --egress value. */
interface EgressAllowlist {
  entries: EgressEntry[];
  /** Hostnames/suffixes that must be reachable through the gateway. */
  proxied: EgressEntry[];
  /** Directly reachable host destinations (subset of entries). */
  hostLocal: EgressEntry[];
  /** True for `none` or an empty-after-parsing allowlist (local-only mode: no gateway). */
  airgap: boolean;
}

const HOST_LOCAL_NAME = "host.docker.internal";

function fail(message: string): never {
  console.error(`harness: ${message}`);
  process.exit(1);
}

/**
 * Like fail(), but for errors raised inside egress bring-up after the
 * managed network exists: the network must be removed before exiting, or
 * it is orphaned until the next --egress run's stale sweep.
 */
function failWithNetworkCleanup(message: string, network: string): never {
  console.error(`harness: ${message}`);
  try {
    execFileSync("docker", ["network", "rm", network], {
      stdio: "ignore",
      timeout: 10000,
    });
  } catch {
    // best-effort; the stale sweep catches survivors
  }
  process.exit(1);
}

/**
 * Parse a raw --egress entry into its typed form, or fail with RFC-cited
 * error copy. Grammar: `host`, `.domain`/`*.domain` (suffix),
 * `host.docker.internal[:port]` (host-local, advisory port), `host:port`
 * (rejected in v1, deferred raw-TCP extension).
 */
function parseEgressEntry(raw: string): EgressEntry {
  const entry = raw.trim();
  if (entry === "") {
    fail("--egress entry is empty.");
  }
  const portMatch = entry.match(/^(.*):(\d+)$/);
  const hasPort = portMatch !== null;
  const body = hasPort ? portMatch[1] : entry;
  const port = hasPort ? Number.parseInt(portMatch[2], 10) : null;
  if (hasPort && (port === null || port < 1 || port > 65535)) {
    fail(`--egress entry "${entry}" has an invalid port.`);
  }
  const hostLocal = body === HOST_LOCAL_NAME;
  if (hasPort && !hostLocal) {
    fail(
      `--egress entry "${entry}": non-443 ports are not supported in v1 (HTTPS CONNECT proxying only). Host and suffix entries default to port 443; the raw-TCP extension is deferred (see rfcs/2026-10-08_egress_allowlist.md).`,
    );
  }
  let host = body;
  let suffix = false;
  if (host.startsWith("*.") && host.length > 2) {
    suffix = true;
    host = host.slice(2);
  } else if (host.startsWith(".") && host.length > 1) {
    suffix = true;
    host = host.slice(1);
  }
  if (host === "" || host === "." || host.includes("/") || host.includes(" ")) {
    fail(`--egress entry "${entry}" is not a valid hostname.`);
  }
  return { host, suffix, hostLocal, port };
}

/**
 * Parse the full --egress value: comma-separated entries, `@file` form, or
 * the literal `none` (airgap). Empty/whitespace items between commas are
 * tolerated; a file whose entries are all comments selects airgap.
 */
function parseEgressValue(value: string): EgressAllowlist {
  let rawEntries: string[];
  const v = value.trim();
  if (v === "") {
    return fail(
      '--egress requires a value: a comma-separated list, "@file", or "none" (airgap).',
    );
  }
  if (v === "none") {
    rawEntries = [];
  } else if (v.startsWith("@")) {
    const file = v.slice(1);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return fail(`--egress: cannot read allowlist file ${file}`);
    }
    rawEntries = content
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l !== "");
  } else {
    rawEntries = v.split(",").map((e) => e.trim());
  }
  const seen = new Set<string>();
  const entries: EgressEntry[] = [];
  for (const raw of rawEntries) {
    if (raw === "") continue;
    const parsed = parseEgressEntry(raw);
    const key = `${parsed.suffix ? "." : ""}${parsed.host}${
      parsed.port !== null ? `:${parsed.port}` : ""
    }`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(parsed);
  }
  const hostLocal = entries.filter((e) => e.hostLocal);
  const proxied = entries.filter((e) => !e.hostLocal);
  // Local-only (formerly "airgap") means literally nothing allowlisted — the
  // `none` literal or a file whose entries are all comments. A host-local-only
  // list is NOT airgap: it keeps the internal network (so the host, and only
  // the host, is reachable) but starts no gateway. Collapsing such lists into
  // airgap made `--egress "host.docker.internal:1234"` useless (reported in
  // the PR review) — and it's the natural pairing with `--local`.
  return { entries, proxied, hostLocal, airgap: entries.length === 0 };
}

// Subnet allocation from the documentation pool 192.0.2.0/24 broken into
// /29s (32 subnets, gateway .1, egress gateway static .2). Overridable via
// HARNESS_EGRESS_SUBNET=<cidr>. Collisions with live docker networks are
// detected before create; a fully exhausted pool is a hard error.
const EGRESS_SUBNET_POOL = "192.0.2.0/24";
const EGRESS_SUBNET_SIZE = 29; // 6 usable hosts each, plenty for one run

/** List docker networks as [{name, subnet}] (best-effort; [] on failure). */
function dockerNetworks(): { name: string; subnet: string }[] {
  try {
    const out = execFileSync(
      "docker",
      ["network", "ls", "--format", "{{.Name}}"],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    )
      .toString()
      .trim();
    if (out === "") return [];
    return out
      .split("\n")
      .map((name) => ({ name, subnet: dockerNetworkSubnet(name) }));
  } catch {
    return [];
  }
}

/** Inspect one network's IPv4 subnet (empty string on failure). */
function dockerNetworkSubnet(name: string): string {
  try {
    const out = execFileSync(
      "docker",
      [
        "network",
        "inspect",
        "--format",
        "{{if .IPAM.Config}}{{(index .IPAM.Config 0).Subnet}}{{end}}",
        name,
      ],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    )
      .toString()
      .trim();
    return out;
  } catch {
    return "";
  }
}

function cidrToIpInt(cidr: string): number | null {
  const m = cidr.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/,
  );
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return null;
  return (
    (((octets[0] << 24) >>> 0) +
      (octets[1] << 16) +
      (octets[2] << 8) +
      octets[3]) >>>
    0
  );
}

function ipIntToString(int: number): string {
  return [
    (int >>> 24) & 0xff,
    (int >>> 16) & 0xff,
    (int >>> 8) & 0xff,
    int & 0xff,
  ].join(".");
}

/**
 * Pick a free /29 from the pool, skipping subnets already in use by any
 * docker network. Returns e.g. "192.0.2.8/29" or exits with an error.
 */
function allocateEgressSubnet(): string {
  const custom = process.env.HARNESS_EGRESS_SUBNET;
  if (custom) {
    if (cidrToIpInt(custom) === null || !custom.includes("/")) {
      fail(`HARNESS_EGRESS_SUBNET must be an IPv4 CIDR (got "${custom}").`);
    }
    return custom;
  }
  const poolBase = cidrToIpInt(EGRESS_SUBNET_POOL);
  if (poolBase === null) return fail("internal: bad egress subnet pool");
  const used = new Set(
    dockerNetworks()
      .map((n) => n.subnet)
      .filter(Boolean),
  );
  // 32 /29s in a /24
  for (let i = 0; i < 32; i++) {
    const candidate = (poolBase + i * 8) >>> 0;
    const cidr = `${ipIntToString(candidate)}/${EGRESS_SUBNET_SIZE}`;
    if (!used.has(cidr)) return cidr;
  }
  return fail(
    `--egress: no free subnet in the ${EGRESS_SUBNET_POOL} pool; set HARNESS_EGRESS_SUBNET to a free private /29.`,
  );
}

/**
 * Generate squid.conf from the allowlist, deny-by-default. Only called when
 * proxied entries exist (local-only mode starts no gateway).
 *
 * Exact hosts and dot-suffixed domains go in SEPARATE dstdomain ACLs: squid
 * 6.x rejects a single ACL mixing bare hosts with `.suffix` entries
 * ("Bungled ... acl" — verified live against the pinned 6.13 image; the
 * RFC's flagship example list is exactly such a mixed list). ACLs must
 * precede the http_access lines that reference them (squid parses
 * sequentially).
 * All writable paths point at /tmp: the gateway runs as the unprivileged
 * `proxy` user, and Debian squid's defaults (/run/squid.pid, /var/log/squid)
 * are root-owned — a fatal startup error without this.
 */
function generateSquidConfig(allowlist: EgressAllowlist): string {
  const exact = allowlist.proxied.filter((e) => !e.suffix).map((e) => e.host);
  const suffix = allowlist.proxied
    .filter((e) => e.suffix)
    .map((e) => `.${e.host}`);
  return [
    "# generated by harness --egress; do not edit",
    "http_port 3128",
    "pid_filename /tmp/squid.pid",
    "cache deny all",
    "coredump_dir /tmp",
    ...(exact.length ? [`acl exact-domains dstdomain ${exact.join(" ")}`] : []),
    ...(suffix.length
      ? [`acl suffix-domains dstdomain ${suffix.join(" ")}`]
      : []),
    ...(exact.length ? ["http_access allow exact-domains"] : []),
    ...(suffix.length ? ["http_access allow suffix-domains"] : []),
    "http_access deny all",
    "access_log stdio:stderr",
    "cache_log stdio:stderr",
    "",
  ].join("\n");
}

/** Parse `--egress` CLI value; null when the flag is absent. */
const egressArg: string | null = argv.egress ?? null;

let egressAllowlist: EgressAllowlist | null = null;
if (egressArg !== null) {
  if (networkArg !== null) {
    fail(
      "--egress and --network are mutually exclusive (the managed network is the point).",
    );
  }
  egressAllowlist = parseEgressValue(egressArg);
}

// ---------------------------------------------------------------------------
// Egress lifecycle helpers (docker-only; the apple runtime fails closed).
// All output is captured/discarded on stdout so e2e shim assertions on the
// final `run` argv stay clean; runtime errors surface on stderr.
// ---------------------------------------------------------------------------

function dockerSync(
  args: string[],
  what: string,
  timeoutMs = 30000,
  cleanupNetwork?: string,
): string {
  try {
    return execFileSync("docker", args, {
      stdio: ["ignore", "pipe", "inherit"],
      timeout: timeoutMs,
    }).toString();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const message = `--egress: ${what} failed: ${msg}`;
    if (cleanupNetwork) {
      failWithNetworkCleanup(message, cleanupNetwork);
    }
    fail(message);
  }
}

/**
 * Remove harness-egress-* networks left behind by crashed runs.
 *
 * A crashed run (e.g. SIGTERM during the agent run) leaves its detached
 * gateway container attached, so the network is never empty and the
 * empty-only check would never reclaim it — while its /29 blocks the pool
 * ("Pool overlaps") for every later run. Staleness test: a live run's
 * network holds the gateway PLUS the agent container; a crashed run's holds
 * only the gateway (the agent ran with --rm). Networks whose only container
 * is a harness-egress-gw-* are stale: kill the gateway, then the network.
 * (Best-effort: a concurrent run mid-bring-up — gateway attached, agent not
 * yet started — is indistinguishable and may be swept; runs are expected to
 * be sequential, matching the empty-network sweep's existing race.)
 */
function sweepStaleEgressNetworks(): void {
  for (const net of dockerNetworks()) {
    if (!net.name.startsWith("harness-egress-")) continue;
    try {
      const out = execFileSync(
        "docker",
        [
          "network",
          "inspect",
          "--format",
          "{{range .Containers}}{{.Name}} {{end}}",
          net.name,
        ],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      )
        .toString()
        .trim();
      const members = out === "" ? [] : out.trim().split(/\s+/);
      const stale = members.every((m) => m.startsWith("harness-egress-gw-"));
      if (!stale) continue;
      for (const gw of members) {
        try {
          execFileSync("docker", ["rm", "-f", gw], {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 15000,
          });
          console.error(`harness: swept stale egress gateway ${gw}`);
        } catch {
          // best-effort; an un-removable gateway just leaves the network
        }
      }
      execFileSync("docker", ["network", "rm", net.name], {
        stdio: ["ignore", "pipe", "inherit"],
        timeout: 5000,
      });
      console.error(`harness: swept stale egress network ${net.name}`);
    } catch {
      // best-effort; a busy/in-use network survives
    }
  }
}

/**
 * Wait until the gateway's squid is up (pid file exists and responds to
 * `squid -k check`). If the container exits first, dump its logs and fail —
 * a dead gateway must never be treated as "slow to start".
 */
function waitForGateway(container: string): void {
  for (let i = 0; i < 20; i++) {
    let running = "true";
    try {
      running = execFileSync(
        "docker",
        ["inspect", "--format", "{{.State.Running}}", container],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      )
        .toString()
        .trim();
    } catch {
      // inspect races with --rm removal; treat as not-yet-running
    }
    if (running === "false") {
      let logs = "";
      try {
        logs = execFileSync("docker", ["logs", "--tail", "40", container], {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        }).toString();
      } catch {
        // container already reaped by --rm
      }
      fail(`--egress: egress gateway exited during startup.\n${logs.trim()}`);
    }
    try {
      execFileSync("docker", ["exec", container, "squid", "-k", "check"], {
        stdio: "ignore",
        timeout: 5000,
      });
      return;
    } catch {
      syncSleep(250);
    }
  }
  console.error(
    "harness: WARNING: egress gateway did not confirm readiness in 5s; continuing.",
  );
}

/** Synchronous sleep (Atomics.wait on a shared buffer). */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface EgressRuntimeState {
  network: string;
  gatewayContainer: string | null;
  gatewayIp: string | null;
  envArgs: string[];
  addHostArgs: string[];
  cleanup: () => void;
}

/**
 * Bring up the managed egress topology: --internal network, gateway (unless
 * airgap), proxy env. Returns state the run() flow merges into RunInput and
 * a cleanup closure to invoke after the agent container exits.
 */
async function startEgress(
  runtime: ContainerRuntime,
  allowlist: EgressAllowlist,
  noVerifyFlag: boolean,
): Promise<EgressRuntimeState> {
  const runId = randomUUID().slice(0, 8);
  const network = `harness-egress-${runId}`;
  const subnet = allocateEgressSubnet();
  const subnetBase = cidrToIpInt(subnet);
  if (subnetBase === null) fail(`--egress: bad subnet "${subnet}".`);
  const gatewayIp = ipIntToString((subnetBase + 2) >>> 0);

  sweepStaleEgressNetworks();
  dockerSync(
    ["network", "create", "--internal", "--subnet", subnet, network],
    `creating egress network (${subnet})`,
  );

  return bringUpEgress(
    network,
    runId,
    subnetBase,
    allowlist,
    noVerifyFlag,
    runtime,
  );
}

async function bringUpEgress(
  network: string,
  runId: string,
  subnetBase: number,
  allowlist: EgressAllowlist,
  noVerifyFlag: boolean,
  runtime: ContainerRuntime,
): Promise<EgressRuntimeState> {
  // All failure paths below must go through failWithNetworkCleanup so the
  // network created by startEgress is not orphaned.
  const gatewayIp = ipIntToString((subnetBase + 2) >>> 0);
  const envArgs: string[] = [];
  let gatewayContainer: string | null = null;

  // The gateway exists to proxy outbound destinations — start it only when
  // proxied entries exist. Local-only mode (`none`, or host-local-only lists)
  // has nothing to proxy and runs gateway-free on the internal network.
  if (allowlist.proxied.length > 0) {
    const gatewayImage = `${REGISTRY}:egress-proxy-${IMAGE_TAG}`;
    if (!noVerifyFlag && !process.env.HARNESS_IMAGE_TAG) {
      try {
        await verifyImage(runtime, gatewayImage);
      } catch {
        failWithNetworkCleanup(
          `--egress: gateway image verification failed for ${gatewayImage} (pass --no-verify or build the image locally)`,
          network,
        );
      }
    }
    gatewayContainer = `harness-egress-gw-${runId}`;
    const confFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "harness-egress-")),
      "squid.conf",
    );
    fs.writeFileSync(confFile, generateSquidConfig(allowlist), {
      mode: 0o644,
    });
    dockerSync(
      [
        "run",
        "--rm",
        "-d",
        "--name",
        gatewayContainer,
        "--cap-drop=ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--security-opt",
        `seccomp=${SECCOMP_PROFILE}`,
        "--network",
        network,
        "--ip",
        gatewayIp,
        "-v",
        `${confFile}:/etc/squid/squid.conf:ro`,
        gatewayImage,
      ],
      "starting egress gateway",
      120000,
      network,
    );
    // External leg: the gateway is the only container with a route off-host.
    dockerSync(
      ["network", "connect", "bridge", gatewayContainer],
      "attaching gateway to the default bridge",
      30000,
      network,
    );
    waitForGateway(gatewayContainer);

    const proxyUrl = `http://${gatewayIp}:3128`;
    envArgs.push(
      "-e",
      `HTTPS_PROXY=${proxyUrl}`,
      "-e",
      `HTTP_PROXY=${proxyUrl}`,
      "-e",
      `NO_PROXY=localhost,127.0.0.1,${HOST_LOCAL_NAME}`,
      // Node's fetch/http ignore proxy env vars without this (Node 24+);
      // inert for non-Node agents.
      "-e",
      "NODE_USE_ENV_PROXY=1",
    );
    console.error(
      `harness: egress allowlist active — ${allowlist.proxied.length} destination(s) via gateway ${gatewayIp}`,
    );
  } else {
    envArgs.push("-e", `NO_PROXY=localhost,127.0.0.1,${HOST_LOCAL_NAME}`);
    console.error(
      "harness: egress local-only mode — host reachable, no gateway, no external route",
    );
  }

  // Host reachability from an --internal network. Docker Desktop provides
  // host.docker.internal natively. On Linux engines, host-gateway (the default
  // bridge's gateway) is OFF-SUBNET for the egress network and --internal
  // drops the forward — measured "Network unreachable" (docker 29.9.1).
  // Mapping host.docker.internal to the egress network's OWN gateway (the
  // subnet's .1) works: --internal blocks forwarding off the bridge, not the
  // host's own endpoint on it (measured HTTP 200). Harness reserves .2 for
  // the squid container; .1 is the docker-assigned network gateway = the host.
  const addHostArgs: string[] =
    process.platform === "linux"
      ? [
          "--add-host",
          `${HOST_LOCAL_NAME}:${ipIntToString((subnetBase + 1) >>> 0)}`,
        ]
      : [];

  const gw = gatewayContainer;
  const cleanup = () => {
    if (gw !== null) {
      try {
        execFileSync("docker", ["rm", "-f", gw], {
          stdio: ["ignore", "pipe", "inherit"],
          timeout: 15000,
        });
      } catch {
        // best-effort; --rm cleans up on stop, and the stale sweep catches it
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        execFileSync("docker", ["network", "rm", network], {
          stdio: ["ignore", "pipe", "inherit"],
          timeout: 10000,
        });
        return;
      } catch {
        syncSleep(500); // gateway may still be detaching
      }
    }
  };

  return {
    network,
    gatewayContainer,
    gatewayIp,
    envArgs,
    addHostArgs,
    cleanup,
  };
}

async function run(prompt: string | null): Promise<void> {
  const runtime = selectRuntime();
  runtime.ensureReady();
  const image = getImage(agentName);

  // --egress is docker-only in v1: whether apple/container supports --internal
  // networks and multi-network attach is unverified; fail closed (RFC D5).
  let egress: EgressRuntimeState | null = null;
  if (egressAllowlist !== null) {
    if (!(runtime instanceof DockerRuntime)) {
      fail(
        "--egress is not yet supported under the apple/container runtime " +
          "(--internal networks / multi-network attach unverified); use HARNESS_CONTAINER_RUNTIME=docker.",
      );
    }
    egress = await startEgress(runtime, egressAllowlist, noVerify);
  }

  if (!noVerify) {
    if (process.env.HARNESS_IMAGE_TAG) {
      console.error(
        `harness: HARNESS_IMAGE_TAG is set; skipping cosign verification for ${image}`,
      );
    } else {
      await verifyImage(runtime, image);
    }
  }

  const envFileArgs = envFilePaths.flatMap((f) => [
    "--env-file",
    path.resolve(f),
  ]);

  // Cloud mode: -e without --local signals entrypoints to skip local/defaults
  // and let agents auto-detect providers from env vars in the file.
  const cloudModeEnv =
    envFilePaths.length > 0 && !localMode ? ["-e", "HARNESS_CLOUD_MODE=1"] : [];

  const adapter = ADAPTERS[agentName];
  const adapterOptions = { prompt, model: modelArg, envFilePaths };
  const containerCmd = adapter.buildCommand(adapterOptions);
  const adapterDockerArgs = adapter.extraDockerArgs?.(adapterOptions) ?? [];

  const interactive = process.stdin.isTTY;

  let volumeArgs: string[];
  if (fileArg) {
    const absFile = path.resolve(fileArg);
    const fileName = path.basename(absFile);
    volumeArgs = ["-v", `${absFile}:/workspace/${fileName}`];
  } else {
    volumeArgs = ["-v", `${workspace}:/workspace`];
    if (!effectiveEphemeral) {
      const persistRoot = path.join(
        xdgDataDir(),
        "harness",
        normalizeCwd(workspace),
        agentName,
      );
      // Deprecation warning for old .harness/ directory
      const oldHarnessDir = path.join(workspace, ".harness");
      if (fs.existsSync(oldHarnessDir)) {
        console.error(
          `harness: WARNING: found ${oldHarnessDir}/ — persistence data now lives at ${persistRoot}. To migrate session data, copy the contents of .harness/${agentName}/ to the new location. Otherwise this directory can be safely deleted.`,
        );
      }
      const mounts = adapter.persistMounts?.() ?? [];
      for (const mount of mounts) {
        const hostFullPath = path.join(persistRoot, mount.hostSubpath);
        fs.mkdirSync(hostFullPath, { recursive: true });
        volumeArgs.push("-v", `${hostFullPath}:${mount.containerPath}`);
      }
      // Project-level (agent-independent) XDG config persistence. Tools like
      // jj write to ~/.config; persisting it one level above the per-agent
      // persistRoot lets that config survive across runs and be shared by every
      // agent working in this project. For opencode the more-specific
      // .config/opencode mount above nests inside this one (Docker mounts
      // parents before children), so opencode keeps its own per-agent bucket.
      const xdgConfigPath = path.join(path.dirname(persistRoot), "xdg_config");
      fs.mkdirSync(xdgConfigPath, { recursive: true });
      volumeArgs.push("-v", `${xdgConfigPath}:/home/harness/.config`);
      // Per-agent mise persistence (data: tools/plugins, state: trust settings)
      const miseDataPath = path.join(persistRoot, "mise");
      fs.mkdirSync(miseDataPath, { recursive: true });
      volumeArgs.push("-v", `${miseDataPath}:/home/harness/.local/share/mise`);
      const miseStatePath = path.join(persistRoot, "mise-state");
      fs.mkdirSync(miseStatePath, { recursive: true });
      volumeArgs.push("-v", `${miseStatePath}:/home/harness/.local/state/mise`);
    }
  }

  if (!noSkills) {
    const skillDirs = [
      {
        host: path.resolve(os.homedir(), ".agents", "skills"),
        container: "/home/harness/.agents/skills",
      },
      {
        host: path.resolve(os.homedir(), ".claude", "skills"),
        container: "/home/harness/.claude/skills",
      },
    ];
    for (const sd of skillDirs) {
      if (fs.existsSync(sd.host) && fs.statSync(sd.host).isDirectory()) {
        volumeArgs.push("-v", `${sd.host}:${sd.container}`);
      }
    }
  }

  // Mount the user's global context files into the adapter's context directory
  // so cross-agent rules apply inside the container. Mirrors pi's context-files
  // model (AGENTS.md + CLAUDE.md). Each file is skipped when absent (like skills
  // dirs); --no-context-files / -nc disables all of them.
  if (!noContextFiles) {
    const contextDir = adapter.contextDir?.();
    if (contextDir) {
      const contextFiles = [
        {
          host: path.resolve(os.homedir(), ".agents", "AGENTS.md"),
          name: "AGENTS.md",
        },
        {
          host: path.resolve(os.homedir(), ".claude", "CLAUDE.md"),
          name: "CLAUDE.md",
        },
      ];
      for (const cf of contextFiles) {
        if (fs.existsSync(cf.host) && fs.statSync(cf.host).isFile()) {
          volumeArgs.push("-v", `${cf.host}:${contextDir}/${cf.name}`);
        }
      }
    }
  }

  const userVolumeArgs: string[] = [];
  for (const spec of volumeArgList) {
    userVolumeArgs.push(
      "-v",
      `${path.resolve(spec.split(":")[0])}:${spec.split(":").slice(1).join(":")}`,
    );
  }

  // docker -p and apple/container --publish share the spec syntax, so the
  // flags are runtime-agnostic (unlike caps/tty handling).
  const portArgs: string[] = [];
  for (const spec of portArgList) {
    portArgs.push("-p", spec);
  }

  const args = runtime.runArgs({
    interactive,
    envFileArgs,
    envArgs: [
      ...cloudModeEnv,
      ...adapterDockerArgs,
      ...(egress?.envArgs ?? []),
    ],
    volumeArgs,
    userVolumeArgs,
    portArgs,
    network: egress ? egress.network : networkArg,
    addHostArgs: egress?.addHostArgs ?? [],
    workdir: "/workspace",
    image,
    containerCmd,
  });

  const child = spawn(runtime.binary(), args, { stdio: "inherit" });
  child.on("exit", (code) => {
    egress?.cleanup();
    process.exit(code ?? 1);
  });
}

if (!process.stdin.isTTY && promptArg === null) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
  });
  process.stdin.on("end", () =>
    run(input.trim() ? input : null).catch(() => process.exit(1)),
  );
} else {
  run(promptArg).catch(() => process.exit(1));
}
