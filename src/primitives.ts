export const SOURCE_CAPACITY = 3000;
export const SOURCE_REGEN_TICKS = 300;
export const SOURCE_RATE = SOURCE_CAPACITY / SOURCE_REGEN_TICKS;

export const HARVEST_POWER = 2;
export const SOURCE_SATURATION_WORK = SOURCE_RATE / HARVEST_POWER;

export const UPGRADE_POWER = 1;

export const BUILD_POWER = 5;

export const PROJECT_RATE_WINDOW = 300;

export const CREEP_LIFE = 1500;
export const CARRY_CAP = 50;

export const SPAWN_TICKS_PER_PART = 3;
export const SPAWN_RATE = 1 / SPAWN_TICKS_PER_PART;

export const ENERGY_DECAY_DIVISOR = 1000;

export function pileDecayRate(amount: number): number {
  return amount > 0 ? Math.ceil(amount / ENERGY_DECAY_DIVISOR) : 0;
}

export const CONTAINER_CAP = 2000;
export const CONTAINER_COST = 5000;
export const CONTAINER_HOLD_ET = 5000 / 500 / 100;

export const STORAGE_COST = 30000;

export const ROAD_COST_PER_TILE = 300;
export const ROAD_UPKEEP_ET_PER_TILE = 100 / 1000 / 100;

export type BankBranchKind = "pile" | "container" | "storage";

export function branchHoldingEt(branch: BankBranchKind, stock: number, vaultFree: number): number {
  if (branch === "storage") return 0;
  const ground = Math.max(0, stock - vaultFree);
  if (branch === "container") return CONTAINER_HOLD_ET + pileDecayRate(Math.max(0, ground - CONTAINER_CAP));
  return pileDecayRate(ground);
}

export function reachableStock(branch: BankBranchKind, streamEt: number, vaultFree: number): number {
  if (branch === "storage") return Infinity;
  const base = vaultFree + (branch === "container" ? CONTAINER_CAP : 0);
  const overhead = branch === "container" ? CONTAINER_HOLD_ET : 0;
  return base + ENERGY_DECAY_DIVISOR * Math.max(streamEt - overhead, 0);
}

export const EXTENSION_COST = 3000;
export const EXTENSION_CAPACITY = 50;

export const ROOM_SIZE = 50;

export function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export const LINK_CAPACITY = 800;
export const LINK_LOSS = 0.03;
export const LINK_COST = 5000;

export const LINK_PAYLOAD_CARRY = LINK_CAPACITY / CARRY_CAP;

export const CORE_SERVICE_CARRY_PER_SENDER = 4;

export const HORIZON = 100000;

export const PART_COST: Record<"work" | "carry" | "move", number> = {
  work: 100,
  carry: 50,
  move: 50
};

export interface WorkmanShape {
  work: number;
  carry: number;
  move: number;
}

export function bodyCost(s: WorkmanShape): number {
  return s.work * PART_COST.work + s.carry * PART_COST.carry + s.move * PART_COST.move;
}

export function partCount(s: WorkmanShape): number {
  return s.work + s.carry + s.move;
}

export function effectiveLife(commute = 0): number {
  return Math.max(1, CREEP_LIFE - commute);
}

export function upkeepEt(s: WorkmanShape, commute = 0): number {
  return bodyCost(s) / effectiveLife(commute);
}

export function spawnTimeEt(s: WorkmanShape, commute = 0): number {
  return partCount(s) / effectiveLife(commute);
}

export function haulRate(carry: number, distance: number): number {
  return (carry * CARRY_CAP) / (2 * distance);
}

export function bodyList(s: WorkmanShape): ("work" | "carry" | "move")[] {
  const out: ("work" | "carry" | "move")[] = [];
  for (let i = 0; i < s.work; i++) out.push("work");
  for (let i = 0; i < s.carry; i++) out.push("carry");
  for (let i = 0; i < s.move; i++) out.push("move");
  return out;
}

export function workmanCycleRate(s: WorkmanShape, distance: number): number {
  const fill = (s.carry * CARRY_CAP) / (HARVEST_POWER * s.work);
  const cycle = fill + 2 * distance + 1;
  return (s.carry * CARRY_CAP) / cycle;
}

export function workmenPerSource(s: WorkmanShape, distance: number, spots: number): number {
  const fill = (s.carry * CARRY_CAP) / (HARVEST_POWER * s.work);
  const cycle = fill + 2 * distance + 1;
  const effectiveWork = s.work * (fill / cycle);
  const wanted = Math.ceil(SOURCE_SATURATION_WORK / Math.max(effectiveWork, 0.01));
  return Math.max(1, Math.min(spots, wanted));
}
