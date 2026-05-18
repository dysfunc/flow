.DEFAULT_GOAL := help
ANSIBLE_DIR := ansible
PLAYBOOK := cd $(ANSIBLE_DIR) && ansible-playbook -i inventory.yml

help: ## show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

bootstrap-prereqs: ## install ansible + collections (run once on fresh VPS)
	sudo apt update && sudo apt install -y ansible
	cd $(ANSIBLE_DIR) && ansible-galaxy collection install -r requirements.yml

plan: ## dry-run bootstrap (no changes)
	$(PLAYBOOK) playbooks/bootstrap.yml --check --diff

bootstrap: ## fresh VPS → full stack (idempotent)
	$(PLAYBOOK) playbooks/bootstrap.yml

update-openclaw: ## update OpenClaw (use OPENCLAW_VERSION=x.y.z to override pin)
	$(PLAYBOOK) playbooks/update-openclaw.yml $(if $(OPENCLAW_VERSION),-e openclaw_target_version=$(OPENCLAW_VERSION),)

rebuild-searxng: ## pull latest SearXNG image, recreate container, verify
	$(PLAYBOOK) playbooks/rebuild-searxng.yml

update-sse-proxy: ## reinstall SSE keepalive proxy (legacy, kept masked as fallback)
	$(PLAYBOOK) playbooks/update-sse-proxy.yml

update-gateway-proxy: ## reinstall the live gateway-proxy (identity stamping + SSE keepalive on :8444)
	cd $(ANSIBLE_DIR) && ansible-playbook -i inventory.yml playbooks/bootstrap.yml --tags gateway_proxy

unmask-sse-proxy-fallback: ## EMERGENCY: gateway-proxy is broken — bring sse-proxy up on :8444 instead
	@echo "This will stop gateway-proxy and start sse-proxy as the :8444 listener."
	@echo "Run 'make remask-sse-proxy-fallback' to revert once gateway-proxy is fixed."
	@read -p "Continue? [y/N] " yn && [ "$$yn" = "y" ] || exit 1
	sudo systemctl stop openclaw-gateway-proxy.service
	sudo systemctl unmask openclaw-sse-proxy.service openclaw-sse-proxy-healthcheck.timer openclaw-sse-proxy-logrotate.timer
	sudo systemctl start openclaw-sse-proxy.service
	sudo systemctl start openclaw-sse-proxy-healthcheck.timer openclaw-sse-proxy-logrotate.timer
	@echo "sse-proxy fallback is now serving :8444. Debug gateway-proxy at your leisure."

remask-sse-proxy-fallback: ## revert unmask-sse-proxy-fallback: stop sse-proxy, restore gateway-proxy on :8444
	sudo systemctl stop openclaw-sse-proxy-healthcheck.timer openclaw-sse-proxy-logrotate.timer openclaw-sse-proxy.service
	sudo systemctl mask openclaw-sse-proxy.service openclaw-sse-proxy-healthcheck.timer openclaw-sse-proxy-logrotate.timer
	sudo systemctl start openclaw-gateway-proxy.service
	@echo "gateway-proxy is back on :8444. sse-proxy re-masked."

backup: ## tar up workspace + config to ~/backups/
	$(PLAYBOOK) playbooks/backup.yml

verify: ## health-check the whole stack
	$(PLAYBOOK) playbooks/verify.yml

lint: ## ansible-lint over all playbooks
	cd $(ANSIBLE_DIR) && ansible-lint playbooks/

.PHONY: help bootstrap-prereqs plan bootstrap update-openclaw rebuild-searxng update-sse-proxy update-gateway-proxy unmask-sse-proxy-fallback remask-sse-proxy-fallback backup verify lint
