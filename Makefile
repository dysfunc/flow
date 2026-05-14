.DEFAULT_GOAL := help
ANSIBLE_DIR := ansible
PLAYBOOK := cd $(ANSIBLE_DIR) && ansible-playbook -i inventory.yml

help: ## show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

plan: ## dry-run bootstrap (no changes)
	$(PLAYBOOK) playbooks/bootstrap.yml --check --diff

bootstrap: ## fresh VPS → full stack (idempotent)
	$(PLAYBOOK) playbooks/bootstrap.yml

update-openclaw: ## update OpenClaw (use OPENCLAW_VERSION=x.y.z to override pin)
	$(PLAYBOOK) playbooks/update-openclaw.yml $(if $(OPENCLAW_VERSION),-e openclaw_target_version=$(OPENCLAW_VERSION),)

rebuild-searxng: ## pull latest SearXNG image, recreate container, verify
	$(PLAYBOOK) playbooks/rebuild-searxng.yml

update-sse-proxy: ## reinstall SSE keepalive proxy from versioned files
	$(PLAYBOOK) playbooks/update-sse-proxy.yml

backup: ## tar up workspace + config to ~/backups/
	$(PLAYBOOK) playbooks/backup.yml

verify: ## health-check the whole stack
	$(PLAYBOOK) playbooks/verify.yml

lint: ## ansible-lint over all playbooks
	cd $(ANSIBLE_DIR) && ansible-lint playbooks/

.PHONY: help plan bootstrap update-openclaw rebuild-searxng update-sse-proxy backup verify lint
