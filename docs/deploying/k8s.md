# Deploying `hermes-agent` to Kubernetes

## Overview

This guide walks you through deploying [hermes-agent](https://hermes-agent.nousresearch.com/) as a
long-running "claw" (a persistent agent process) to a K8s cluster using the harness image.

## Architecture

| Component | Description |
|---|---|
| **Deployment** | Single-replica pod running `ghcr.io/boldblackai/harness:hermes-1.8.5` |
| **PVC** | 100Gi persistent volume for agent state — `.hermes`, `.config`, and mise data/state (mounted via `subPath`) |
| **PDB** | PodDisruptionBudget ensuring at least 1 pod is available |
| **Secrets** | API keys sourced from a K8s Secret (`k8sclaw-secrets`) |

## Prerequisites

- A Kubernetes cluster ≥ 1.21 (k3s or any compatible runtime)
- `kubectl` installed and configured with cluster access
- Container image access to `ghcr.io/boldblackai/harness:hermes-1.8.5`
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
| `GH_TOKEN` | GitHub personal access token for API access (e.g., PR management) |

_If you add a <space> before the following command it won't end up in your shell history._

```bash
  kubectl --namespace k8sclaw create secret generic k8sclaw-secrets \
  --from-literal=OPENROUTER_API_KEY="your-openrouter-key" \
  --from-literal=TELEGRAM_BOT_TOKEN="your-telegram-token" \
  --from-literal=TELEGRAM_ALLOWED_USERS="your-telegram-user-ids" \
  --from-literal=GH_TOKEN="your-github-token"
```

### 3. Apply the manifests

```bash
kubectl apply -f k8sclaw.yaml
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
      containers:
        - name: k8sclaw
          image: ghcr.io/boldblackai/harness:hermes-1.8.5
          imagePullPolicy: Always
          command: ["/tini", "--", "hermes", "gateway"]
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
            - name: HERMES_HOME
              value: "/home/harness/.hermes"
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
            - name: GH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: k8sclaw-secrets
                  key: GH_TOKEN
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
