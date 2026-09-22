# Deploying `hermes-agent` to Kubernetes

## Overview

This guide walks you through deploying [hermes-agent](https://hermes-agent.nousresearch.com/) as a
long-running "claw" (a persistent agent process) to a K8s cluster using the harness image.

Two shapes are documented:

| Option | When to pick it |
|---|---|
| **A. Single Deployment** (below) | One agent. Plain `kubectl apply`, no Helm or GitOps required. |
| **B. One StatefulSet per agent** | A fleet of agents sharing one cluster. Each agent gets its own PVC, ServiceAccount, secrets, and network identity. See [§ Fleet pattern](#fleet-pattern-one-statefulset-per-agent). |

The single Deployment is the smallest correct manifest; the fleet pattern is the
same model (persistence via `subPath` mounts off one claim per agent, entrypoint
runs, cloud-mode env) hardened with everything learned running it in production:
`StatefulSet` + `volumeClaimTemplates`, container-scoped security context,
probes on a real health endpoint, and a headless governing Service.

## Architecture

| Component | Description |
|---|---|
| **Deployment** | Single-replica pod running `ghcr.io/boldblackai/harness:hermes-1.10.2` |
| **PVC** | 100Gi persistent volume for agent state — `.hermes`, `.config`, and mise data/state (mounted via `subPath`) |
| **PDB** | PodDisruptionBudget ensuring at least 1 pod is available |
| **Secrets** | API keys sourced from a K8s Secret (`k8sclaw-secrets`) |

## Prerequisites

- A Kubernetes cluster ≥ 1.21 (k3s or any compatible runtime)
- `kubectl` installed and configured with cluster access
- Container image access to `ghcr.io/boldblackai/harness:hermes-1.10.2`
- A default StorageClass provisioned (or specify one in `k8sclaw.yaml`)

## Deploy

### 1. Create the namespace

```bash
kubectl create namespace k8sclaw
```

### 2. Create the Secret

Create `k8sclaw-secrets` with the required keys:

| Key | Description |
|---|---|
| `OPENROUTER_API_KEY` | API key for the OpenRouter LLM gateway |
| `TELEGRAM_BOT_TOKEN` | Token for the Telegram bot interface |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs allowed to interact with the bot |

_If you add a <space> before the following command it won't end up in your shell history._

```bash
  kubectl --namespace k8sclaw create secret generic k8sclaw-secrets \
  --from-literal=OPENROUTER_API_KEY="your-openrouter-key" \
  --from-literal=TELEGRAM_BOT_TOKEN="your-telegram-token" \
  --from-literal=TELEGRAM_ALLOWED_USERS="your-telegram-user-ids"
```

### 3. Apply the manifests

```bash
kubectl apply -f k8sclaw.yaml
```

## GitHub authentication (`gh` CLI)

To use `gh` (or HTTPS git) from inside the claw, authenticate once — the session persists in `~/.config` (on the PVC's `config` subPath), so it survives pod restarts. See [GitHub authentication](../github.md) for creating a PAT.

`kubectl exec` runs as the pod's `harness` user and forwards stdin with `-i`, so you can pipe the token straight in — no Secret required:

```bash
# Pipe the PAT directly into the running pod. (Leading space keeps it out of
# your local shell history.)
 echo "<your-github-pat>" | \
  kubectl --namespace k8sclaw exec -i deploy/k8sclaw -- gh auth login --with-token
kubectl --namespace k8sclaw exec deploy/k8sclaw -- gh auth status
```

## Manifest Reference

### All-in-one (`k8sclaw.yaml`)

```yaml
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: k8sclaw-data
  namespace: k8sclaw
spec:
  # Uncomment and set to your cluster's StorageClass if no default is provisioned
  # storageClassName: standard
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: k8sclaw
  namespace: k8sclaw
spec:
  replicas: 1
  selector:
    matchLabels:
      app: k8sclaw
  template:
    metadata:
      labels:
        app: k8sclaw
    spec:
      terminationGracePeriodSeconds: 60
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
        - name: k8sclaw
          image: ghcr.io/boldblackai/harness:hermes-1.10.2
          imagePullPolicy: Always
          # `args` (NOT `command`) so the image ENTRYPOINT
          # (/tini -- /entrypoint-hermes.sh) runs: it sources setup-env.sh
          # (seeds the gh git-credential helper into the persisted ~/.config)
          # and reconciles config.yaml before exec-ing the gateway.
          args: ["hermes", "gateway"]
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
          env:
            - name: TZ
              value: "America/New_York"
            # Signal the entrypoint to skip local defaults and
            # auto-detect providers from API keys in the env.
            - name: HARNESS_CLOUD_MODE
              value: "1"
            # Persist the faster-whisper model cache across restarts.
            # Without this, the model re-downloads (~142 MB) on every pod restart.
            - name: HF_HOME
              value: "/home/harness/.hermes/.cache/huggingface"
            #
            # add/modify any environment variables here
            #  https://hermes-agent.nousresearch.com/docs/reference/environment-variables
            #
            - name: OPENROUTER_API_KEY
              valueFrom:
                secretKeyRef:
                  name: k8sclaw-secrets
                  key: OPENROUTER_API_KEY
            - name: TELEGRAM_BOT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: k8sclaw-secrets
                  key: TELEGRAM_BOT_TOKEN
            - name: TELEGRAM_ALLOWED_USERS
              valueFrom:
                secretKeyRef:
                  name: k8sclaw-secrets
                  key: TELEGRAM_ALLOWED_USERS
          volumeMounts:
            # One PVC, four subPaths — mirrors what the `harness` CLI
            # bind-mounts so hermes config/sessions, XDG config, and mise
            # tools & trust settings all survive pod restarts.
            - name: data
              mountPath: /home/harness/.hermes
              subPath: hermes
            - name: data
              mountPath: /home/harness/.config
              subPath: config
            - name: data
              mountPath: /home/harness/.local/share/mise
              subPath: mise-data
            - name: data
              mountPath: /home/harness/.local/state/mise
              subPath: mise-state
          resources:
            requests:
              memory: "2Gi"
              cpu: "1000m"
            limits:
              memory: "4Gi"
              cpu: "4000m"
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: k8sclaw-data
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: k8sclaw-pdb
  namespace: k8sclaw
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: k8sclaw
```

> **Note:** The PDB prevents voluntary disruptions (e.g., `kubectl drain`) since there is only one replica. Remove the PDB from the manifest if you need to drain nodes.

## Fleet pattern: one StatefulSet per agent

Running several hermes agents on one cluster? Don't stamp out N copies of the
Deployment above with renamed resources — model each agent as a **single-replica
StatefulSet that owns its PVC via `volumeClaimTemplates`**. This is the pattern
used to run production fleets of hermes agents on EKS; the deltas over the
single-agent manifest are each load-bearing:

1. **StatefulSet, not Deployment.** The agent is operationally stateful — one
   RWO PVC, one replica, and you want the PVC owned by the controller (so it
   survives the Deployment object being deleted and isn't left orphaned). A
   single-replica StatefulSet with `updateStrategy: RollingUpdate` behaves like
   `strategy: Recreate` for rollouts (the one pod is recreated).
2. **`volumeClaimTemplates`, not a standalone PVC.** The claim provisions
   `data-<name>-0` and is bound to the pod's stable identity. Note these are
   **immutable post-create** — a storageClassName or size change requires
   deleting the StatefulSet with `--cascade=orphan` and recreating it.
3. **Headless governing Service.** `serviceName: <name>-headless` pointing at a
   `clusterIP: None` Service gives the pod stable DNS
   (`<pod>.<name>-headless.<ns>.svc`). Create it with a negative
   `argocd.argoproj.io/sync-wave` (or apply it first) so it exists before the
   pods need DNS.
4. **`args`, not `command`.** Never override the entrypoint — it sources
   `setup-env.sh` (routing git config into the persisted `~/.config` and seeding
   the gh credential helper) and reconciles `config.yaml` for the current mode.
   Set `args: ["hermes", "gateway"]` and let the ENTRYPOINT run.
5. **Container-scoped security context.** The pod-level `securityContext` does
   not propagate: add `allowPrivilegeEscalation: false`,
   `capabilities.drop: ["ALL"]`, and `seccompProfile.type: RuntimeDefault` to
   each container. Keep the pod-level `runAsNonRoot/runAsUser/runAsGroup/fsGroup`
   (UID 1000 = the image's `harness` user).
6. **`automountServiceAccountToken: false`** on the ServiceAccount unless the
   agent needs to talk to the K8s API — a long-running agent with shell access
   is exactly the workload that shouldn't carry a usable SA token by default.
7. **Dashboard sidecar.** `hermes dashboard --host 0.0.0.0 --port 9119` as a
   second container, fronted by a ClusterIP Service. Give it a `startupProbe`
   with a generous `failureThreshold` — the dashboard builds its web UI on boot,
   which can take ~40s (liveness would kill it mid-build otherwise) — plus
   liveness/readiness probes on the same route. The gateway itself is
   outbound-only (Slack socket-mode / Telegram polling) and needs no Service.
8. **Optional: secrets via CSI.** With the Secrets Store CSI Driver, a
   `SecretProviderClass` + a `csi:` volume mount can sync secrets from an
   external store (e.g. AWS SSM) into a native Secret your `secretKeyRef`s read
   — so no secret value ever lives in git. Remember the CSI caveat: the Secret
   only populates while a pod is mounting the volume.

A minimal skeleton (one agent, secrets from a plain K8s Secret):

```yaml
---
apiVersion: v1
kind: Service
metadata:
  name: hermes-claw-headless
  namespace: hermes
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
spec:
  clusterIP: None
  selector:
    app: hermes-claw
  ports:
    - name: dashboard
      port: 9119
---
apiVersion: v1
kind: Service
metadata:
  name: hermes-claw
  namespace: hermes
spec:
  selector:
    app: hermes-claw
  ports:
    - name: dashboard
      port: 9119
      targetPort: dashboard
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: hermes-sa-claw
  namespace: hermes
automountServiceAccountToken: false
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: hermes-claw
  namespace: hermes
spec:
  serviceName: hermes-claw-headless
  replicas: 1
  selector:
    matchLabels:
      app: hermes-claw
  template:
    metadata:
      labels:
        app: hermes-claw
    spec:
      terminationGracePeriodSeconds: 60
      enableServiceLinks: false
      serviceAccountName: hermes-sa-claw
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
        - name: gateway
          image: ghcr.io/boldblackai/harness:hermes-1.10.1
          imagePullPolicy: Always
          # args (NOT command) -> the image ENTRYPOINT runs first
          # (setup-env.sh + config reconcile), then execs the gateway.
          args: ["hermes", "gateway"]
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
          env:
            - name: TZ
              value: "America/New_York"
            - name: HARNESS_CLOUD_MODE
              value: "1"
            - name: HF_HOME
              value: "/home/harness/.hermes/.cache/huggingface"
            - name: OPENROUTER_API_KEY
              valueFrom:
                secretKeyRef:
                  name: hermes-secrets-claw
                  key: OPENROUTER_API_KEY
            - name: TELEGRAM_BOT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: hermes-secrets-claw
                  key: TELEGRAM_BOT_TOKEN
            - name: TELEGRAM_ALLOWED_USERS
              valueFrom:
                secretKeyRef:
                  name: hermes-secrets-claw
                  key: TELEGRAM_ALLOWED_USERS
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            seccompProfile:
              type: RuntimeDefault
          volumeMounts:
            # Same four subPaths as the single-agent manifest, but off the
            # StatefulSet's own claim (data-<name>-<ordinal>).
            - name: data
              mountPath: /home/harness/.hermes
              subPath: hermes
            - name: data
              mountPath: /home/harness/.config
              subPath: config
            - name: data
              mountPath: /home/harness/.local/share/mise
              subPath: mise-data
            - name: data
              mountPath: /home/harness/.local/state/mise
              subPath: mise-state
          resources:
            requests:
              memory: "2Gi"
              cpu: "500m"
            limits:
              memory: "4Gi"
              cpu: "2000m"
        - name: dashboard
          image: ghcr.io/boldblackai/harness:hermes-1.10.1
          imagePullPolicy: Always
          args: ["hermes", "dashboard", "--host", "0.0.0.0", "--port", "9119", "--insecure"]
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            seccompProfile:
              type: RuntimeDefault
          ports:
            - containerPort: 9119
              name: dashboard
          # startupProbe is generous because the dashboard builds its web UI
          # on boot (~40s); liveness would kill it mid-build without this.
          startupProbe:
            httpGet:
              path: /healthz
              port: dashboard
            periodSeconds: 10
            failureThreshold: 18   # ~3min
          livenessProbe:
            httpGet:
              path: /healthz
              port: dashboard
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /healthz
              port: dashboard
            periodSeconds: 5
            failureThreshold: 2
          volumeMounts:
            - name: data
              mountPath: /home/harness/.hermes
              subPath: hermes
            - name: data
              mountPath: /home/harness/.config
              subPath: config
            - name: data
              mountPath: /home/harness/.local/share/mise
              subPath: mise-data
            - name: data
              mountPath: /home/harness/.local/state/mise
              subPath: mise-state
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "2Gi"
              cpu: "1000m"
  updateStrategy:
    type: RollingUpdate
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        # Set to your cluster's StorageClass (or omit for the default).
        storageClassName: gp3
        resources:
          requests:
            storage: 10Gi
```

Notes on the skeleton:

- The four `subPath` mounts are identical to the single-agent manifest — that's
  the persistence contract of the image; only the claim source differs
  (`volumeClaimTemplates` provisions `data-hermes-claw-0`).
- `enableServiceLinks: false` keeps the pod's env clean of cluster Service
  env vars — a long-running agent that shells out and reads its environment
  will thank you.
- The gateway is single-threaded per PVC: don't scale `replicas` past 1. HA
  would need RWX storage or per-replica PVCs plus leader election hermes
  doesn't have.
- Secrets: create `hermes-secrets-claw` the same way as `k8sclaw-secrets`
  above, or wire the Secrets Store CSI Driver (point 8).

## Monitoring

```bash
# Check pod status
kubectl --namespace k8sclaw get pods

# Follow logs
kubectl --namespace k8sclaw logs -l app=k8sclaw --tail=100 -f

# Describe pod (for troubleshooting)
kubectl --namespace k8sclaw describe pod -l app=k8sclaw

# Resource usage (requires metrics-server)
kubectl --namespace k8sclaw top pod -l app=k8sclaw
```

## Teardown

```bash
kubectl delete namespace k8sclaw
```

> This removes all resources in the namespace (Deployment, PVC, Secrets, PDB).

## Customization

| What to change | Where |
|---|---|
| Image tag | `k8sclaw.yaml` → Deployment → `image` |
| Storage size | `k8sclaw.yaml` → PVC → `spec.resources.requests.storage` |
| StorageClass | `k8sclaw.yaml` → PVC → `spec.storageClassName` |
| Resource limits | `k8sclaw.yaml` → Deployment → `resources.requests/limits` |
| Timezone | `k8sclaw.yaml` → Deployment → `env TZ` |
| API keys / tokens | Update the `k8sclaw-secrets` Secret |
