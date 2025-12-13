#!/bin/bash
# Screeps Simulation Control Script
# Usage: ./scripts/sim.sh [command]

set -e
cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[sim]${NC} $1"; }
success() { echo -e "${GREEN}[sim]${NC} $1"; }
warn() { echo -e "${YELLOW}[sim]${NC} $1"; }
error() { echo -e "${RED}[sim]${NC} $1"; }

show_help() {
    cat << EOF
${BLUE}Screeps Simulation Control${NC}

Usage: ./scripts/sim.sh [command]

Commands:
  ${GREEN}start${NC}       Start the simulation server (docker-compose up)
  ${GREEN}stop${NC}        Stop the simulation server
  ${GREEN}restart${NC}     Restart the simulation server
  ${GREEN}status${NC}      Show server status
  ${GREEN}logs${NC}        Tail server logs
  ${GREEN}cli${NC}         Open Screeps server CLI
  ${GREEN}reset${NC}       Reset all game data (wipe world)
  ${GREEN}deploy${NC}      Build and deploy code to server
  ${GREEN}watch${NC}       Watch for changes and auto-deploy
  ${GREEN}add-bot${NC}     Add a test bot to the server
  ${GREEN}tick${NC}        Execute N ticks (usage: tick 100)
  ${GREEN}pause${NC}       Pause the game loop
  ${GREEN}resume${NC}      Resume the game loop
  ${GREEN}fast${NC}        Set fast tick rate (50ms)
  ${GREEN}slow${NC}        Set slow tick rate (1000ms)
  ${GREEN}bench${NC}       Run benchmark simulation

Examples:
  ./scripts/sim.sh start        # Start server
  ./scripts/sim.sh deploy       # Build and push code
  ./scripts/sim.sh cli          # Access server CLI
  ./scripts/sim.sh tick 1000    # Run 1000 ticks
EOF
}

check_docker() {
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed"
        exit 1
    fi
    if ! docker info &> /dev/null; then
        error "Docker daemon is not running"
        exit 1
    fi
}

start_server() {
    check_docker
    log "Starting Screeps simulation server..."
    docker-compose up -d
    success "Server started! Connect to localhost:21025"
    log "Waiting for server to be ready..."
    sleep 5
    log "Run './scripts/sim.sh cli' to access server console"
}

stop_server() {
    log "Stopping Screeps simulation server..."
    docker-compose down
    success "Server stopped"
}

restart_server() {
    log "Restarting Screeps simulation server..."
    docker-compose restart
    success "Server restarted"
}

show_status() {
    docker-compose ps
}

show_logs() {
    docker-compose logs -f screeps
}

open_cli() {
    log "Opening Screeps CLI..."
    log "Use 'help' for available commands, Ctrl+C to exit"
    docker-compose exec screeps screeps-launcher cli
}

reset_world() {
    warn "This will DELETE all game data!"
    read -p "Are you sure? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log "Resetting world..."
        docker-compose exec screeps screeps-launcher cli << EOF
system.resetAllData()
EOF
        success "World reset complete. Restart server with: ./scripts/sim.sh restart"
    else
        log "Aborted"
    fi
}

deploy_code() {
    log "Building code..."
    npm run build
    log "Deploying to private server..."
    npm run push-pserver
    success "Code deployed!"
}

watch_code() {
    log "Watching for changes..."
    npm run watch-pserver
}

run_ticks() {
    local count=${1:-100}
    log "Running $count ticks..."
    docker-compose exec screeps screeps-launcher cli << EOF
system.runTicks($count)
EOF
    success "Completed $count ticks"
}

pause_game() {
    log "Pausing game loop..."
    docker-compose exec screeps screeps-launcher cli << EOF
system.pauseTicks()
EOF
    success "Game paused"
}

resume_game() {
    log "Resuming game loop..."
    docker-compose exec screeps screeps-launcher cli << EOF
system.resumeTicks()
EOF
    success "Game resumed"
}

set_fast() {
    log "Setting fast tick rate (50ms)..."
    docker-compose exec screeps screeps-launcher cli << EOF
system.setTickRate(50)
EOF
    success "Tick rate set to 50ms"
}

set_slow() {
    log "Setting slow tick rate (1000ms)..."
    docker-compose exec screeps screeps-launcher cli << EOF
system.setTickRate(1000)
EOF
    success "Tick rate set to 1000ms"
}

add_test_bot() {
    local room=${1:-W1N1}
    log "Adding test bot to $room..."
    docker-compose exec screeps screeps-launcher cli << EOF
bots.spawn('simplebot', '$room')
EOF
    success "Bot spawned in $room"
}

run_benchmark() {
    log "Running benchmark simulation..."
    log "Deploying latest code..."
    npm run build && npm run push-pserver

    log "Resetting world for clean benchmark..."
    docker-compose exec screeps screeps-launcher cli << EOF
system.resetAllData()
EOF
    sleep 2

    log "Setting fast tick rate..."
    docker-compose exec screeps screeps-launcher cli << EOF
system.setTickRate(10)
EOF

    log "Running 1000 ticks..."
    local start_time=$(date +%s)
    docker-compose exec screeps screeps-launcher cli << EOF
system.runTicks(1000)
EOF
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    success "Benchmark complete: 1000 ticks in ${duration}s"
}

# Main command router
case "${1:-help}" in
    start)      start_server ;;
    stop)       stop_server ;;
    restart)    restart_server ;;
    status)     show_status ;;
    logs)       show_logs ;;
    cli)        open_cli ;;
    reset)      reset_world ;;
    deploy)     deploy_code ;;
    watch)      watch_code ;;
    add-bot)    add_test_bot "$2" ;;
    tick)       run_ticks "$2" ;;
    pause)      pause_game ;;
    resume)     resume_game ;;
    fast)       set_fast ;;
    slow)       set_slow ;;
    bench)      run_benchmark ;;
    help|--help|-h) show_help ;;
    *)
        error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac
