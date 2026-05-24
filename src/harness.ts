#!/usr/bin/env node

import { execFile, execFileSync, spawn } from "node:child_process";
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
  // minimist --no- prefix: --no-verify / --no-skills set these to false; NOT in boolean[] to avoid double-negation
  verify?: boolean;
  ephemeral: boolean;
  skills?: boolean;
  "env-file"?: string;
  e?: string;
  file?: string;
  f?: string;
  prompt?: string;
  p?: string;
  model?: string;
  m?: string;
  agent?: string;
  a?: string;
  volumes?: string[];
}

interface AgentOptions {
  prompt: string | null;
  model: string | null;
  envFilePath: string | null;
}

interface PersistMount {
  hostSubpath: string;
  containerPath: string;
}

interface AgentAdapter {
  buildCommand(options: AgentOptions): string[];
  extraDockerArgs?(options: AgentOptions): string[];
  persistMounts?(): PersistMount[];
}

class PiAdapter implements AgentAdapter {
  buildCommand({ prompt, model, envFilePath }: AgentOptions): string[] {
    // In local mode (no env file), pass --provider ollama so pi routes
    // the model to the local LM Studio provider. Without this, model names
    // containing slashes (e.g. HuggingFace IDs like "qwen/qwen3.5-9b") are
    // misinterpreted as provider/model format, causing pi to silently ignore
    // --model and fall back to a default that may require cloud credentials.
    const providerArgs = !envFilePath && model ? ["--provider", "ollama"] : [];
    const modelArgs = model ? ["--model", model] : [];
    if (prompt !== null) {
      return ["pi", "-p", prompt, ...providerArgs, ...modelArgs];
    }
    return ["pi", ...providerArgs, ...modelArgs];
  }

  persistMounts(): PersistMount[] {
    return [{ hostSubpath: "", containerPath: "/home/harness/.pi/agent" }];
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
}

class HermesAdapter implements AgentAdapter {
  buildCommand({ prompt, model }: AgentOptions): string[] {
    const args = ["hermes", "chat"];
    if (model) args.push("-m", model);
    if (prompt !== null) args.push("-q", prompt);
    return args;
  }

