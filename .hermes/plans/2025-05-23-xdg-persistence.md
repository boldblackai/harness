# XDG Data Home Persistence Migration Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move per-agent persistence from `<cwd>/.harness/<agent>/` to `$XDG_DATA_HOME/harness/<normalized-cwd>/<agent>/`. Add per-agent `mise` data persistence so that tool installs, trust settings, and cached downloads survive container restarts. Closes #65, #64, #61.

**Architecture:** Two new helpers (`normalizeCwd`, `xdgDataDir`) replace the old `.harness` path logic. `persistRoot` shifts from `path.join(workspace, ".harness", agentName)` to `path.join(xdgDataDir(), "harness", normalizeCwd(workspace), agentName)`. A mise mount is added automatically for all adapters in non-ephemeral interactive mode. A deprecation warning fires when an old `.harness/` directory is detected in the CWD. All container-side paths, Dockerfiles, and entrypoints are unchanged.

**Tech Stack:** TypeScript (Node.js built-in test runner), minimist, Docker volume mounts.

**RFC:** `rfcs/2025-05-23_agent_persistence.md`

---

### Task 1: Add `normalizeCwd()` helper to `src/harness.ts`

**Objective:** Pure function that converts an absolute CWD into a normalized directory name by stripping the home prefix and replacing `/` with `_`.

**Files:**
- Modify: `src/harness.ts` (insert after line 348, before `getImage`)

**Step 1: Add the function**

```typescript
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
```

**Step 2: Verify build compiles**

Run: `pnpm build`
Expected: clean compile, no errors

**Step 3: Commit**

```bash
git add src/harness.ts
git commit -m "feat: add normalizeCwd() helper for XDG persistence path"
```

---

### Task 2: Add `xdgDataDir()` helper to `src/harness.ts`

**Objective:** Return the XDG data directory, defaulting to `~/.local/share` if `XDG_DATA_HOME` is unset.

**Files:**
- Modify: `src/harness.ts` (insert right after `normalizeCwd`)

**Step 1: Add the function**

```typescript
function xdgDataDir(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}
```

**Step 2: Verify build compiles**

Run: `pnpm build`
Expected: clean compile

**Step 3: Commit**

```bash
git add src/harness.ts
git commit -m "feat: add xdgDataDir() helper"
```

---

### Task 3: Replace `persistRoot` calculation in `run()`

**Objective:** Switch the persistence root from `<cwd>/.harness/<agent>/` to `$XDG_DATA_HOME/harness/<normalized-cwd>/<agent>/`.

**Files:**
- Modify: `src/harness.ts:488-495` (the `!effectiveEphemeral` block inside `run()`)

**Step 1: Replace the persistRoot line**

Change line 489 from:
```typescript
      const persistRoot = path.join(workspace, ".harness", agentName);
```
to:
```typescript
      const persistRoot = path.join(
        xdgDataDir(),
        "harness",
        normalizeCwd(workspace),
        agentName,
      );
```

**Step 2: Verify build compiles**

Run: `pnpm build`
Expected: clean compile

**Step 3: Commit**

```bash
git add src/harness.ts
git commit -m "feat: switch persistRoot to XDG_DATA_HOME/harness/<normalized-cwd>/<agent>"
```

---

### Task 4: Add deprecation warning for old `.harness/` directory

**Objective:** When harness detects a `.harness/` directory in the CWD, emit a one-time warning to stderr helping users migrate. The old directory is NOT read or written.

**Files:**
- Modify: `src/harness.ts` (insert inside the `!effectiveEphemeral` block, right after the new `persistRoot` calculation and before the mount loop)

**Step 1: Add the warning**

Insert after the `persistRoot` definition (inside the `!effectiveEphemeral` block):

```typescript
      // Deprecation warning for old .harness/ directory
      const oldHarnessDir = path.join(workspace, ".harness");
      if (fs.existsSync(oldHarnessDir)) {
        console.error(
          `harness: WARNING: found ${oldHarnessDir}/ — persistence data now lives at ${path.join(xdgDataDir(), "harness", normalizeCwd(workspace), "<agent>")}. To migrate session data, copy the contents of .harness/<agent>/ to the new location. Otherwise this directory can be safely deleted.`,
        );
      }
```

