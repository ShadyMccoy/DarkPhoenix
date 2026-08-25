import { BankBranchKind } from "../primitives";
import { BodyShape } from "../sizing";
import { PlaceId, StructureKind } from "./vocabulary";

export interface ViewSource {
  id: string;
  spots: number;
  distToBank: number;
}

export interface ViewCreep {
  id: string;
  corp: string;
  body: BodyShape;
  ttl: number;
}

export interface EconomyView {
  tick: number;
  bank: PlaceId;
  bankStock: number;
  bankBranch: BankBranchKind;
  bodyBudget: number;
  spawnIds: string[];
  estateRadius: number;
  sources: ViewSource[];
  controller: { id: string; distFromBank: number } | null;
  creeps: ViewCreep[];
  links: ViewLink[];
  outposts: ViewOutpost[];
  sites: ViewSite[];
  roads: ViewRoad[];
  wireOptions: ViewWireOption[];
  stationOptions: ViewStationOption[];
  linkBudget?: number;
}

export interface ViewStationOption {
  id: string;
  sources: { id: PlaceId; collectRange: number }[];
  range: number;
  missingHub: boolean;
  hubRoom?: string;
}

export interface ViewRoad {
  from: PlaceId;
  to: PlaceId;
  dist: number;
}

export interface ViewSite {
  id: string;
  structure: StructureKind;
  at: PlaceId;
  dist: number;
  total: number;
  remaining: number;
  edge?: { from: PlaceId; to: PlaceId };
}

export interface ViewLink {
  id: string;
  at: PlaceId;
  room: string;
  x: number;
  y: number;
}

export interface ViewOutpost {
  place: PlaceId;
  distToSource: Record<string, number>;
  distToBank: number;
  hasContainer?: boolean;
}

export interface ViewWireOption {
  from: PlaceId;
  to: PlaceId;
  range: number;
  missingMouth: boolean;
  missingHub: boolean;
  hubRoom?: string;
}
