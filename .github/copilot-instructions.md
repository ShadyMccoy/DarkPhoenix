# AI Coding Guidelines for DarkPhoenix Screeps AI

## Architecture Overview
This is a colony-based Screeps AI where each `Colony` manages multiple rooms. Colonies contain `Node`s (key strategic points) that run `Agent`s executing `Routine`s. Routines define creep behaviors with body part requirements and outputs.

- **Entry Point**: `src/main.ts` manages colony lifecycle per tick
- **Core Classes**: `Colony` (`src/Colony.ts`), `Node` (`src/Node.ts`), `Agent` (`src/Agent.ts`)
- **Routines**: Extend `NodeAgentRoutine` (`src/routines/NodeAgentRoutine.ts`) with requirements/outputs
- **Geography**: `RoomGeography` (`src/RoomGeography.ts`) analyzes rooms into node networks stored in `Memory.nodeNetwork`

## Key Patterns
- **Memory Persistence**: Use `Memory` global for cross-tick state. Colonies in `Memory.colonies`, nodes in `Memory.nodeNetwork`
- **Error Handling**: Wrap logic in try-catch, use `ErrorMapper` (`src/ErrorMapper.ts`) for readable stack traces
- **Node Territory**: Each node has assigned `territory` (RoomPosition array) for resource management
- **Routine Assets**: Routines require specific creep body parts; agents spawn creeps to match `requirements`

## Development Workflow
- **Build**: `npm run build` (webpack) or `rollup -c` for bundling to `dist/main.js`
- **Upload**: `npm run push-main` uploads to Screeps server via rollup plugin
- **Watch Mode**: `npm run watch-sim` for auto-upload during development
- **Test**: `npm run test-unit` runs Mocha tests in `test/unit/`
- **Lint**: `npm run lint` checks TypeScript with ESLint

## Conventions
- **Imports**: Use relative paths from `src/`, e.g., `import { Colony } from "./Colony"`
- **Memory Types**: Define interfaces in `src/types/global.d.ts` for `Memory` extensions
- **Config**: Edit `screeps.json` for upload destinations; copy from `screeps.sample.json`
- **Node IDs**: Format as `{roomName}-{x}-{y}` for unique identification

## Examples
- Creating a colony: `const colony = new Colony(rootRoom); activeColonies.set(colony.id, colony);`
- Adding routine: `agent.addRoutine(new HarvestRoutine(node));`
- Checking vision: `if (Game.rooms[roomName]) { RoomGeography.updateNetwork(room); }`
