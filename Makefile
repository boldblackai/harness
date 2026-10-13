REGISTRY := ghcr.io/boldblackai/harness
ARCH ?= $(shell uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')

build:
	pnpm build

image-base:
	docker build --build-arg TARGETARCH=$(ARCH) -t $(REGISTRY):latest .

image-opencode:
	docker build --build-arg BASE_IMAGE=$(REGISTRY):latest --build-arg TARGETARCH=$(ARCH) -t $(REGISTRY):opencode-latest -f Dockerfile.opencode .

image-hermes:
	docker build --build-arg BASE_IMAGE=$(REGISTRY):latest --build-arg TARGETARCH=$(ARCH) -t $(REGISTRY):hermes-latest -f Dockerfile.hermes .

image-egress-proxy:
	docker build --build-arg TARGETARCH=$(ARCH) -t $(REGISTRY):egress-proxy-latest -f Dockerfile.egress-proxy .

image: image-base image-opencode image-hermes image-egress-proxy

.PHONY: build image image-base image-opencode image-hermes image-egress-proxy
