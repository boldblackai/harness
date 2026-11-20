# GitHub App authentication for a Hermes gateway

The optional [GitHub App example](https://github.com/boldblackai/harness/tree/main/examples/github-app-auth) supplies short-lived installation tokens to `gh` and HTTPS Git. It is intended for an AWS-hosted Hermes gateway using the upstream Harness image. It reads App credentials from SSM through the workload role, rather than storing an installation token in persisted `~/.config/gh`.

This example does not change the image, entrypoint, or default PAT authentication. It targets GitHub.com and the Hermes image's Python environment; GitHub Enterprise and other secret backends are not implemented. The helper's dependencies are present in Hermes v0.22.2 as shipped by `hermes-1.12.0`.

## App and secret setup

Create a dedicated GitHub App and install it on selected repositories. Grant only the repository permissions required for its work. The helper supports `contents` and `pull_requests`, each at `read` or `write`; at least one is required. GitHub grants metadata read access implicitly. Workflow, organization, and administration permissions are deliberately unsupported in this example. Repository rules and branch protections still apply.

Record the numeric App ID, installation ID, and RSA private key. Store them as SSM SecureStrings in one namespace, for example:

| Parameter | Value |
|---|---|
| `/harness/github-app/GITHUB_APP_ID` | Numeric App ID, not OAuth client ID |
| `/harness/github-app/GITHUB_APP_INSTALLATION_ID` | Installation ID |
| `/harness/github-app/GITHUB_APP_PRIVATE_KEY` | Unencrypted PEM private key; multiline or escaped `\n` accepted |

The gateway's ECS task role or EC2 instance role needs `ssm:GetParameters` on these three parameter ARNs. For a customer-managed KMS key, also allow `kms:Decrypt` on that key, constrained to SSM in the deployment region, and ensure its key policy permits the role. Set `AWS_REGION` in the gateway environment. Use the normal AWS workload credentials; do not put static AWS keys or the App private key in committed files.

Keep this namespace excluded from any bulk SSM-to-environment loader used by the gateway. The helper retrieves these parameters directly; including them in a generic secret-source mapping would also expose the private key in the gateway environment.

The helper creates an [RS256 App JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) and requests an [installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) narrowed to the configured repository IDs and permissions. Installation tokens normally expire after one hour; the helper refreshes five minutes before expiry. App JWTs and private keys remain in helper memory.

## Install and review the policy

Copy `examples/github-app-auth/bin/` from this repository to `$HERMES_HOME/github-app-auth/bin/` on the gateway's persistent volume. Keep both scripts executable and owned by the workload user. Copy `config.example.json` alongside `bin/` as `config.json` and edit it before enabling the helper. The sample has empty repository lists and intentionally fails validation.

For example, after replacing the repository ID and full name with a matching pair:

```json
{
  "ssm_parameter_prefix": "/harness/github-app",
  "repository_ids": [123456789],
  "repositories": ["YOUR_ORG/YOUR_REPOSITORY"],
  "permissions": {
    "contents": "write",
    "pull_requests": "write"
  }
}
```

IDs and names must be unique and correspond in array order. For a read-only checkout, use `"permissions": {"contents": "read"}`. The installation itself must already grant the requested access. `diagnose` verifies the actual repository IDs/names against the policy; it fails on a mismatch.

The default policy path is `$HERMES_HOME/github-app-auth/config.json` (`HERMES_HOME` defaults to `/home/harness/.hermes`). To use another absolute path, set `GITHUB_APP_AUTH_CONFIG` consistently for setup, the gateway, and removal. This file contains configuration, not secrets. Use a separate policy file per gateway/App and keep each runtime's `/tmp` ephemeral.

## Enable and verify

Run as the `harness` user inside the container, after Harness's normal entrypoint has set up the persisted global Git configuration:

```bash
export HERMES_HOME=/home/harness/.hermes
export PATH="$HERMES_HOME/github-app-auth/bin:$PATH"
github-app-auth diagnose
github-app-auth configure-git
gh auth status
```

`diagnose` mints a fresh token and reports repository scope, permissions, and expiry without printing the token. The wrapped `gh auth status` uses the same diagnostic with a cached token when valid, including if `--show-token` is supplied. Other `gh auth` subcommands are disabled through the wrapper because App authentication is automatic.

`configure-git` installs a repository-path-aware HTTPS credential helper and sets the App bot's commit name/email. It saves the previous helper list, `useHttpPath`, and author identity before changing them. Repeating setup preserves that original snapshot. The snapshot is tied to the global Git config path so it cannot accidentally restore settings into another config.

Keep the PATH prefix in the gateway's startup environment so agent subprocesses resolve the wrapper. If your deployment starts the gateway with a shell command after the image entrypoint, an example command is:

```bash
export PATH="/home/harness/.hermes/github-app-auth/bin:$PATH"
github-app-auth diagnose && github-app-auth configure-git && exec hermes gateway
```

Keep the upstream entrypoint: it sets `GIT_CONFIG_GLOBAL=/home/harness/.config/gitconfig`. Do not configure a separate PAT login at startup when using this mode. A PATH change in an interactive shell does not change an already-running gateway; restart it with the new startup configuration.

Use HTTPS remotes, such as `https://github.com/YOUR_ORG/YOUR_REPOSITORY.git`, without embedded tokens. Validate a read operation on an approved repository, then a disposable branch/PR if write access is needed. The Git helper supplies credentials only for the exact configured repository paths on `https://github.com` (including explicit port 443).

## Token handling and boundaries

The helper passes the installation token to the real `/usr/local/bin/gh` through its child environment, or to Git through the credential-helper protocol. It removes competing token variables and `GH_DEBUG` before starting `gh`. It does not log in or write tokens to `hosts.yml`. Avoid token-bearing URLs, shell tracing, and HTTP credential debugging.

The cache lives under `/tmp/harness-github-app-<uid>-<config-hash>/`, with mode 0700 on the directory and 0600 on token/lock files. A file lock serializes refreshes and atomic replacement publishes the new token. Cached tokens are rejected near expiry or after policy, SSM namespace, region, or profile changes. Different policy paths get different cache directories. The private key is not cached there. Do not persist or share this directory between gateways.

The selected-repository installation and GitHub's permission enforcement are the security boundary. The local policy and wrapper help avoid accidental misuse; they are not a sandbox against code running as the same OS user. Such code can read the cache, inherit a child token, modify the helper, or use the workload role to retrieve the App private key. A dedicated App with narrow installation permissions is essential to this design.

No generic command retry is performed: retrying a failed `gh` mutation could duplicate a completed action. After a revoked token or HTTP 401, clear the cache, diagnose, and inspect the operation's result before deciding to retry:

```bash
github-app-auth clear-cache
github-app-auth diagnose
```

Rotating an App key means updating SSM, clearing the cache in every gateway using it, and verifying access before retiring the old key. Removing a private key does not necessarily revoke existing installation tokens; revoke installation access explicitly when required. See [GitHub's private-key guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

## Remove the integration

Stop the gateway, restore settings using the same configuration path, and clear its token cache:

```bash
github-app-auth restore-git
github-app-auth clear-cache
```

Restore only changes values that still match those installed by the helper; later operator edits are preserved. Remove the PATH prefix and startup commands before restarting the gateway. Keep the helper files until restoration succeeds. Remove the SSM/IAM grants and uninstall or revoke the GitHub App when permanently retiring it. Returning to PAT mode requires authenticating the real GitHub CLI again if no valid prior login remains.

## Local checks

```bash
uv run --with-requirements examples/github-app-auth/requirements-test.txt \
  python -m unittest discover -s examples/github-app-auth/tests -v
```

The dependencies match those used by the shipped Hermes version. Tests use simulated AWS/GitHub responses, a generated RSA key, and temporary Git config files. They do not read production secrets, mint live installation tokens, or change the developer's Git configuration.
