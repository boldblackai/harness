---
icon: lucide/github
---

# GitHub authentication (`gh` CLI)

Harness containers ship with the [GitHub CLI](https://cli.github.com/) (`gh`). To
use it — `gh pr`, `gh issue`, HTTPS pushes, etc. — you authenticate **once**.
Because harness persists `~/.config` (see [Persistence](persistence.md)), the
resulting session lives at `~/.config/gh/hosts.yml` and survives container
restarts, so the token does **not** need to live in any long-lived secret.

This page covers creating a Personal Access Token (PAT) and running the one-time
login. For the per-platform command to reach a running container, see the deploy
guides: [fly.io](deploying/fly.md), [Kubernetes](deploying/k8s.md),
[AWS](deploying/aws.md).

## 1. Create a Personal Access Token

1. Open the GitHub token page:
   - **Fine-grained** (recommended): <https://github.com/settings/personal-access-tokens/new>
   - **Classic**: <https://github.com/settings/tokens/new>
2. Add a note (e.g. `harness claw`) and an expiration.
3. Grant what the agent needs:
   - **Classic scopes** — `repo`, `workflow`, `read:org`
   - **Fine-grained** — *Repository access*: the repos to touch; *Permissions*:
     *Contents* `Read and write`, *Pull requests* `Read and write`,
     *Issues* `Read and write`, *Workflows* `Read and write`,
     *Metadata* `Read-only`.
4. Copy the token — you won't see it again.

> Treat the PAT like a password. The recipes below use it once to log `gh` in,
> then discard it; what persists is `gh`'s session, not your PAT.

## 2. Authenticate inside the running container

Run this once inside the running container (as the `harness` user):

```bash
# Leading space keeps the PAT out of shell history (HISTCONTROL=ignorespace).
$  echo "<your-pat>" | gh auth login --with-token
gh auth status
```

That's it. Harness already seeds git's HTTPS credential helper on first boot (so
you can skip `gh auth setup-git`) — the token you just stored is what `gh` *and*
`git push` / `git pull` over HTTPS will use. And because `~/.config/gh/` sits on
the persisted `~/.config` volume, it all survives restarts and deploys.

## 3. Run it on your deploy target

| Target | How to reach the running container |
|---|---|
| **fly.io** | `fly ssh console --app <app>` — see the [fly.io guide](deploying/fly.md) |
| **Kubernetes** | `kubectl exec ... -- gh auth login --with-token` — see the [k8s guide](deploying/k8s.md) |
| **AWS (Fargate)** | `aws ecs execute-command ...` — see the [AWS guide](deploying/aws.md) |
| **AWS (EC2)** | `aws ssm start-session ...` → `docker exec ...` — see the [AWS guide](deploying/aws.md) |

## Rotating or revoking

- **Rotate** — run `gh auth login --with-token` again with the new token; it
  overwrites the stored session.
- **Revoke** — run `gh auth logout` inside the container, or delete the token on
  GitHub.