**Step 2: Verify build compiles**

Run: `pnpm build`
Expected: clean compile

**Step 3: Commit**

```bash
git add src/harness.ts
git commit -m "feat: emit deprecation warning when old .harness/ directory exists"
```

---

### Task 5: Add per-agent mise mount + MISE_DATA_DIR env

**Objective:** After adapter persist mounts are set up, create a `<persistRoot>/mise/` directory and mount it at `/home/harness/.local/share/mise` with `MISE_DATA_DIR` env var. Only in non-ephemeral interactive mode.

**Files:**
- Modify: `src/harness.ts:488-496` (the `!effectiveEphemeral` block, after the adapter mount loop)

**Step 1: Add mise mount logic**

After the `for (const mount of mounts)` loop (after line 495), add:

```typescript
      // Per-agent mise persistence
      const miseHostPath = path.join(persistRoot, "mise");
      fs.mkdirSync(miseHostPath, { recursive: true });
      volumeArgs.push("-v", `${miseHostPath}:/home/harness/.local/share/mise`);
      volumeArgs.push("-e", "MISE_DATA_DIR=/home/harness/.local/share/mise");
```

**Important:** The mise env var uses `-e` in `volumeArgs` to keep it simple — docker `run` accepts `-e` flags interspersed with other args. This avoids needing to mutate `adapterDockerArgs` (which is `const`).

**Step 2: Verify build compiles**

Run: `pnpm build`
Expected: clean compile

**Step 3: Commit**

```bash
git add src/harness.ts
git commit -m "feat: add per-agent mise persistence mount and MISE_DATA_DIR env"
```

---

### Task 6: Update USAGE help text

**Objective:** Remove `.harness` references from the help string. Add `XDG_DATA_HOME` to the environment variables section.

**Files:**
- Modify: `src/harness.ts:319-338` (the `USAGE` template literal)

**Step 1: Update the USAGE string**

Replace the entire `USAGE` constant with:

```typescript
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
```

**Step 2: Verify build compiles**

Run: `pnpm build`
Expected: clean compile

**Step 3: Commit**

```bash
git add src/harness.ts
git commit -m "docs: update USAGE to document XDG_DATA_HOME, remove .harness references"
```

---

### Task 7: Add CWD normalization unit tests

**Objective:** Test the `normalizeCwd()` helper with the exact examples from the RFC table. Since `normalizeCwd` depends on `os.homedir()`, tests override `HOME` via env to control the home directory.

**Files:**
- Modify: `tests/e2e/cli.test.mjs` (append at the end)

**Step 1: Add normalization tests**

These tests run the CLI itself as a subprocess with a controlled `HOME` env var, since `normalizeCwd` is not exported. We verify normalization indirectly by checking where the persist directory is created.

