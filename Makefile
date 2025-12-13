# DarkPhoenix Screeps Makefile
# Quick commands for development and testing

.PHONY: help build test sim-start sim-stop sim-cli deploy watch reset bench scenario

help:
	@echo "DarkPhoenix Development Commands"
	@echo ""
	@echo "Build & Deploy:"
	@echo "  make build      - Build the project"
	@echo "  make deploy     - Build and deploy to private server"
	@echo "  make watch      - Watch mode with auto-deploy"
	@echo ""
	@echo "Testing:"
	@echo "  make test       - Run unit tests"
	@echo "  make scenario   - Run all scenarios"
	@echo ""
	@echo "Simulation Server:"
	@echo "  make sim-start  - Start Docker server"
	@echo "  make sim-stop   - Stop Docker server"
	@echo "  make sim-cli    - Open server CLI"
	@echo "  make reset      - Reset world data"
	@echo "  make bench      - Run benchmark (1000 ticks)"
	@echo ""
	@echo "Quick Combos:"
	@echo "  make quick      - Build + deploy + run 100 ticks"
	@echo "  make full-test  - Start server + deploy + scenarios"

# Build
build:
	npm run build

# Deploy
deploy:
	./scripts/sim.sh deploy

watch:
	./scripts/sim.sh watch

# Testing
test:
	npm test

scenario:
	npm run scenario:all

# Simulation Server
sim-start:
	./scripts/sim.sh start

sim-stop:
	./scripts/sim.sh stop

sim-cli:
	./scripts/sim.sh cli

reset:
	./scripts/sim.sh reset

bench:
	./scripts/sim.sh bench

# Quick iteration
quick: build deploy
	./scripts/sim.sh tick 100

# Full test suite
full-test: sim-start
	@sleep 5
	@make deploy
	@make scenario
