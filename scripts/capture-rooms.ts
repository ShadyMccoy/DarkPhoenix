#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * capture-rooms - snapshot REAL game-world rooms into local sim fixtures.
 *
 * Fetches terrain + room objects from the public Screeps Web API and writes
 * one JSON fixture per room to test/fixtures/real-rooms/. The fixture is a
 * loadLayout RoomLayout (ASCII terrain rows + scenery objects) plus metadata,
 * so sims and grid worlds consume it with ZERO loader changes.
 *
 * Both endpoints are public for map data - no token needed. If SCREEPS_TOKEN
 * is set it is sent anyway (private servers may require it).
 *
 * Usage:
 *   npm run capture:rooms -- --shard shard3 W1N8 W2N8 W1N7
 *   npm run capture:rooms -- --shard shard3 --around W5N8   # room + 8 neighbours
 *
 * Capture a CONTIGUOUS cluster with real names: adjacency is derived from the
 * names, so a captured block drops straight into a multi-room sim
 * (scripts/sim-real-rooms.ts) with working exits.
 */
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";

// Node 18+ global fetch; the test tsconfig has no DOM lib, so declare it.
declare const fetch: (url: string, init?: any) => Promise<any>;

const API = process.env.SCREEPS_API_URL ?? "https://screeps.com/api";
const OUT_DIR = path.resolve("test", "fixtures", "real-rooms");
/** Screeps API etiquette: stay well under the rate limit. */
const CALL_GAP_MS = 600;

/** Game terrain encoding -> the repo's ASCII tiles (3 = wall|swamp -> wall). */
const CHAR: Record<string, string> = { "0": ".", "1": "#", "2": "~", "3": "#" };

/** Scenery the local loader understands; player structures are deliberately dropped. */
const KEEP_TYPES = new Set(["source", "controller", "mineral", "keeperLair"]);

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function apiGet(pathAndQuery: string): Promise<any> {
  const headers: Record<string, string> = {};
  if (process.env.SCREEPS_TOKEN) headers["X-Token"] = process.env.SCREEPS_TOKEN;
  const res = await fetch(`${API}${pathAndQuery}`, { headers });
  if (res.status === 429) {
    await sleep(3000);
    return apiGet(pathAndQuery);
  }
  if (!res.ok) throw new Error(`GET ${pathAndQuery} -> HTTP ${res.status}`);
  const body = (await res.json()) as any;
  if (body.ok !== 1) throw new Error(`GET ${pathAndQuery} -> ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** 2500-char game string -> 50 ASCII rows (row-major, y*50+x). */
function decodeTerrain(encoded: string): string[] {
  if (encoded.length !== 2500) throw new Error(`terrain string is ${encoded.length} chars, expected 2500`);
  const rows: string[] = [];
  for (let y = 0; y < 50; y++) {
    let row = "";
    for (let x = 0; x < 50; x++) row += CHAR[encoded[y * 50 + x]] ?? "#";
    rows.push(row);
  }
  return rows;
}

/** The 8 neighbours of a room name plus the room itself (--around). */
function around(room: string): string[] {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(room);
  if (!m) throw new Error(`bad room name: ${room}`);
  const [, h, xs, v, ys] = m;
  const toX = (n: number): string => (n < 0 ? `${h === "W" ? "E" : "W"}${-n - 1}` : `${h}${n}`);
  const toY = (n: number): string => (n < 0 ? `${v === "N" ? "S" : "N"}${-n - 1}` : `${v}${n}`);
  const names: string[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) names.push(`${toX(Number(xs) + dx)}${toY(Number(ys) + dy)}`);
  }
  return names;
}

async function captureRoom(room: string, shard: string): Promise<void> {
  const terrainBody = await apiGet(`/game/room-terrain?room=${room}&shard=${shard}&encoded=1`);
  await sleep(CALL_GAP_MS);
  const objectsBody = await apiGet(`/game/room-objects?room=${room}&shard=${shard}`);
  await sleep(CALL_GAP_MS);

  const encoded: string = terrainBody.terrain?.[0]?.terrain;
  if (!encoded) throw new Error(`${room}: no terrain in response`);

  const all: any[] = objectsBody.objects ?? [];
  const owner = all.find(o => o.type === "controller")?.user;
  const dropped = new Set<string>();
  const objects = all
    .filter(o => {
      if (KEEP_TYPES.has(o.type)) return true;
      dropped.add(o.type);
      return false;
    })
    .map(o => ({
      type: o.type,
      x: o.x,
      y: o.y,
      ...(o.type === "mineral" ? { attributes: { mineralType: o.mineralType, mineralAmount: o.mineralAmount } } : {})
    }));

  const fixture = {
    room,
    shard,
    capturedAt: new Date().toISOString(),
    ownedOnLive: owner ? true : false,
    droppedObjectTypes: [...dropped].sort(),
    terrain: decodeTerrain(encoded),
    objects
  };

  const file = path.join(OUT_DIR, `${shard}-${room}.json`);
  writeFileSync(file, JSON.stringify(fixture, null, 2));
  const kl = objects.filter(o => o.type === "keeperLair").length;
  console.log(
    `${room}: ${objects.filter(o => o.type === "source").length} sources, ` +
      `${objects.some(o => o.type === "controller") ? "controller" : "NO controller"}` +
      `${kl ? `, ${kl} keeper lairs (SK room!)` : ""}` +
      `${owner ? ", OWNED on live (player structures dropped)" : ""} -> ${path.relative(".", file)}`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shardIdx = args.indexOf("--shard");
  const shard = shardIdx !== -1 ? args[shardIdx + 1] : process.env.SCREEPS_SHARD ?? "shard3";
  const aroundIdx = args.indexOf("--around");
  let rooms = args.filter((a, i) => !a.startsWith("--") && i !== shardIdx + 1 && i !== aroundIdx + 1);
  if (aroundIdx !== -1) rooms = [...new Set([...rooms, ...around(args[aroundIdx + 1])])];
  if (rooms.length === 0) {
    console.log("usage: npm run capture:rooms -- --shard shard3 W1N8 W2N8   (or --around W5N8)");
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`capturing ${rooms.length} room(s) from ${API} (${shard})...`);
  for (const room of rooms) await captureRoom(room, shard);
}

main().catch(err => {
  console.error("capture-rooms failed:", err);
  process.exit(1);
});