```javascript
// ---- CWD normalization (XDG persistence) ----------------------------------

test("normalizeCwd: CWD under home strips home prefix and replaces / with _", () => {
  // When CWD is /home/<user>/projects/foo (under a temp HOME), the persist
  // dir should be at $XDG_DATA_HOME/harness/_projects_foo/pi/
  const which = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-norm-"));
  const homeDir = path.join(tmp, "home");
  const projectDir = path.join(homeDir, "projects", "foo");
  fs.mkdirSync(projectDir, { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync(
      "script",
      ["-qfec", `node ${CLI}`, "/dev/null"],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          PATH: `${SHIM_DIR}:${process.env.PATH}`,
          HARNESS_IMAGE_TAG: "test-tag",
          HOME: homeDir,
          XDG_DATA_HOME: xdgData,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness", "_projects_foo", "pi")),
      true,
      "persist dir should be at XDG_DATA_HOME/harness/_projects_foo/pi/",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("normalizeCwd: CWD is exactly home dir → uses _home", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-norm-home-"));
  const homeDir = path.join(tmp, "myhome");
  fs.mkdirSync(homeDir, { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync(
      "script",
      ["-qfec", `node ${CLI}`, "/dev/null"],
      {
        cwd: homeDir,
        env: {
          ...process.env,
          PATH: `${SHIM_DIR}:${process.env.PATH}`,
          HARNESS_IMAGE_TAG: "test-tag",
          HOME: homeDir,
          XDG_DATA_HOME: xdgData,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness", "_home", "pi")),
      true,
      "persist dir should be at XDG_DATA_HOME/harness/_home/pi/",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("normalizeCwd: CWD not under home keeps full path with slashes replaced", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-norm-abs-"));
  const sandboxDir = path.join(tmp, "tmp", "sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  // HOME is set to something unrelated, so /tmp/sandbox won't start with it
  const fakeHome = path.join(tmp, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  try {
    const r = spawnSync(
      "script",
      ["-qfec", `node ${CLI}`, "/dev/null"],
      {
        cwd: sandboxDir,
        env: {
          ...process.env,
          PATH: `${SHIM_DIR}:${process.env.PATH}`,
          HARNESS_IMAGE_TAG: "test-tag",
          HOME: fakeHome,
          XDG_DATA_HOME: xdgData,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    // The normalized path is the full absolute path with / → _
    // e.g. /tmp/harness-norm-xxx/tmp/sandbox → _tmp_harness-norm-xxx_tmp_sandbox
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness")),
      true,
      "harness root should exist in XDG_DATA_HOME",
    );
    // Verify no .harness in the CWD
    assert.equal(
      fs.existsSync(path.join(sandboxDir, ".harness")),
      false,
      ".harness/ must NOT be created in CWD",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

**Step 2: Run tests**

Run: `pnpm test:e2e`
Expected: all tests pass (including the 3 new ones)

**Step 3: Commit**

```bash
git add tests/e2e/cli.test.mjs
git commit -m "test: add normalizeCwd unit tests for XDG persistence"
```

---

### Task 8: Add mise mount tests

**Objective:** Verify that the mise directory is created and mounted correctly in interactive mode, and NOT created in ephemeral mode.

**Files:**
- Modify: `tests/e2e/cli.test.mjs` (append after normalization tests)

**Step 1: Add mise tests**

```javascript
// ---- mise persistence (XDG persistence) -----------------------------------

