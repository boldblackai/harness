// Behavior-matrix tests for scripts/fetch-retry.sh — the bounded-retry fetch
// wrapper the Dockerfile.hermes verify chain routes every network fetch
// through. Each test names the grammar property it locks; the matrix is the
// helper's contract: transient classes retry until success within the bound,
// redirects are followed to the final body, Retry-After governs sleeps,
// non-transient failures fail fast, a failed promote never reports success,
// caller options cannot override the fixed fetch contract, and persistent
// failure fails closed at the attempt cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, existsSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HELPER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "fetch-retry.sh",
);

// Starts a mock server whose i-th request gets PLAN[min(i, len-1)].
// Plan entries are [status, retryAfter|null, location?].
// Returns { url, requests, close }.
function mockServer(plan) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const [status, retryAfter, location] = plan[Math.min(requests.length - 1, plan.length - 1)];
    if (retryAfter !== null) res.setHeader("Retry-After", String(retryAfter));
    if (location !== undefined) res.setHeader("Location", location);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(status === 200 ? '{"ok":true}' : '{"message":"transient"}');
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/x`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Runs the helper against URL; options.args are extra curl args and
// options.out overrides the output path (for pre-arranged failure shapes).
async function runHelper(url, { args = [], out = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-retry-"));
  const outPath = out ?? path.join(dir, "out.bin");
  const t0 = Date.now();
  let rc = 0;
  try {
    await execFileP("bash", [HELPER, outPath, url, ...args], { timeout: 120_000 });
  } catch (err) {
    rc = err.code ?? 1;
  }
  const elapsed = (Date.now() - t0) / 1000;
  const ok = rc === 0 && existsSync(outPath);
  const content = ok ? readFileSync(outPath, "utf8") : null;
  rmSync(dir, { recursive: true, force: true });
  return { rc, ok, elapsed, content };
}

test("success on the first attempt issues exactly one request", async () => {
  const srv = await mockServer([[200, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, true);
    assert.equal(srv.requests.length, 1);
    assert.ok(r.elapsed < 2, `expected no backoff sleep, took ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});

test("403 is transient: retries until success and honors Retry-After", async () => {
  const srv = await mockServer([[403, 1], [403, 1], [200, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, true);
    assert.equal(srv.requests.length, 3);
    assert.ok(r.elapsed >= 2, `Retry-After 1+1 not honored, took ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});

test("429 honors Retry-After delta-seconds", async () => {
  const srv = await mockServer([[429, 2], [200, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, true);
    assert.equal(srv.requests.length, 2);
    assert.ok(r.elapsed >= 2, `Retry-After 2 not honored, took ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});

test("5xx is transient: retries until success", async () => {
  const srv = await mockServer([[500, null], [502, null], [200, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, true);
    assert.equal(srv.requests.length, 3);
  } finally {
    await srv.close();
  }
});

test("persistent transient failure fails closed at the attempt cap", async () => {
  const srv = await mockServer([[403, 1]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, false);
    assert.notEqual(r.rc, 0);
    assert.equal(srv.requests.length, 5, "the attempt cap must bound persistent failure");
    assert.ok(r.elapsed < 60, `bounded backoff exceeded a minute: ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});

test("non-transient 4xx fails immediately without retries", async () => {
  const srv = await mockServer([[404, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, false);
    assert.notEqual(r.rc, 0);
    assert.equal(srv.requests.length, 1, "a non-transient status must not retry");
    assert.ok(r.elapsed < 5, `fail-fast took ${r.elapsed}s`);
  } finally {
    await srv.close();
  }
});

test("a 3xx redirect is followed to the final 2xx body", async () => {
  const srv = await mockServer([[302, null, "/final"], [200, null]]);
  try {
    const r = await runHelper(srv.url);
    assert.equal(r.ok, true, `redirect fetch must succeed, rc=${r.rc}`);
    assert.equal(srv.requests.length, 2, "the helper must follow the redirect exactly once");
    assert.equal(r.content, '{"ok":true}', "the final response body must land in OUT");
  } finally {
    await srv.close();
  }
});

test("a failed promote to OUT reports failure, not success", async () => {
  const srv = await mockServer([[200, null]]);
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-retry-"));
  try {
    // OUT is a non-empty directory: the fetch can write OUT.tmp beside it,
    // but the promote cannot overwrite the directory.
    const outPath = path.join(dir, "out");
    mkdirSync(outPath);
    writeFileSync(path.join(outPath, "keep"), "x");
    const r = await runHelper(srv.url, { out: outPath });
    assert.notEqual(r.rc, 0, "a failed promote must not exit 0");
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

test("caller-supplied curl options cannot override the fixed fetch contract", async () => {
  // Curl semantics (probed): the FIRST -o wins for a single transfer, scalar
  // options are last-wins. So the fixed contract must put its -o before the
  // caller's args and its scalar bounds after them: a caller -o must not
  // divert the body, and caller -w/--max-redirs must not break status
  // capture or redirect-following.
  const srv = await mockServer([[302, null, "/final"], [200, null]]);
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-retry-"));
  try {
    const hijack = path.join(dir, "hijacked.bin");
    const r = await runHelper(srv.url, {
      args: ["-w", "XX%{http_code}", "--max-redirs", "0", "-o", hijack],
    });
    assert.equal(r.ok, true, "the fixed fetch contract must win over caller options");
    assert.equal(r.content, '{"ok":true}', "the body must land at the fixed output path");
    assert.equal(srv.requests.length, 2, "redirect-following must survive a caller --max-redirs 0");
    assert.equal(existsSync(hijack), false, "a caller -o must not divert the body");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});
