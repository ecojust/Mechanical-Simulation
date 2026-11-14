export type Vec3 = [number, number, number];
export type PartKind =
  | "base"
  | "tenon"
  | "mortise"
  | "pin"
  | "sleeve"
  | "bayonet-pin"
  | "bayonet-socket"
  | "spring"
  | "button"
  | "battery"
  | "lamp"
  | "resistor"
  | "asset";
export type Category = "all" | "mechanical" | "electrical" | "repository";
export interface Part {
  id: string;
  name: string;
  kind: PartKind;
  position: Vec3;
  rotation: Vec3;
  size: Vec3;
  color: string;
  fixed: boolean;
  visible: boolean;
  params: {
    stiffness?: number;
    damping?: number;
    mass?: number;
    travel?: number;
    trigger?: number;
    compression?: number;
    voltage?: number;
    resistance?: number;
    clearance?: number;
    tolerance?: number;
    innerWidth?: number;
    innerDepth?: number;
    pinDiameter?: number;
    holeDiameter?: number;
    freeLength?: number;
    solidLength?: number;
    assetUrl?: string;
    assetNode?: string;
    [key: string]: number | string | undefined;
  };
}
export interface Wire {
  id: string;
  from: { partId: string; terminal: 0 | 1 };
  to: { partId: string; terminal: 0 | 1 };
  color: string;
}
export interface Project {
  version: 1;
  name: string;
  parts: Part[];
  wires: Wire[];
}
export interface Issue {
  id: string;
  severity: "error" | "warning" | "pass";
  title: string;
  detail: string;
  partIds: string[];
  category: "geometry" | "fit" | "circuit" | "physics";
}
export interface Validation {
  issues: Issue[];
  collisionPairs: [string, string][];
  minClearance: number | null;
}
export interface CircuitResult {
  poweredLampIds: string[];
  current: number;
  voltage: number;
  shortCircuit: boolean;
  issues: Issue[];
}
export interface MotionResult {
  allowed: boolean;
  issues: Issue[];
}
export interface SpringState {
  displacement: number;
  velocity: number;
  force: number;
}
export interface AssetEntry {
  id: string;
  name: string;
  file: string;
  url: string;
  size: Vec3;
  center: Vec3;
  objects: number;
  triangles: number;
  nodes?: { name: string; size: Vec3; center: Vec3 }[];
}
