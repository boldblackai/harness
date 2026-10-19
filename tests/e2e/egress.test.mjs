// Tier 2 egress-control tests: --egress managed allowlisting
// (rfcs/2026-10-08_egress_allowlist.md).
//
// The default docker shim only surfaces the final inherited-stdio `run`;
// the egress lifecycle (network create/rm, gateway run/exec) uses captured
// stdio, so those calls are invisible on stdout. This file swaps in a
// recording shim that appends every invocation to a log file and answers
// exit 0 — letting tests assert the full lifecycle sequence.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  ENV_FILE,
  SHIM_DIR,
  WORK_DIR,
  runCli,
  setupIfNecessary,
} from "./helpers.mjs";

setupIfNecessary();

/** Install a recording docker shim; returns a reader for the call log. */
function withRecordingShim() {
  const log = path.join(SHIM_DIR, "egress-calls.log");
  fs.rmSync(log, { force: true });
  const shim = path.join(SHIM_DIR, "docker");
  fs.writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      `echo "docker $*" >> "${log}"`,
      'echo "DOCKER_INVOKED $*"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    calls() {
      return fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("docker "))
        .map((l) => l.slice("docker ".length));
    },
  };
}

/** The final agent-container `run` (the one with the adapter command). */
function agentRun(calls) {
  const runs = calls.filter(
    (c) => c.startsWith("run ") && !c.includes("harness-egress-gw-"),
  );
  return runs[runs.length - 1];
}

test("--egress none (local-only): internal network, no gateway, NO_PROXY only", () => {
  const rec = withRecordingShim();
  const r = runCli(["-p", "noop", "--egress", "none"]);
  assert.equal(r.status, 0, r.stderr);
  const calls = rec.calls();
  const create = calls.find((c) => c.startsWith("network create"));
  assert.ok(create, `expected network create in: ${calls.join(" | ")}`);
  assert.match(create, /--internal/);
  assert.match(create, /--subnet 192\.0\.2\.\d+\/29/);
  assert.match(create, /harness-egress-[0-9a-f]+/);
  assert.ok(
    !calls.some(
      (c) => c.startsWith("run ") && c.includes("harness-egress-gw-"),
    ),
    "local-only must not start a gateway",
  );
  const run = agentRun(calls);
  assert.ok(run, "expected an agent run");
  assert.match(run, /--network harness-egress-[0-9a-f]+/);
  assert.match(run, /NO_PROXY=localhost,127\.0\.0\.1,host\.docker\.internal/);
  assert.ok(
    !run.includes("HTTPS_PROXY"),
    "local-only must not set HTTPS_PROXY",
  );
  assert.ok(
    calls.some((c) => /^network rm harness-egress-/.test(c)),
    "expected network rm cleanup",
  );
  assert.match(r.stderr, /local-only mode/);
});

test("--egress with host-local-only list: same local-only shape (no gateway)", () => {
  const rec = withRecordingShim();
  const r = runCli(["-p", "noop", "--egress", "host.docker.internal:1234"]);
  assert.equal(r.status, 0, r.stderr);
  const calls = rec.calls();
  assert.ok(
    !calls.some(
      (c) => c.startsWith("run ") && c.includes("harness-egress-gw-"),
    ),
    "host-local-only list must not start a gateway",
  );
  const run = agentRun(calls);
  assert.ok(run, "expected an agent run");
  assert.match(run, /--network harness-egress-[0-9a-f]+/);
  assert.match(run, /NO_PROXY=localhost,127\.0\.0\.1,host\.docker\.internal/);
  assert.ok(!run.includes("HTTPS_PROXY"));
  assert.match(r.stderr, /local-only mode/);
});

test("--egress with hosts: gateway started with hardened flags, proxy env injected after --env-file", () => {
  const rec = withRecordingShim();
  const r = runCli([
    "-p",
    "noop",
    "-e",
    ENV_FILE,
    "--egress",
    "api.anthropic.com,.amazonaws.com,host.docker.internal",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const calls = rec.calls();
  const gw = calls.find(
    (c) => c.startsWith("run ") && c.includes("harness-egress-gw-"),
  );
  assert.ok(gw, `expected gateway run in: ${calls.join(" | ")}`);
  assert.match(gw, /--rm -d/);
  assert.match(gw, /--cap-drop=ALL/);
  assert.match(gw, /no-new-privileges:true/);
  assert.match(gw, /seccomp=/);
  assert.match(gw, /--network harness-egress-[0-9a-f]+/);
  assert.match(gw, /--ip 192\.0\.2\.\d+/);
  assert.match(gw, /squid\.conf:ro/);
  assert.match(gw, /egress-proxy-test-tag/);
  // External leg: gateway attached to the default bridge
  const gwId = gw.match(/harness-egress-gw-([0-9a-f]+)/)?.[1];
  assert.ok(
    calls.some(
      (c) =>
        c === `network connect bridge harness-egress-gw-${gwId}` ||
        (c.startsWith("network connect ") &&
          c.includes(`harness-egress-gw-${gwId}`) &&
          c.endsWith("bridge")),
    ),
    `expected gateway attach to default bridge in: ${calls.join(" | ")}`,
  );
  // Agent run: proxy env present, positioned AFTER --env-file (last wins)
  const run = agentRun(calls);
  assert.ok(run, "expected an agent run");
  assert.match(run, /--network harness-egress-[0-9a-f]+/);
  assert.match(run, /HTTPS_PROXY=http:\/\/192\.0\.2\.\d+:3128/);
  assert.match(run, /HTTP_PROXY=http:\/\/192\.0\.2\.\d+:3128/);
  assert.match(run, /NODE_USE_ENV_PROXY=1/);
  assert.match(run, /NO_PROXY=localhost,127\.0\.0\.1,host\.docker\.internal/);
  const envFileIdx = run.indexOf("--env-file");
  const proxyIdx = run.indexOf("HTTPS_PROXY=");
  assert.ok(
    envFileIdx > -1 && proxyIdx > envFileIdx,
    "proxy env must come after --env-file",
  );
  assert.match(r.stderr, /egress allowlist active/);
});

test("--egress @file: entries parsed, comments stripped, host.docker.internal:port allowed", () => {
  const rec = withRecordingShim();
  const allowFile = path.join(WORK_DIR, "allow.txt");
  fs.writeFileSync(
    allowFile,
    "# comment\napi.openai.com\n\n  .googleapis.com  \nhost.docker.internal:8080\n",
  );
  const r = runCli(["-p", "noop", "--egress", `@${allowFile}`]);
  assert.equal(r.status, 0, r.stderr);
  const calls = rec.calls();
  assert.ok(
    calls.some((c) => c.startsWith("network create")),
    "expected network create",
  );
  const run = agentRun(calls);
  assert.match(run, /HTTPS_PROXY=/);
});

test("--egress rejects non-443 port entries (v1)", () => {
  const r = runCli(["-p", "noop", "--egress", "db.example.com:5439"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /non-443 ports are not supported in v1/);
  assert.match(r.stderr, /raw-TCP/);
});

test("--egress rejects invalid hostnames", () => {
  const r = runCli(["-p", "noop", "--egress", "bad host/name"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a valid hostname/);
});

test("--egress rejects an empty value", () => {
  const r = runCli(["-p", "noop", "--egress", ""]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--egress requires a value/);
});

test("--egress + --network is a hard error", () => {
  const r = runCli([
    "-p",
    "noop",
    "--egress",
    "api.anthropic.com",
    "--network",
    "some-net",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /mutually exclusive/);
});

test("--egress under the apple runtime fails closed", () => {
  const r = runCli(["-p", "noop", "--egress", "api.anthropic.com"], {
    extraEnv: { HARNESS_CONTAINER_RUNTIME: "apple" },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /apple\/container runtime/);
  assert.match(r.stderr, /HARNESS_CONTAINER_RUNTIME=docker/);
});

test("--egress with invalid HARNESS_EGRESS_SUBNET is a hard error", () => {
  const r = runCli(["-p", "noop", "--egress", "none"], {
    extraEnv: { HARNESS_EGRESS_SUBNET: "not-a-cidr" },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HARNESS_EGRESS_SUBNET must be an IPv4 CIDR/);
});

test("custom HARNESS_EGRESS_SUBNET is used verbatim", () => {
  const rec = withRecordingShim();
  const r = runCli(["-p", "noop", "--egress", "none"], {
    extraEnv: { HARNESS_EGRESS_SUBNET: "198.51.100.0/29" },
  });
  assert.equal(r.status, 0, r.stderr);
  const create = rec.calls().find((c) => c.startsWith("network create"));
  assert.match(create, /--subnet 198\.51\.100\.0\/29/);
});

test("default argv unchanged: no egress calls leak without the flag", () => {
  const rec = withRecordingShim();
  const r = runCli(["-p", "noop"]);
  assert.equal(r.status, 0, r.stderr);
  const calls = rec.calls();
  assert.equal(
    calls.length,
    1,
    `expected exactly one docker call: ${calls.join(" | ")}`,
  );
  const run = calls[0];
  assert.ok(run.startsWith("run "), "the single call must be the agent run");
  assert.ok(!run.includes("--network"), "default path must not emit --network");
  assert.ok(
    !run.includes("HTTPS_PROXY"),
    "default path must not set proxy env",
  );
});

test("mixed exact+suffix allowlist: gateway run succeeds, squid.conf has two ACLs", () => {
  // The RFC's flagship example shape. Squid 6.x rejects a single dstdomain
  // ACL mixing bare hosts with .suffix entries ("Bungled ... acl"), which
  // killed the gateway at startup before the two-ACL split. The recording
  // shim cannot parse squid.conf, but the bring-up (gateway run + bridge
  // attach) only happens when the conf generated; a bungled conf surfaces
  // live as gateway-exit-during-startup.
  const rec = withRecordingShim();
  const r = runCli(["-p", "noop", "--egress", "api.anthropic.com,.openai.com"]);
  assert.equal(r.status, 0, r.stderr);
  const calls = rec.calls();
  const gw = calls.find(
    (c) => c.startsWith("run ") && c.includes("harness-egress-gw-"),
  );
  assert.ok(gw, `expected gateway run in: ${calls.join(" | ")}`);
  assert.match(r.stderr, /egress allowlist active — 2 destination/);
});

test("host.docker.internal maps to the egress network gateway on Linux, not host-gateway", () => {
  const rec = withRecordingShim();
  const r = runCli(["-p", "noop", "--egress", "api.anthropic.com"]);
  if (process.platform !== "linux") return; // add-host is Linux-only
  assert.equal(r.status, 0, r.stderr);
  const run = agentRun(rec.calls());
  assert.match(
    run,
    /--add-host host\.docker\.internal:192\.0\.2\.\d+\b/,
    `expected per-network gateway mapping: ${run}`,
  );
  assert.ok(
    !run.includes("host-gateway"),
    "host-gateway is unreachable from --internal networks (off-subnet)",
  );
});