  persistMounts(): PersistMount[] {
    return [
      { hostSubpath: "local", containerPath: "/home/harness/.hermes-local" },
      {
        hostSubpath: "openrouter",
        containerPath: "/home/harness/.hermes-openrouter",
      },
    ];
  }
}

const IDENTITY_REGEXP =
  "https://github.com/capotej/harness/.github/workflows/docker.yml@refs/tags/";
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

function inspectLocalImage(image: string): {
  exists: boolean;
  digest: string | null;
} {
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

async function verifyImage(image: string): Promise<void> {
  let { exists, digest: digestRef } = inspectLocalImage(image);
  const cache = readCache();

  if (digestRef && cache.verified[digestRef]) {
    return;
  }

  if (exists && !digestRef) {
    console.error(
      `harness: refusing to verify ${image}: image exists locally but has no registry digest (locally-built?).`,
    );
    console.error(
      "harness: verifying the tag would check registry bytes, not the local image docker would run.",
    );
    console.error(
      "harness: use --no-verify, or set HARNESS_IMAGE_TAG for an implicit skip.",
    );
    process.exit(1);
  }

  if (!digestRef) {
    console.error(`harness: pulling ${image} for verification...`);
    try {
      execFileSync("docker", ["pull", image], {
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 600000,
      });
    } catch {
      console.error(`harness: docker pull failed for ${image}`);
      process.exit(1);
    }
    digestRef = inspectLocalImage(image).digest;
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
  -e, --env-file <file>  Load environment variables from a file into the container
  -f, --file <file>      Mount a single file into the container instead of the current directory
  -m, --model <model>    Override the model used by the agent
  -a, --agent <name>     Select the coding agent adapter: pi, opencode, hermes (default: pi)
  -v, --volumes <spec>   Additional volume mount (host:container[:opts]); may be repeated
  --no-verify            Skip cosign image signature and provenance verification
  --no-skills            Disable mounting user skills directories (~/.agents/skills, ~/.claude/skills)
  --ephemeral            Disable session persistence (implied by -p and piped stdin)
  -h, --help             Show this help message

Environment variables:
  HARNESS_IMAGE_TAG      Override the Docker image tag (defaults to package version)
  XDG_DATA_HOME         Override the base directory for persistence data (defaults to ~/.local/share)
  XDG_CACHE_HOME        Override the base directory for cosign cache (defaults to ~/.cache)

Persistence data is stored at $XDG_DATA_HOME/harness/<project>/<agent>/.

You can also pipe text to harness as an implied -p:
  echo "write me a fizzbuzz in Go" | harness
`;

const workspace = process.cwd();
const REGISTRY = "ghcr.io/capotej/harness";
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
  boolean: ["help", "h", "ephemeral"],
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

const argv = minimist<Args>(process.argv.slice(2), MINIMIST_OPTS);

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
const envFilePath = argv["env-file"] || null;
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

if (envFilePath && !fs.existsSync(envFilePath)) {
  console.error(`harness: env file not found: ${envFilePath}`);
  process.exit(1);
}

if (fileArg && !fs.existsSync(fileArg)) {
  console.error(`harness: file not found: ${fileArg}`);
  process.exit(1);
}

if (fileArg && fs.statSync(fileArg).isDirectory()) {
  console.error(`harness: --file requires a file, not a directory: ${fileArg}`);
  process.exit(1);
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

async function run(prompt: string | null): Promise<void> {
  const image = getImage(agentName);

  if (!noVerify) {
    if (process.env.HARNESS_IMAGE_TAG) {
      console.error(
        `harness: HARNESS_IMAGE_TAG is set; skipping cosign verification for ${image}`,
      );
    } else {
      await verifyImage(image);
    }
  }

  const envFileArgs = envFilePath
    ? ["--env-file", path.resolve(envFilePath)]
    : [];

  const adapter = ADAPTERS[agentName];
  const adapterOptions = { prompt, model: modelArg, envFilePath };
  const containerCmd = adapter.buildCommand(adapterOptions);
  const adapterDockerArgs = adapter.extraDockerArgs?.(adapterOptions) ?? [];

  const interactive = process.stdin.isTTY;
  const ttyFlags = interactive ? ["-it"] : ["-i"];

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
          `harness: WARNING: found ${oldHarnessDir}/ — persistence data now lives at ${path.join(xdgDataDir(), "harness", normalizeCwd(workspace), "<agent>")}. To migrate session data, copy the contents of .harness/<agent>/ to the new location. Otherwise this directory can be safely deleted.`,
        );
      }
      const mounts = adapter.persistMounts?.() ?? [];
      for (const mount of mounts) {
        const hostFullPath = path.join(persistRoot, mount.hostSubpath);
        fs.mkdirSync(hostFullPath, { recursive: true });
        volumeArgs.push("-v", `${hostFullPath}:${mount.containerPath}`);
      }
      // Per-agent mise persistence
      const miseHostPath = path.join(persistRoot, "mise");
      fs.mkdirSync(miseHostPath, { recursive: true });
      volumeArgs.push("-v", `${miseHostPath}:/home/harness/.local/share/mise`);
      volumeArgs.push("-e", "MISE_DATA_DIR=/home/harness/.local/share/mise");
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

  const userVolumeArgs: string[] = [];
  for (const spec of volumeArgList) {
    userVolumeArgs.push(
      "-v",
      `${path.resolve(spec.split(":")[0])}:${spec.split(":").slice(1).join(":")}`,
    );
  }

  const args = [
    "run",
    "--rm",
    ...ttyFlags,
    "--cap-drop=ALL",
    "--cap-add=NET_RAW",
    "--security-opt",
    "no-new-privileges:true",
    "--security-opt",
    `seccomp=${SECCOMP_PROFILE}`,
    ...envFileArgs,
    ...adapterDockerArgs,
    ...volumeArgs,
    ...userVolumeArgs,
    "-w",
    "/workspace",
    image,
    ...containerCmd,
  ];

  const docker = spawn("docker", args, { stdio: "inherit" });
  docker.on("exit", (code) => process.exit(code ?? 1));
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
