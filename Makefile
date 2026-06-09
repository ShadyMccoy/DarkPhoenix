# DarkPhoenix Screeps Makefile
# Quick commands for development and testing

.PHONY: help install build lint test test-unit test-integration push-main

help:
	@echo "DarkPhoenix Development Commands"
	@echo ""
	@echo "Setup:"
	@echo "  make install          - Install dependencies"
	@echo ""
	@echo "Build & Deploy:"
	@echo "  make build            - Build the project (dist/main.js)"
	@echo "  make lint             - Lint the source"
	@echo "  make push-main        - Deploy to the main Screeps server"
	@echo ""
	@echo "Testing (local verification, no Docker / Steam key required):"
	@echo "  make test             - Run unit + integration tests"
	@echo "  make test-unit        - Run fast unit tests"
	@echo "  make test-integration - Build, then run the bot against an in-process Screeps engine"

# Setup
install:
	npm install

# Build
build:
	npm run build

lint:
	npm run lint

push-main:
	npm run push-main

# Testing
test:
	npm test

test-unit:
	npm run test-unit

test-integration:
	npm run test-integration
