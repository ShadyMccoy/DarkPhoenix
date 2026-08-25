import {
  CARRY_CAP,
  CORE_SERVICE_CARRY_PER_SENDER,
  LINK_PAYLOAD_CARRY,
  PART_COST,
  SOURCE_SATURATION_WORK,
  WorkmanShape,
  effectiveLife
} from "./primitives";

export type BodyShape = WorkmanShape;

export function workmanBody(budget: number): BodyShape | null {
  if (budget < 200) return null;
  if (budget < 250) return { work: 1, carry: 1, move: 1 };
  const units = Math.min(5, Math.floor(budget / 250));
  return { work: units, carry: units, move: 2 * units };
}

export function minerBody(budget: number): BodyShape | null {
  if (budget < PART_COST.work + PART_COST.move) return null;
  const work = Math.min(SOURCE_SATURATION_WORK, Math.floor((budget - PART_COST.move) / PART_COST.work));
  return { work, carry: 0, move: 1 };
}

export function haulerBody(budget: number): BodyShape | null {
  const unitCost = PART_COST.carry + PART_COST.move;
  if (budget < unitCost) return null;
  const units = Math.min(25, Math.floor(budget / unitCost));
  return { work: 0, carry: units, move: units };
}

export function haulerBodyFor(
  flow: number,
  dist: number,
  budget: number,
  roaded = false,
  linkFed = false
): BodyShape | null {
  if (flow <= 0) return null;
  const need = Math.max(carryPartsFor(flow, dist), 1);
  if (roaded) {
    const roadUnitCost = 2 * PART_COST.carry + PART_COST.move;
    if (budget < roadUnitCost) return null;
    const roadUnits = Math.min(
      Math.ceil(need / 2),
      Math.floor(budget / roadUnitCost),
      linkFed ? LINK_PAYLOAD_CARRY / 2 : 16
    );
    return { work: 0, carry: 2 * roadUnits, move: roadUnits };
  }
  const unitCost = PART_COST.carry + PART_COST.move;
  if (budget < unitCost) return null;
  const units = Math.min(need, Math.floor(budget / unitCost), linkFed ? LINK_PAYLOAD_CARRY : 25);
  return { work: 0, carry: units, move: units };
}

export function portTenderBody(flowEt: number): BodyShape {
  const carry = Math.min(Math.max(Math.ceil((2 * Math.max(flowEt, 0)) / CARRY_CAP), 1), LINK_PAYLOAD_CARRY);
  return { work: 0, carry, move: 1 };
}

export function hubServiceBody(): BodyShape {
  return { work: 0, carry: CORE_SERVICE_CARRY_PER_SENDER, move: 1 };
}

export function upgraderBody(budget: number): BodyShape | null {
  const overhead = PART_COST.carry + PART_COST.move;
  if (budget < overhead + PART_COST.work) return null;
  const work = Math.min(15, Math.floor((budget - overhead) / PART_COST.work));
  return { work, carry: 1, move: 1 };
}

export function builderBody(budget: number): BodyShape | null {
  const overhead = PART_COST.carry + PART_COST.move;
  if (budget < overhead + PART_COST.work) return null;
  const work = Math.min(10, Math.floor((budget - overhead) / PART_COST.work));
  return { work, carry: 1, move: 1 };
}

export function tenderBody(budget: number): BodyShape | null {
  const unitCost = PART_COST.carry + PART_COST.move;
  if (budget < unitCost) return null;
  const units = Math.min(2, Math.floor(budget / unitCost));
  return { work: 0, carry: units, move: units };
}

export function haulFleetBillEt(flow: number, dist: number, roaded: boolean, commute = 0): number {
  if (flow <= 0) return 0;
  const life = effectiveLife(commute);
  const pairs = Math.max(carryPartsFor(flow, dist), 1);
  if (roaded) return (Math.ceil(pairs / 2) * (2 * PART_COST.carry + PART_COST.move)) / life;
  return (pairs * (PART_COST.carry + PART_COST.move)) / life;
}

export function carryPartsFor(flow: number, dist: number): number {
  return Math.ceil((flow * 2 * dist) / CARRY_CAP);
}
