#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * fixture-index - measured difficulty stats for the real-room fixture library.
 *
 * Reads every fixture in test/fixtures/real-rooms/, computes terrain and
 * geometry stats using the bot's own placement/distance code, classifies each
 * room, and writes test/fixtures/real-rooms/INDEX.md.
 *
 * Classes (a room can be several):
 *   open   - wall% < 35 and every source within walk 15 of the spawn spot
 *   maze   - wall% >= 50 or any source walk > 25
 *   swampy - swamp% >= 10
 *   sk     - keeper lairs present (no controller: staging target, not a home)
 *   tunnel - a source UNREACHABLE by walking (wall-locked; road-on-wall bait)
 *
 * Usage: npm run fixtures:index
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import * as path from "path";
import { pickSpawnSpot, walkDistance } from "../src/spatial/spawnPlacement";

const DIR = path.resolve("test", "fixtures", "real-rooms");

interface Row {
  name: string;
  room: string;
  wallPct: number;
  swampPct: number;
  sources: number;
  controller: boolean;
  lairs: number;
  spawn: string;
  srcWalks: string;
  ctrlWalk: string;
  classes: string[];
}

function main(): void {
  const rows: Row[] = [];
  for (const f of readdirSync(DIR).filter(f => f.endsWith(".json")).sort()) {
    const fx = JSON.parse(readFileSync(path.join(DIR, f)).toString());
    const terrain: string[] = fx.terrain;
    const objects: any[] = fx.objects;
    const wallPct = Math.round((terrain.reduce((s, r) => s + (r.match(/#/g)?.length ?? 0), 0) / 2500) * 100);
    const swampPct = Math.round((terrain.reduce((s, r) => s + (r.match(/~/g)?.length ?? 0), 0) / 2500) * 100);
    const sources = objects.filter(o => o.type === "source");
    const controller = objects.find(o => o.type === "controller");
    const lairs = objects.filter(o => o.type === "keeperLair").length;
    const anchors = objects.filter(o => o.type === "source" || o.type === "controller");
    const spot = anchors.length ? pickSpawnSpot(terrain, anchors, objects) : null;

    const walks = spot ? sources.map(s => walkDistance(terrain, spot, s)) : [];
    const ctrlWalk = spot && controller ? walkDistance(terrain, spot, controller) : Infinity;
    const fmt = (d: number): string => (d === Infinity ? "∞" : String(d));

    const classes: string[] = [];
    if (lairs > 0) classes.push("sk");
    if (walks.some(d => d === Infinity)) classes.push("tunnel");
    if (wallPct >= 50 || walks.some(d => d !== Infinity && d > 25)) classes.push("maze");
    if (swampPct >= 10) classes.push("swampy");
    if (wallPct < 35 && walks.length > 0 && walks.every(d => d <= 15)) classes.push("open");
    if (classes.length === 0) classes.push("plain");

    rows.push({
      name: f.replace(/\.json$/, ""),
      room: fx.room,
      wallPct,
      swampPct,
      sources: sources.length,
      controller: !!controller,
      lairs,
      spawn: spot ? `${spot.x},${spot.y}` : "-",
      srcWalks: walks.map(fmt).join("/") || "-",
      ctrlWalk: fmt(ctrlWalk),
      classes
    });
  }

  const lines = [
    "# Real-room fixture index",
    "",
    "Captured live shard terrain (`npm run capture:rooms`); stats computed by",
    "`npm run fixtures:index` with the bot's own placement/distance code",
    "(src/spatial/spawnPlacement). Walk distances are BFS from the auto spawn",
    "spot; ∞ = wall-locked (tunnel candidate). SK rooms have no controller and",
    "are staging targets, not homes.",
    "",
    "| fixture | wall% | swamp% | src | ctrl | lairs | spawn | src walks | ctrl walk | classes |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      r =>
        `| ${r.name} | ${r.wallPct} | ${r.swampPct} | ${r.sources} | ${r.controller ? "y" : "-"} | ${r.lairs} | ` +
        `${r.spawn} | ${r.srcWalks} | ${r.ctrlWalk} | ${r.classes.join(" ")} |`
    ),
    ""
  ];
  writeFileSync(path.join(DIR, "INDEX.md"), lines.join("\n"));
  console.log(lines.join("\n"));
}

main();
