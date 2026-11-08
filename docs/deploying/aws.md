# Deploying `hermes-agent` to AWS

## Overview

This guide walks you through deploying [hermes-agent](https://hermes-agent.nousresearch.com/) as a long-running "claw" (a persistent agent process) on AWS using the upstream harness image.

Choose a deployment based on how its database storage survives replacement:

| Option | When to pick it |
|---|---|
| **A. ECS on Fargate** | Storage limitations only. The former EFS recipe is unsuitable for SQLite WAL; task-managed EBS is not retained across service task replacement. |
| **B. EC2 + Docker + SSM** (recommended starting point) | Local filesystem on EBS, outbound-only networking, and Session Manager access. The example uses the root disk; use a separately retained data volume for instance replacement. |
| **C. EKS** | Use the [Kubernetes guide](k8s.md) with an EBS-backed PVC and the [AWS-specific storage and rollout settings](#c-eks). |

As with the other deploy targets, **use the upstream signed image as-is**. Do not build a derived image — see [the fly.io guide's "Customizing the claw" section](fly.md#customizing-the-claw-dont-extend-the-image) for the rationale. The EC2 example below uses host bind-mounts for customization.

## Prerequisites

- An AWS account with admin (or sufficiently scoped) credentials
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured (`aws configure`)
- The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for shell-in (`aws ssm start-session`, `aws ecs execute-command`)
- A region selected. Examples below use `us-east-1`; swap as needed.

Set a couple of shell variables used throughout:

```bash
export AWS_REGION=us-east-1
export CLAW_NAME=hermes-claw
export HARNESS_IMAGE=ghcr.io/boldblackai/harness:hermes-1.12.0
```

---

## A. ECS on Fargate

The previous Fargate recipe mounted EFS at `/home/harness/.hermes`. **Do not use that layout for Hermes's active SQLite databases.** EFS is an NFS network filesystem; SQLite's WAL mode requires a local filesystem. A single task or EFS access point does not remove that constraint. See [SQLite's WAL requirements](https://sqlite.org/wal.html) and [Amazon EFS's NFS interface](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html).

Hermes stores session state in `$HERMES_HOME/state.db` and uses WAL by default. Its [journal-mode handling](https://github.com/NousResearch/hermes-agent/blob/v0.22.2/hermes_state_wal.py) includes fallbacks for some filesystem errors, but those are not a reason to recommend EFS as the default database storage.

Fargate **does support EBS** on Linux platform version 1.4.0 and later. However, ECS creates a new task-managed volume for each task, cannot directly attach an existing volume through that mechanism, and always deletes service-managed volumes when their tasks terminate. Restoring a snapshot creates a new volume; it does not automatically preserve the latest state between service tasks. See [ECS EBS volume support and lifecycle constraints](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html).

For a persistent claw, use [EC2 with EBS](#b-ec2-with-docker-and-ssm) or [EKS with an EBS-backed PVC](#c-eks). Fargate needs a separately designed and tested backup/restore lifecycle before it can replace those options; this guide does not provide that recipe.

### Migrating an existing EFS deployment

1. Stop the gateway and every other process accessing its databases, including scheduled jobs. Prevent the old service from restarting during the migration.
2. Back up the complete `HERMES_HOME` while it is offline, preserving any remaining `-wal` and `-shm` files alongside their databases. Copying only a live `.db` file can omit committed data in its WAL. Preserve `.config` and mise data/state as well.
3. Restore onto a local filesystem on EBS, with the mounted directories writable by `harness` (`uid:gid=1000:1000`).
4. Start one gateway against the restored state. Verify existing sessions and configuration before retiring the original storage, and keep the backup for recovery.

---

## B. EC2 with Docker and SSM

The simplest possible AWS deployment: one VM, Docker, an EBS volume for state, and SSM Session Manager for shell access. No SSH keys, no inbound 22, no load balancer.

**The commands below are a single-instance starter, not a retained-volume deployment.** Its root EBS volume survives container restarts and instance stop/start, but `DeleteOnTermination=true` deletes all four state directories when the instance is terminated. Use the retained-data-volume design below when state must survive instance replacement.

### EC2 architecture

| Component | Resource |
|---|---|
| **Compute** | EC2 `t4g.small` (ARM64, 2 vCPU / 2 GiB) running Amazon Linux 2023 |
| **Storage** | 30 GiB gp3 root EBS; four bind-mount dirs for claw state (`.hermes`, `.config`, mise data/state) live on it |
| **Secrets** | AWS Secrets Manager → fetched at boot, written to a Docker `--env-file` |
| **Shell-in** | `aws ssm start-session --target i-xxx` |
| **Network** | Default VPC, public IP, **no inbound rules** — outbound only |

### Retaining state across instance replacement

For a long-lived deployment, place all four persisted paths on a separate gp3 data volume and manage its lifecycle independently of the root disk:

- Retain the volume on instance termination (`DeleteOnTermination=false`); if using CloudFormation, retain it on stack deletion/replacement as well (`DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`).
- Keep the volume and replacement instance in the [same Availability Zone](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-attaching-volume.html). Automate reattachment of that existing volume, not creation of a blank replacement.
- Mount the existing filesystem before starting the gateway, and fail startup if the mount is absent. Never format an existing data volume during bootstrap or let Docker silently create state directories on the root disk instead.
- Give the four bind-mount directories ownership `1000:1000`. Keep one gateway active; stop the old instance's workload before starting its replacement.
- Keep independent backups and test restoration. Volume retention alone is not a backup.

The same layout works with **ECS on EC2** using host bind-mounts backed by the retained data volume. Complete the attachment and mount before the host accepts tasks, and configure single-replica, stop-old-before-start-new deployments. This is distinct from ECS-managed task EBS volumes, whose service-task lifecycle is described above.

These retention and attachment steps require deployment automation beyond the starter commands below.

### 1. Store secrets in Secrets Manager

_Prefix each shell command with a single space so the secret value doesn't end up in your shell history._

```bash
 for k in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS; do
   aws secretsmanager create-secret --region "$AWS_REGION" \
     --name "${CLAW_NAME}/${k}" \
     --secret-string "REPLACE_ME"
 done
```

Then update each one with the real value:

```bash
 aws secretsmanager put-secret-value --region "$AWS_REGION" \
   --secret-id "${CLAW_NAME}/OPENROUTER_API_KEY" --secret-string "your-openrouter-key"
# repeat for TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS
```

### 2. Create the IAM instance profile

```bash
cat > /tmp/ec2-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"ec2.amazonaws.com"},
  "Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name "${CLAW_NAME}-ec2" \
  --assume-role-policy-document file:///tmp/ec2-trust.json
aws iam attach-role-policy --role-name "${CLAW_NAME}-ec2" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
cat > /tmp/ec2-secrets.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Action":["secretsmanager:GetSecretValue"],
  "Resource":"arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:${CLAW_NAME}/*"}]}
EOF
aws iam put-role-policy --role-name "${CLAW_NAME}-ec2" \
  --policy-name read-secrets --policy-document file:///tmp/ec2-secrets.json

aws iam create-instance-profile --instance-profile-name "${CLAW_NAME}-ec2"
aws iam add-role-to-instance-profile \
  --instance-profile-name "${CLAW_NAME}-ec2" --role-name "${CLAW_NAME}-ec2"
```

### 3. User data script

Save as `user-data.sh` (the `CLAW_NAME` is expanded by your shell at launch time):

```bash
#!/bin/bash
set -euxo pipefail
dnf -y update
dnf -y install docker
systemctl enable --now docker

# IMPORTANT: chown to 1000:1000 so the in-container harness user (uid 1000)
# can write to the bind-mounts. The four dirs mirror what the
# `harness` CLI bind-mounts.
mkdir -p /var/lib/hermes-claw \
         /var/lib/hermes-claw-config \
         /var/lib/hermes-claw-mise-data \
         /var/lib/hermes-claw-mise-state
chown 1000:1000 /var/lib/hermes-claw /var/lib/hermes-claw-config \
                /var/lib/hermes-claw-mise-data /var/lib/hermes-claw-mise-state

# Pull secrets into an env file (root-readable only)
umask 077
for k in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS; do
  v=$(aws --region ${AWS_REGION} secretsmanager get-secret-value \
    --secret-id "${CLAW_NAME}/$k" --query SecretString --output text)
  printf '%s=%s\n' "$k" "$v" >> /etc/hermes-claw.env
done

cat > /etc/systemd/system/hermes-claw.service <<'UNIT'
[Unit]
Description=Hermes claw
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=10
ExecStartPre=-/usr/bin/docker rm -f hermes-claw
ExecStart=/usr/bin/docker run --rm --name hermes-claw \
  --env-file /etc/hermes-claw.env \
  -e TZ=America/New_York \
  -e HARNESS_CLOUD_MODE=1 \
  -e HERMES_HOME=/home/harness/.hermes \
  -e HF_HOME=/home/harness/.hermes/.cache/huggingface \
  -v /var/lib/hermes-claw:/home/harness/.hermes \
  -v /var/lib/hermes-claw-config:/home/harness/.config \
  -v /var/lib/hermes-claw-mise-data:/home/harness/.local/share/mise \
  -v /var/lib/hermes-claw-mise-state:/home/harness/.local/state/mise \
  ghcr.io/boldblackai/harness:hermes-1.12.0 \
  hermes gateway
ExecStop=/usr/bin/docker stop hermes-claw

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now hermes-claw
```

### 4. Launch the instance

```bash
AMI_ID=$(aws ssm get-parameters --region "$AWS_REGION" \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query 'Parameters[0].Value' --output text)

# Minimal security group: no inbound, all outbound (default).
SG_ID=$(aws ec2 create-security-group --region "$AWS_REGION" \
  --group-name "${CLAW_NAME}-sg" --description "${CLAW_NAME}" \
  --query 'GroupId' --output text)

INSTANCE_ID=$(aws ec2 run-instances --region "$AWS_REGION" \
  --image-id "$AMI_ID" --instance-type t4g.small \
  --security-group-ids "$SG_ID" \
  --iam-instance-profile Name="${CLAW_NAME}-ec2" \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
  --user-data file://user-data.sh \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${CLAW_NAME}}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "Launched $INSTANCE_ID"
```

### EC2 monitoring

```bash
# Wait for SSM agent to register (~30-60s)
aws ssm describe-instance-information --region "$AWS_REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID"

# Shell into the box — no SSH key, no port 22
aws ssm start-session --region "$AWS_REGION" --target "$INSTANCE_ID"

# Once inside: check the container
sudo journalctl -u hermes-claw -f
sudo docker logs -f hermes-claw
```

### EC2 GitHub authentication

To use `gh` (or HTTPS git) from inside the claw, authenticate once — the session persists in `~/.config` (on the host bind-mount), so it survives restarts. See [GitHub authentication](../github.md) for creating a PAT.

SSM lands you on the **host** (as root); run the login inside the container as the `harness` user via `docker exec`, piping the token over stdin:

```bash
aws ssm start-session --region "$AWS_REGION" --target "$INSTANCE_ID"
# on the host (leading space keeps the PAT out of shell history):
 echo "<your-github-pat>" | sudo docker exec -i -u harness hermes-claw gh auth login --with-token
sudo docker exec -u harness hermes-claw gh auth status
```

### EC2 customization

Drop files onto the EBS volume directly (it's just a host bind-mount):

```bash
# Via SSM, no SSH:
aws ssm start-session --region "$AWS_REGION" --target "$INSTANCE_ID"
sudo cp /tmp/system-prompt.md /var/lib/hermes-claw/system-prompt.md
sudo systemctl restart hermes-claw
```

To pin a newer harness image, edit the systemd unit (`/etc/systemd/system/hermes-claw.service`) and `systemctl daemon-reload && systemctl restart hermes-claw`. As with all other targets — **don't build a derived image**.

### EC2 teardown

**This deletes the starter instance's root volume and its agent state.** Back up any state you need before terminating it. If you implemented a separate retained data volume, it remains billable until explicitly deleted.

```bash
aws ec2 terminate-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-terminated --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
aws ec2 delete-security-group --region "$AWS_REGION" --group-id "$SG_ID"
aws iam remove-role-from-instance-profile \
  --instance-profile-name "${CLAW_NAME}-ec2" --role-name "${CLAW_NAME}-ec2"
aws iam delete-instance-profile --instance-profile-name "${CLAW_NAME}-ec2"
aws iam delete-role-policy --role-name "${CLAW_NAME}-ec2" --policy-name read-secrets
aws iam detach-role-policy --role-name "${CLAW_NAME}-ec2" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role --role-name "${CLAW_NAME}-ec2"
# Schedule secret deletion only when retiring this claw permanently.
for k in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS; do
  aws secretsmanager delete-secret --region "$AWS_REGION" \
    --secret-id "${CLAW_NAME}/${k}" --recovery-window-in-days 7
done
```

---

## C. EKS

Start from the [Kubernetes manifest](k8s.md#all-in-one-k8sclawyaml), with these AWS-specific settings:

- Install/configure the [EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html) and explicitly select an EBS-backed `StorageClass` for the PVC. Keep `accessModes: [ReadWriteOnce]`. Do not assume the cluster's default class uses EBS.
- Keep `replicas: 1` and set the Deployment's `spec.strategy.type: Recreate` so an update stops the old gateway before starting the new one. `ReadWriteOnce` alone does not prevent two pods on the same node from accessing the volume.
- Use a `Retain` reclaim policy if storage must survive PVC deletion, and maintain backups. Check the bound PV's actual policy before deleting a claim.
- Do not switch the database volume to EFS/`ReadWriteMany` for multiple replicas. Network storage does not satisfy SQLite WAL's requirements, and sharing a gateway's state across replicas needs a separate application design.

Secrets and `kubectl exec` remain as described in the Kubernetes guide.

## Why not Elastic Beanstalk, Amplify, App Runner, Lambda?

Briefly, for the curious:

- **App Runner** — closest to fly.io semantically, but [no persistent volume support](https://docs.aws.amazon.com/apprunner/latest/dg/architecture.html). Hermes' `~/.hermes` state (sessions, memories, faster-whisper cache) wouldn't survive restarts.
- **Elastic Beanstalk** — designed for traditional web apps with ELB/ASG/EC2 abstractions you don't need for a single-replica long-running bot. AWS's strategic container direction has moved to ECS and App Runner.
- **Amplify** — full-stack web hosting (React/Next + auth + GraphQL + storage). Wrong product entirely for a long-running container with outbound Telegram polling.
- **Lambda** — 15-minute execution cap, no persistent state, no long-running process. Hermes is a daemon, not a function.
