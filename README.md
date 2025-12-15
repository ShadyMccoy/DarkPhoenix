# Screeps Typescript Starter

Screeps Typescript Starter is a starting point for a Screeps AI written in Typescript. It provides everything you need to start writing your AI whilst leaving `main.ts` as empty as possible.

## Basic Usage

You will need:

- [Node.JS](https://nodejs.org/en/download) (10.x || 12.x)
- A Package Manager ([Yarn](https://yarnpkg.com/en/docs/getting-started) or [npm](https://docs.npmjs.com/getting-started/installing-node))
- Rollup CLI (Optional, install via `npm install -g rollup`)

Download the latest source [here](https://github.com/screepers/screeps-typescript-starter/archive/master.zip) and extract it to a folder.

Open the folder in your terminal and run your package manager to install the required packages and TypeScript declaration files:

```bash
# npm
npm install

# yarn
yarn
```

Fire up your preferred editor with typescript installed and you are good to go!

### Rollup and code upload

Screeps Typescript Starter uses rollup to compile your typescript and upload it to a screeps server.

Move or copy `screeps.sample.json` to `screeps.json` and edit it, changing the credentials and optionally adding or removing some of the destinations.

Running `rollup -c` will compile your code and do a "dry run", preparing the code for upload but not actually pushing it. Running `rollup -c --environment DEST:main` will compile your code, and then upload it to a screeps server using the `main` config from `screeps.json`.

You can use `-cw` instead of `-c` to automatically re-run when your source code changes - for example, `rollup -cw --environment DEST:main` will automatically upload your code to the `main` configuration every time your code is changed.

Finally, there are also NPM scripts that serve as aliases for these commands in `package.json` for IDE integration. Running `npm run push-main` is equivalent to `rollup -c --environment DEST:main`, and `npm run watch-sim` is equivalent to `rollup -cw --dest sim`.

#### Important! To upload code to a private server, you must have [screepsmod-auth](https://github.com/ScreepsMods/screepsmod-auth) installed and configured!

## Typings

The type definitions for Screeps come from [typed-screeps](https://github.com/screepers/typed-screeps). If you find a problem or have a suggestion, please open an issue there.

## Documentation

We've also spent some time reworking the documentation from the ground-up, which is now generated through [Gitbooks](https://www.gitbook.com/). Includes all the essentials to get you up and running with Screeps AI development in TypeScript, as well as various other tips and tricks to further improve your development workflow.

Maintaining the docs will also become a more community-focused effort, which means you too, can take part in improving the docs for this starter kit.

To visit the docs, [click here](https://screepers.gitbook.io/screeps-typescript-starter/).
# Screeps Economic AI

A Screeps AI that models a colony as a profit-seeking economy, paired with a simulation harness for rapid iteration.

## The Core Idea

Most Screeps AIs are state machines: "if energy low, spawn harvester." This works, but it's brittle. Add new features and the logic tangles. Edge cases multiply.

This project takes a different approach: **let the market decide**.

Instead of hardcoding what to do, we define *operations* (small units of work with inputs, outputs, and costs) and let economic actors compete to fund them. Good decisions emerge from price signals, not explicit rules.

## Two Systems

### 1. The Economic Framework

A hierarchy of economic actors:

```
Colony
  └── District (per room)
        └── Corp (per domain: mining, logistics, spawning, etc.)
              └── Operation (smallest executable unit)
```

- **Corps** propose plans (sets of operations) with estimated ROI
- **Districts** select and bid on the most profitable plans
- **Colony** funds winning bids and shapes demand via buy orders

Coordination happens through the market. A Mining Corp doesn't need to know about the Logistics Corp—it just offers energy for sale. If someone wants to buy, the operation runs.

### 2. The Simulation Harness

Screeps has a brutal feedback loop: 3-second ticks, outcomes that take hours to manifest. You can't iterate quickly on the live server.

The harness fixes this:

- Generate random rooms from seeds
- Run your code for thousands of ticks locally
- Measure economic performance (total ROI, profit/loss)
- Save interesting seeds as regression tests

When a seed produces low ROI, you've found a weakness. Fix it, re-run, confirm improvement.

## How They Connect

The economic framework produces natural telemetry:

- Dollar balances per Colony / District
- Profit and loss per operation type
- Bid premiums and discounts

This telemetry *is* your test oracle. You don't need to define "success" separately—low ROI means something's wrong.

```
seed → room → run 10,000 ticks → extract ROI → pass/fail
```

## Design Principles

**Emergent over explicit.** Don't hardcode "build extensions before towers." Let the market discover that extensions have higher ROI early-game.

**Tolerate failure.** Operations can fail. Districts can go bankrupt. The system recovers through taxation and competition.

**Small operations.** The smaller the operation, the more opportunities for the market to find creative combinations.

**Test via fuzzing.** Don't hand-craft test scenarios. Generate random rooms and let failures surface.

## What's Next

See the companion documents:

- `ECONOMIC_FRAMEWORK.md` — detailed breakdown of Colony, District, Corp, Operation
- `SIMULATION_HARNESS.md` — how to set up local testing with screeps-server-mockup
- `TELEMETRY.md` — what to log and how to analyze it
