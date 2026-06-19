# Deploying `hermes-agent` to AWS

## Overview

This guide walks you through deploying [hermes-agent](https://hermes-agent.nousresearch.com/) as a long-running "claw" (a persistent agent process) on AWS using the upstream harness image.

Two paths are documented:

| Option | When to pick it |
|---|---|
| **A. ECS on Fargate** (recommended) | Production-ish use. Managed compute, persistent state on EFS, secrets from Secrets Manager, shell-in via `aws ecs execute-command` (SSM Session Manager under the hood). Closest 1:1 mapping to the [fly.io](deploying-to-fly.md) and [Kubernetes](deploying-to-k8s.md) deployments. |
| **B. EC2 + Docker + SSM** | Single-VM hobbyist deployment. ~$13/mo on a `t4g.small`, EBS for persistence, SSM Session Manager replaces SSH (no keys, no inbound 22). Simplest possible AWS path. |
| **C. EKS** | Already running EKS? The [Kubernetes guide](deploying-to-k8s.md) works on EKS unmodified — see [§ EKS](#c-eks) below for the one AWS-specific note. |

As with the other deploy targets, **use the upstream signed image as-is**. Do not build a derived image — see [the fly.io guide's "Customizing the claw" section](deploying-to-fly.md#customizing-the-claw--dont-extend-the-image) for the rationale. AWS-equivalent injection points for both options are covered below.

## Prerequisites

- An AWS account with admin (or sufficiently scoped) credentials
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured (`aws configure`)
- The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for shell-in (`aws ssm start-session`, `aws ecs execute-command`)
- A region selected. Examples below use `us-east-1`; swap as needed.

Set a couple of shell variables used throughout:

```bash
export AWS_REGION=us-east-1
export CLAW_NAME=hermes-claw
export HARNESS_IMAGE=ghcr.io/boldblackai/harness:hermes-1.8.4
```

---

## A. ECS on Fargate

### Fargate architecture

| Component | Resource |
|---|---|
| **Compute** | Fargate task (1 vCPU / 2 GiB), single-replica service |
| **Storage** | EFS file system + access point mounted at `/home/harness/.hermes-openrouter` |
| **Secrets** | AWS Secrets Manager → injected as env vars via task definition `secrets[]` |
| **Logs** | CloudWatch Logs (`/ecs/${CLAW_NAME}`) |
| **Shell-in** | `aws ecs execute-command` (uses SSM Session Manager) |
| **Network** | Default VPC, public subnet, `assignPublicIp: ENABLED` (outbound-only; no load balancer) |

### 1. Create the CloudWatch log group

```bash
aws logs create-log-group --region "$AWS_REGION" --log-group-name "/ecs/${CLAW_NAME}"
```

### 2. Store secrets in Secrets Manager

_Prefix each shell command with a single space so the secret value doesn't end up in your shell history._

```bash
 for k in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS GH_TOKEN; do
   aws secretsmanager create-secret --region "$AWS_REGION" \
     --name "${CLAW_NAME}/${k}" \
     --secret-string "REPLACE_ME"
 done
```

Then update each one with the real value:

```bash
 aws secretsmanager put-secret-value --region "$AWS_REGION" \
   --secret-id "${CLAW_NAME}/OPENROUTER_API_KEY" --secret-string "your-openrouter-key"
# repeat for TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS, GH_TOKEN
```

> SSM Parameter Store (`SecureString`) works too if you prefer it over Secrets Manager — just swap `secretsmanager:GetSecretValue` for `ssm:GetParameters` in the execution-role policy and reference the parameter ARN in the task definition.

### 3. Create EFS for persistent state

Hermes stores sessions, memories, skills, the faster-whisper model cache, and `config.yaml` under `/home/harness/.hermes-openrouter`. EFS is the right primitive: it survives task restarts, supports the `uid:gid=1000:1000` non-root `harness` user, and works across AZs.

```bash
EFS_ID=$(aws efs create-file-system --region "$AWS_REGION" \
  --performance-mode generalPurpose --throughput-mode bursting \
  --tags Key=Name,Value="${CLAW_NAME}-data" \
  --query 'FileSystemId' --output text)

# Create an access point that maps everything to uid/gid 1000 (the harness user)
EFS_AP_ID=$(aws efs create-access-point --region "$AWS_REGION" \
  --file-system-id "$EFS_ID" \
  --posix-user Uid=1000,Gid=1000 \
  --root-directory '{"Path":"/hermes-openrouter","CreationInfo":{"OwnerUid":1000,"OwnerGid":1000,"Permissions":"0755"}}' \
  --query 'AccessPointId' --output text)

echo "EFS_ID=$EFS_ID  EFS_AP_ID=$EFS_AP_ID"
```

Create a mount target in each subnet your task can run in, and a security group that allows NFS (TCP 2049) from your task's security group. The minimal setup (default VPC, one subnet, one SG used by both EFS and the task):

```bash
VPC_ID=$(aws ec2 describe-vpcs --region "$AWS_REGION" \
  --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
# Pick a subnet in an AZ that supports ARM64 Fargate. In us-east-1 specifically,
# us-east-1e and us-east-1f do NOT support ARM64 Fargate — picking Subnets[0]
# blindly will fail intermittently with "The required capabilities cannot be
# supported on requested platform". The filter below restricts to AZs a/b/c/d.
# If you set `cpuArchitecture: X86_64` in the task definition, this caveat
# doesn't apply and you can drop the filter.
SUBNET_ID=$(aws ec2 describe-subnets --region "$AWS_REGION" \
  --filters Name=vpc-id,Values="$VPC_ID" Name=default-for-az,Values=true \
  --query "Subnets[?ends_with(AvailabilityZone, \`a\`) || ends_with(AvailabilityZone, \`b\`) || ends_with(AvailabilityZone, \`c\`) || ends_with(AvailabilityZone, \`d\`)] | [0].SubnetId" \
  --output text)

SG_ID=$(aws ec2 create-security-group --region "$AWS_REGION" \
  --group-name "${CLAW_NAME}-sg" --description "${CLAW_NAME}" --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text)
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" \
  --group-id "$SG_ID" --protocol tcp --port 2049 --source-group "$SG_ID"

aws efs create-mount-target --region "$AWS_REGION" \
  --file-system-id "$EFS_ID" --subnet-id "$SUBNET_ID" --security-groups "$SG_ID"
```

### 4. Create IAM roles

Two roles are needed:

- **Task execution role** — used by the ECS agent to pull the image, read secrets, and write logs.
- **Task role** — used by the container itself; needs SSM Messages permissions so `aws ecs execute-command` works.

```bash
# Trust policy reused by both roles
cat > /tmp/ecs-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"ecs-tasks.amazonaws.com"},
  "Action":"sts:AssumeRole"}]}
EOF

# Execution role
aws iam create-role --role-name "${CLAW_NAME}-exec" \
  --assume-role-policy-document file:///tmp/ecs-trust.json
aws iam attach-role-policy --role-name "${CLAW_NAME}-exec" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
cat > /tmp/exec-secrets.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Action":["secretsmanager:GetSecretValue"],
  "Resource":"arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:${CLAW_NAME}/*"}]}
EOF
aws iam put-role-policy --role-name "${CLAW_NAME}-exec" \
  --policy-name read-secrets --policy-document file:///tmp/exec-secrets.json

# Task role (for ECS Exec / SSM Session Manager)
aws iam create-role --role-name "${CLAW_NAME}-task" \
  --assume-role-policy-document file:///tmp/ecs-trust.json
cat > /tmp/task-ssm.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Action":["ssmmessages:CreateControlChannel","ssmmessages:CreateDataChannel",
            "ssmmessages:OpenControlChannel","ssmmessages:OpenDataChannel"],
  "Resource":"*"}]}
EOF
aws iam put-role-policy --role-name "${CLAW_NAME}-task" \
  --policy-name ecs-exec --policy-document file:///tmp/task-ssm.json
```

### 5. Register the task definition

Save this as `taskdef.json` (substitute `<ACCOUNT_ID>`, `<AWS_REGION>`, `<EFS_ID>`, `<EFS_AP_ID>`):

```json
{
  "family": "hermes-claw",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "runtimePlatform": { "operatingSystemFamily": "LINUX", "cpuArchitecture": "ARM64" },
  "executionRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/hermes-claw-exec",
  "taskRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/hermes-claw-task",
  "containerDefinitions": [{
    "name": "hermes",
    "image": "ghcr.io/boldblackai/harness:hermes-1.8.4",
    "essential": true,
    "command": ["hermes", "gateway"],
    "user": "1000:1000",
    "linuxParameters": { "initProcessEnabled": true },
    "environment": [
      { "name": "TZ", "value": "America/New_York" },
      { "name": "HERMES_HOME", "value": "/home/harness/.hermes-openrouter" },
      { "name": "HF_HOME", "value": "/home/harness/.hermes-openrouter/.cache/huggingface" }
    ],
    "secrets": [
      { "name": "OPENROUTER_API_KEY",    "valueFrom": "arn:aws:secretsmanager:<AWS_REGION>:<ACCOUNT_ID>:secret:hermes-claw/OPENROUTER_API_KEY" },
      { "name": "TELEGRAM_BOT_TOKEN",    "valueFrom": "arn:aws:secretsmanager:<AWS_REGION>:<ACCOUNT_ID>:secret:hermes-claw/TELEGRAM_BOT_TOKEN" },
      { "name": "TELEGRAM_ALLOWED_USERS","valueFrom": "arn:aws:secretsmanager:<AWS_REGION>:<ACCOUNT_ID>:secret:hermes-claw/TELEGRAM_ALLOWED_USERS" },
      { "name": "GH_TOKEN",              "valueFrom": "arn:aws:secretsmanager:<AWS_REGION>:<ACCOUNT_ID>:secret:hermes-claw/GH_TOKEN" }
    ],
    "mountPoints": [{
      "sourceVolume": "hermes-data",
      "containerPath": "/home/harness/.hermes-openrouter",
      "readOnly": false
    }],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/hermes-claw",
        "awslogs-region": "<AWS_REGION>",
        "awslogs-stream-prefix": "hermes"
      }
    }
  }],
  "volumes": [{
    "name": "hermes-data",
    "efsVolumeConfiguration": {
      "fileSystemId": "<EFS_ID>",
      "transitEncryption": "ENABLED",
      "authorizationConfig": { "accessPointId": "<EFS_AP_ID>", "iam": "DISABLED" }
    }
  }]
}
```

> The image is published for both `linux/amd64` and `linux/arm64`. ARM64 Fargate is ~20% cheaper — leave `cpuArchitecture` as `ARM64` unless you have a reason not to. (In `us-east-1`, only AZs `a`/`b`/`c`/`d` support ARM64 Fargate; the subnet picker above filters accordingly.)

Register it:

```bash
aws ecs register-task-definition --region "$AWS_REGION" \
  --cli-input-json file://taskdef.json
```

### 6. Create the cluster and service

```bash
aws ecs create-cluster --region "$AWS_REGION" --cluster-name "${CLAW_NAME}"

aws ecs create-service --region "$AWS_REGION" \
  --cluster "${CLAW_NAME}" \
  --service-name "${CLAW_NAME}" \
  --task-definition hermes-claw \
  --desired-count 1 \
  --launch-type FARGATE \
  --enable-execute-command \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_ID}],securityGroups=[${SG_ID}],assignPublicIp=ENABLED}"
```

`--enable-execute-command` is the toggle that makes `aws ecs execute-command` work below — it cannot be enabled retroactively on a running service without an update + new deployment.

> **First-task timing.** Initial task placement typically takes 2–3 minutes — most of that is the ~500 MB image pull from `ghcr.io`. If you see a transient `CannotPullContainerError` in the service events (`describe-services --query 'services[0].events'`), don't panic: ECS automatically stops the failed task and starts a fresh one. Persistent failures usually mean a real problem (subnet/SG/IAM/image-not-found).

### Fargate monitoring

```bash
# List running tasks
aws ecs list-tasks --region "$AWS_REGION" --cluster "${CLAW_NAME}"

# Tail logs
aws logs tail --region "$AWS_REGION" "/ecs/${CLAW_NAME}" --follow

# Shell into the container (uses SSM Session Manager)
TASK_ARN=$(aws ecs list-tasks --region "$AWS_REGION" --cluster "${CLAW_NAME}" \
  --query 'taskArns[0]' --output text)
aws ecs execute-command --region "$AWS_REGION" \
  --cluster "${CLAW_NAME}" --task "$TASK_ARN" \
  --container hermes --interactive --command "/bin/bash"
```

> **Exec sessions run as root.** `aws ecs execute-command` opens a **root** shell inside the container by default, even though the workload (PID 1) runs as the `harness` user (uid 1000). If you need to verify or debug behavior as the harness user (e.g. confirming a mount is writable from the workload's perspective, not just root's), prefix the command with `runuser -u harness --`. To verify the workload's actual user from outside, use `stat -c %u /proc/1` — checking `id -u` inside the exec session will report root.

### Fargate customization (no derived image)

The fly.io guide's [`[[files]]` injection pattern](deploying-to-fly.md#customizing-the-claw--dont-extend-the-image) translates to two AWS techniques:

- **Runtime-mutable files (config, persona, persistent skills)** — seed them once on the EFS volume, then let hermes own them. Either `aws ecs execute-command` into a running task and `cp` them into place, or run a one-off Fargate task with the same EFS mount that drops files into `/etc/harness/hermes-defaults/openrouter/` before the gateway starts. The base image's `entrypoint-hermes.sh` does `cp -rn` from `/etc/harness/hermes-defaults/openrouter/` into the volume on first boot only — same first-boot-only semantics as fly.
- **Tool wrappers / scripts (refreshed every deploy)** — bake them into a tiny sidecar layer published to ECR `FROM scratch`, mount it via a shared `bind` volume between an `initContainer`-style sidecar (using `dependsOn: { condition: COMPLETE }`) and the hermes container. Or: store them in S3 and `aws s3 sync` them in via a startup hook. Avoid `FROM ghcr.io/boldblackai/harness` — see the fly doc for why.

### Fargate teardown

```bash
aws ecs update-service --region "$AWS_REGION" --cluster "${CLAW_NAME}" \
  --service "${CLAW_NAME}" --desired-count 0
aws ecs delete-service --region "$AWS_REGION" --cluster "${CLAW_NAME}" \
  --service "${CLAW_NAME}" --force
aws ecs delete-cluster --region "$AWS_REGION" --cluster "${CLAW_NAME}"
aws efs delete-mount-target --mount-target-id <MT_ID>   # from describe-mount-targets
aws efs delete-access-point --access-point-id "$EFS_AP_ID"
aws efs delete-file-system --file-system-id "$EFS_ID"
aws ec2 delete-security-group --group-id "$SG_ID"
aws logs delete-log-group --region "$AWS_REGION" --log-group-name "/ecs/${CLAW_NAME}"
for k in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS GH_TOKEN; do
  aws secretsmanager delete-secret --region "$AWS_REGION" \
    --secret-id "${CLAW_NAME}/${k}" --force-delete-without-recovery
done
aws iam delete-role-policy --role-name "${CLAW_NAME}-exec" --policy-name read-secrets
aws iam detach-role-policy --role-name "${CLAW_NAME}-exec" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name "${CLAW_NAME}-exec"
aws iam delete-role-policy --role-name "${CLAW_NAME}-task" --policy-name ecs-exec
aws iam delete-role --role-name "${CLAW_NAME}-task"
```

---

## B. EC2 + Docker + SSM

The simplest possible AWS deployment: one VM, Docker, an EBS volume for state, and SSM Session Manager for shell access. No SSH keys, no inbound 22, no load balancer. Roughly $13/mo on a `t4g.small`.

### EC2 architecture

| Component | Resource |
|---|---|
| **Compute** | EC2 `t4g.small` (ARM64, 2 vCPU / 2 GiB) running Amazon Linux 2023 |
| **Storage** | 30 GiB gp3 root EBS for the Docker volume (`/var/lib/hermes-claw`) |
| **Secrets** | AWS Secrets Manager → fetched at boot, written to a Docker `--env-file` |
| **Shell-in** | `aws ssm start-session --target i-xxx` |
| **Network** | Default VPC, public IP, **no inbound rules** — outbound only |

### 1. Store secrets in Secrets Manager

Identical to [Option A § 2](#2-store-secrets-in-secrets-manager).

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
# can write to the bind-mount. Without this, entrypoint-hermes.sh's `cp -rn`
# first-boot seed fails with "Permission denied" and the systemd unit
# crash-loops.
mkdir -p /var/lib/hermes-claw
chown 1000:1000 /var/lib/hermes-claw

# Pull secrets into an env file (root-readable only)
umask 077
for k in OPENROUTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS GH_TOKEN; do
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
  -e HERMES_HOME=/home/harness/.hermes-openrouter \
  -e HF_HOME=/home/harness/.hermes-openrouter/.cache/huggingface \
  -v /var/lib/hermes-claw:/home/harness/.hermes-openrouter \
  ghcr.io/boldblackai/harness:hermes-1.8.4 \
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
# Plus the Secrets Manager cleanup loop from Option A's teardown.
```

---

## C. EKS

The [Kubernetes manifest](deploying-to-k8s.md#all-in-one-k8sclawyaml) deploys on EKS unmodified. One AWS-specific note:

- The PVC's `accessModes: [ReadWriteOnce]` works with the [EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html), which most EKS clusters ship with as the default `StorageClass` (`gp2` or `gp3`). If you need `ReadWriteMany` (e.g. for a future multi-replica setup), switch to the [EFS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/efs-csi.html) and a `ReadWriteMany` `StorageClass`.

Everything else — Secrets, Deployment, PDB, `kubectl exec` for shell-in — is portable from any K8s cluster.

## Why not Elastic Beanstalk, Amplify, App Runner, Lambda?

Briefly, for the curious:

- **App Runner** — closest to fly.io semantically, but [no persistent volume support](https://docs.aws.amazon.com/apprunner/latest/dg/architecture.html). Hermes' `~/.hermes-openrouter` state (sessions, memories, faster-whisper cache) wouldn't survive restarts.
- **Elastic Beanstalk** — designed for traditional web apps with ELB/ASG/EC2 abstractions you don't need for a single-replica long-running bot. AWS's strategic container direction has moved to ECS and App Runner.
- **Amplify** — full-stack web hosting (React/Next + auth + GraphQL + storage). Wrong product entirely for a long-running container with outbound Telegram polling.
- **Lambda** — 15-minute execution cap, no persistent state, no long-running process. Hermes is a daemon, not a function.