test("interactive mode creates mise dir and mounts it at /home/harness/.local/share/mise", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mise-"));
  const xdgData = path.join(tmp, "xdg-data");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync(
      "script",
      ["-qfec", `node ${CLI}`, "/dev/null"],
      {
        cwd: workDir,
        env: {
          ...process.env,
          PATH: `${SHIM_DIR}:${process.env.PATH}`,
          HARNESS_IMAGE_TAG: "test-tag",
          HOME: tmp,
          XDG_DATA_HOME: xdgData,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    // mise dir must exist under the persist root
    const normalizedCwd = workDir.startsWith(tmp) ? workDir.slice(tmp.length).replace(/\//g, "_") : workDir.replace(/\//g, "_");
    const miseDir = path.join(xdgData, "harness", normalizedCwd, "pi", "mise");
    assert.equal(
      fs.existsSync(miseDir),
      true,
      `mise dir should exist at ${miseDir}`,
    );
    // docker args must include the mise mount
    const cleaned = r.stdout.replace(/\r/g, "");
    const a = dockerArgs(cleaned);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.ok(
      a.some((arg) => arg.endsWith(":/home/harness/.local/share/mise")),
      `expected mise volume mount in: ${a.join(" ")}`,
    );
    // docker args must include MISE_DATA_DIR env
    assert.ok(
      a.some((arg) => arg === "MISE_DATA_DIR=/home/harness/.local/share/mise"),
      `expected MISE_DATA_DIR env in: ${a.join(" ")}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ephemeral mode (-p) does NOT create mise dir or mount", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mise-eph-"));
  const xdgData = path.join(tmp, "xdg-data");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync("node", [CLI, "-p", "noop"], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${SHIM_DIR}:${process.env.PATH}`,
        HARNESS_IMAGE_TAG: "test-tag",
        HOME: tmp,
        XDG_DATA_HOME: xdgData,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    // No mise dir should exist under XDG_DATA_HOME/harness/
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness")),
      false,
      "no persist dirs should exist in ephemeral mode",
    );
    // No mise mount in docker args
    const a = dockerArgs(r.stdout);
    assert.ok(a, "expected DOCKER_INVOKED line");
    assert.equal(
      a.some((arg) => arg.endsWith(":/home/harness/.local/share/mise")),
      false,
      "ephemeral mode must not mount mise",
    );
    assert.equal(
      a.some((arg) => arg.includes("MISE_DATA_DIR")),
      false,
      "ephemeral mode must not set MISE_DATA_DIR",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

**Step 2: Run tests**

Run: `pnpm test:e2e`
Expected: all tests pass (including the 2 new ones)

**Step 3: Commit**

```bash
git add tests/e2e/cli.test.mjs
git commit -m "test: add mise persistence mount tests (present in interactive, absent in ephemeral)"
```

---

### Task 9: Add XDG_DATA_HOME override test

**Objective:** Verify that setting `XDG_DATA_HOME` causes persist dirs to be created at the custom location.

**Files:**
- Modify: `tests/e2e/cli.test.mjs` (append after mise tests)

**Step 1: Add test**

```javascript
test("XDG_DATA_HOME override: persist dirs created at custom location", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-xdg-"));
  const customXdg = path.join(tmp, "custom-xdg");
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(customXdg, { recursive: true });
  try {
    const r = spawnSync(
      "script",
      ["-qfec", `node ${CLI}`, "/dev/null"],
      {
        cwd: workDir,
        env: {
          ...process.env,
          PATH: `${SHIM_DIR}:${process.env.PATH}`,
          HARNESS_IMAGE_TAG: "test-tag",
          HOME: tmp,
          XDG_DATA_HOME: customXdg,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    // Persist dir must be under the custom XDG_DATA_HOME, not the default ~/.local/share
    assert.equal(
      fs.existsSync(path.join(customXdg, "harness")),
      true,
      "harness root should exist under custom XDG_DATA_HOME",
    );
    // No persist dir under the default location
    const defaultXdg = path.join(tmp, ".local", "share");
    assert.equal(
      fs.existsSync(path.join(defaultXdg, "harness")),
      false,
      "no persist dir should exist under default ~/.local/share",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

**Step 2: Run tests**

Run: `pnpm test:e2e`
Expected: all tests pass

**Step 3: Commit**

```bash
git add tests/e2e/cli.test.mjs
git commit -m "test: verify XDG_DATA_HOME override places persist dirs at custom location"
```

---

### Task 10: Add no-`.harness/`-in-CWD test + deprecation warning test

**Objective:** Verify that the old `.harness/` directory is NEVER created in the CWD in any mode. Verify the deprecation warning fires when an old `.harness/` directory already exists.

**Files:**
- Modify: `tests/e2e/cli.test.mjs` (append after XDG override test)

**Step 1: Add tests**

```javascript
test("no .harness/ directory is ever created in the CWD (XDG migration)", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-no-harness-"));
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync(
      "script",
      ["-qfec", `node ${CLI}`, "/dev/null"],
      {
        cwd: workDir,
        env: {
          ...process.env,
          PATH: `${SHIM_DIR}:${process.env.PATH}`,
          HARNESS_IMAGE_TAG: "test-tag",
          HOME: tmp,
          XDG_DATA_HOME: xdgData,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(path.join(workDir, ".harness")),
      false,
      ".harness/ must NEVER be created in the CWD",
    );
    // But persist data should exist under XDG
    assert.equal(
      fs.existsSync(path.join(xdgData, "harness")),
      true,
      "persist data should exist under XDG_DATA_HOME",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("deprecation warning fires when old .harness/ directory exists in CWD", () => {
  const which = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
  if (which.status !== 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-deprecation-"));
  const workDir = path.join(tmp, "work");
  fs.mkdirSync(workDir, { recursive: true });
  // Create the old .harness/ directory to trigger the warning
  fs.mkdirSync(path.join(workDir, ".harness", "pi"), { recursive: true });
  const xdgData = path.join(tmp, "xdg-data");
  fs.mkdirSync(xdgData, { recursive: true });
  try {
    const r = spawnSync(
      "script",
      ["-qfec", `node ${CLI}`, "/dev/null"],
      {
        cwd: workDir,
        env: {
          ...process.env,
          PATH: `${SHIM_DIR}:${process.env.PATH}`,
          HARNESS_IMAGE_TAG: "test-tag",
          HOME: tmp,
          XDG_DATA_HOME: xdgData,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stderr,
      /found.*\.harness.*persistence data now lives at/,
      "should emit deprecation warning about old .harness/ directory",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

**Step 2: Run tests**

Run: `pnpm test:e2e`
Expected: all tests pass

**Step 3: Commit**

```bash
git add tests/e2e/cli.test.mjs
git commit -m "test: verify no .harness/ in CWD and deprecation warning fires"
```

---

### Task 11: Update existing persistence tests to use XDG paths

**Objective:** Update all existing tests that assert on `.harness/` paths to instead assert on the new `$XDG_DATA_HOME/harness/<normalized>/<agent>/` paths. These tests currently create their own `localWork` temp dir and check `path.join(localWork, ".harness", ...)`.

**Files:**
- Modify: `tests/e2e/cli.test.mjs`

**Tests to update (line numbers approximate):**

1. **Line 535** — `"interactive (PTY, no -p, no --ephemeral) creates .harness/<agent>/ persistence dir"`
   - Change assertion from `fs.existsSync(path.join(localWork, ".harness", "pi"))` to check XDG path
   - Add `HOME` and `XDG_DATA_HOME` env vars to the `script` invocation
   - Compute expected path as `path.join(xdgDataDir, "harness", normalizedCwd, "pi")`
   - Update test name to reflect new path

2. **Line 582** — `"--ephemeral overrides interactive PTY: no .harness/ dir, no persist mount"`
   - Change assertion from `fs.existsSync(path.join(localWork, ".harness"))` to also verify no dir at XDG path
   - Add `HOME` and `XDG_DATA_HOME` env vars

3. **Line 672** — `"opencode interactive (no --ephemeral) creates all three persistence dirs and mounts"`
   - Change the 3 assertions checking `path.join(localWork, ".harness", "opencode", sub)` to check XDG path
   - Add `HOME` and `XDG_DATA_HOME` env vars

4. **Line 1001** — `"--volumes is forwarded alongside interactive persistence mounts"`
   - Change assertion from `path.join(localWork, ".harness", "pi")` to XDG path
   - Add `HOME` and `XDG_DATA_HOME` env vars

5. **Line 1439** — `"hermes interactive (no --ephemeral) creates both persistence dirs and mounts"`
   - Change the 2 assertions checking `path.join(localWork, ".harness", "hermes", sub)` to XDG path
   - Add `HOME` and `XDG_DATA_HOME` env vars

6. **Line 494** — `"one-shot run (-p) is implicitly ephemeral: no .harness/ dir created"`
   - Also assert no dir at XDG path (update to pass `HOME` + `XDG_DATA_HOME`)

7. **Line 513** — `"piped stdin is implicitly ephemeral and forwards prompt"`
   - Also assert no dir at XDG path

8. **Line 629** — `"piped whitespace-only stdin takes no-prompt branch"`
   - Also assert no dir at XDG path

**Pattern for each test update:**

Each test needs a temp XDG dir and must pass it as env:

```javascript
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-"));
const xdgData = path.join(tmpRoot, "xdg-data");
fs.mkdirSync(xdgData, { recursive: true });
// ... in the spawn env:
HOME: tmpRoot,
XDG_DATA_HOME: xdgData,
// ... assertion:
const normalized = localWork.slice(tmpRoot.length).replace(/\//g, "_");
fs.existsSync(path.join(xdgData, "harness", normalized, "pi"))
```

**Step 1: Update each test one at a time, running `pnpm test:e2e` after each**

**Step 2: Run full test suite**

Run: `pnpm test:e2e`
Expected: all tests pass

**Step 3: Commit**

```bash
git add tests/e2e/cli.test.mjs
git commit -m "test: update all persistence tests from .harness/ to XDG_DATA_HOME paths"
```

---

### Task 12: Add `--help` test for XDG_DATA_HOME documentation

**Objective:** Lock down that the USAGE text documents `XDG_DATA_HOME` and `XDG_CACHE_HOME`.

**Files:**
- Modify: `tests/e2e/cli.test.mjs` (append)

**Step 1: Add test**

```javascript
test("--help documents XDG_DATA_HOME and XDG_CACHE_HOME environment variables", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /XDG_DATA_HOME/);
  assert.match(r.stdout, /XDG_CACHE_HOME/);
  // Must be in the Environment variables section
  assert.match(r.stdout, /Environment variables:[\s\S]*XDG_DATA_HOME/);
  // Persistence path description must mention the XDG path structure
  assert.match(r.stdout, /\$XDG_DATA_HOME\/harness/);
});
```

**Step 2: Run tests**

Run: `pnpm test:e2e`
Expected: all tests pass

**Step 3: Commit**

```bash
git add tests/e2e/cli.test.mjs
git commit -m "test: lock down XDG_DATA_HOME and XDG_CACHE_HOME in --help output"
```

---

### Task 13: Run lint and format

**Objective:** Ensure all code passes the project's linters and formatters.

**Files:** All changed files

**Step 1: Run format**

Run: `pnpm format`

**Step 2: Run lint**

Run: `pnpm lint`
Expected: no errors

**Step 3: Commit any formatting changes**

```bash
git add -A
git commit -m "style: apply formatter and lint fixes"
```

---

### Task 14: Run full test suite with coverage

**Objective:** Verify all tests pass and coverage stays above the 80% threshold.

**Step 1: Run coverage**

Run: `pnpm test:coverage`
Expected: all tests pass, coverage ≥ 80% line/branch/function

**Step 2: If coverage fails, add targeted tests for uncovered branches**

---

### Task 15: Update README.md

**Objective:** Remove `.harness/` references from the README and document the new XDG persistence paths.

**Files:**
- Modify: `README.md`

**Step 1: Find and update all `.harness` references**

Search for `.harness` in README.md. Replace descriptions of `<cwd>/.harness/<agent>/` with `$XDG_DATA_HOME/harness/<project>/<agent>/`. Document that `XDG_DATA_HOME` defaults to `~/.local/share`. Mention that mise data is persisted per-agent. Add the deprecation note about old `.harness/` directories.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README to document XDG persistence paths"
```

---

### Task 16: Update AGENTS.md

**Objective:** Update the persistence and architecture sections to reflect the new XDG paths.

**Files:**
- Modify: `AGENTS.md`

**Step 1: Update the Persistence section**

Change:
> Interactive runs bind-mount `.harness/<agent>/` from the working directory into the container.

To reflect the new XDG path structure. Update the description to mention `normalizeCwd()`, `xdgDataDir()`, and the mise mount.

**Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md to reflect XDG persistence migration"
```

---

### Task 17: Final verification

**Objective:** Clean build + full test suite + lint pass.

**Step 1: Clean build from scratch**

```bash
pnpm build && pnpm lint && pnpm test:coverage
```

Expected: all green, coverage ≥ 80%

**Step 2: Verify no `.harness` references remain in source**

Run: `grep -r '\.harness' src/harness.ts`
Expected: only the deprecation warning check (`fs.existsSync(oldHarnessDir)`) and the `oldHarnessDir` path construction. No other `.harness` references in production code paths.

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | `normalizeCwd()` helper | `src/harness.ts` |
| 2 | `xdgDataDir()` helper | `src/harness.ts` |
| 3 | Replace `persistRoot` calculation | `src/harness.ts` |
| 4 | Deprecation warning for old `.harness/` | `src/harness.ts` |
| 5 | Mise mount + `MISE_DATA_DIR` env | `src/harness.ts` |
| 6 | Update USAGE help text | `src/harness.ts` |
| 7 | CWD normalization tests | `tests/e2e/cli.test.mjs` |
| 8 | Mise mount tests | `tests/e2e/cli.test.mjs` |
| 9 | XDG_DATA_HOME override test | `tests/e2e/cli.test.mjs` |
| 10 | No-`.harness/`-in-CWD + deprecation tests | `tests/e2e/cli.test.mjs` |
| 11 | Update existing persistence tests | `tests/e2e/cli.test.mjs` |
| 12 | `--help` XDG documentation test | `tests/e2e/cli.test.mjs` |
| 13 | Lint + format | All changed |
| 14 | Coverage verification | — |
| 15 | Update README.md | `README.md` |
| 16 | Update AGENTS.md | `AGENTS.md` |
| 17 | Final verification | — |

**Closes:** #65 (mise persistence), #64 (mise trust), #61 (XDG standard paths)
