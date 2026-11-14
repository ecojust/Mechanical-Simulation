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
export type Category =
  "all" | "mechanical" | "electrical" | "repository" | "custom";
export interface AssemblyGroup {
  id: string;
  name: string;
}
export interface PartMaterial {
  metalness: number;
  roughness: number;
  useSourceColor?: boolean;
}
export interface Part {
  id: string;
  name: string;
  kind: PartKind;
  position: Vec3;
  rotation: Vec3;
  size: Vec3;
  color: string;
  material?: PartMaterial;
  fixed: boolean;
  visible: boolean;
  model?: { id: string };
  interaction?: InteractionProfile;
  componentId?: string;
  assemblyGroup?: AssemblyGroup;
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
  models?: UploadedModel[];
  mechanisms?: Mechanism[];
}
export interface MechanismFrame {
  position: Vec3;
  rotation: Vec3;
}
export type MechanismProxyKind =
  | "base"
  | "tenon"
  | "mortise"
  | "pin"
  | "sleeve"
  | "bayonet-pin"
  | "bayonet-socket";
export interface MechanismProxy {
  kind: MechanismProxyKind;
  position: Vec3;
  rotation: Vec3;
  size: Vec3;
  params: Record<string, number>;
}
export interface MechanismContact {
  strikerPartId: string;
  strikerPoint: Vec3;
  switchPoint: Vec3;
  switchNormal: Vec3;
  radius: number;
  maxOvertravel: number;
}
export interface Mechanism {
  version: 1;
  id: string;
  name: string;
  kind: "press" | "mating";
  status: "unconfigured" | "configured";
  partIds: string[];
  movingPartIds: string[];
  springPartIds: string[];
  switchPartId?: string;
  frame: MechanismFrame;
  axis: Vec3;
  pose: { offset: number; angle: number };
  params: Record<string, number>;
  movingProxy: MechanismProxy;
  fixedProxy: MechanismProxy;
  contact?: MechanismContact;
}
export type MechanismStates = Record<string, SpringState>;
export interface MechanismDeformation {
  axis: Vec3;
  ratio: number;
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
export interface AssetNode {
  name: string;
  displayName?: string;
  size: Vec3;
  center: Vec3;
  kind?: PartKind;
  group?: AssemblyGroup;
  role?: "male" | "female" | "support";
  /** Source evidence for a suggested type; never implies verified physics. */
  typeBasis?: string;
}
export interface AssetEntry {
  kind?: PartKind;
  id: string;
  name: string;
  file: string;
  url: string;
  size: Vec3;
  center: Vec3;
  objects: number;
  triangles: number;
  nodes?: AssetNode[];
}

/** Imported geometry is visual data; functional geometry is explicitly declared. */
export interface UploadedModel {
  id: string;
  name: string;
  format: "glb" | "stl";
  data: string; // base64 bytes, never a remote URL
  sha256: string;
  bytes: number;
  size: Vec3;
  center: Vec3;
}
export interface InteractionProfile {
  version: 1;
  status: "unconfigured" | "configured";
  axis: Vec3; // unit direction in the model's normalized local coordinates
  anchor: Vec3; // proxy center relative to the visible model center, mm
  proxySize: Vec3; // declared function/collision dimensions, mm
  mateFamily?: string;
  insertionDepth?: number;
  minClearance?: number; // required minimum worst-case one-sided clearance, mm
  lockAngle?: number;
}
export interface ComponentDefinition {
  version: 1;
  id: string;
  name: string;
  kind: PartKind;
  size: Vec3;
  color: string;
  material?: PartMaterial;
  params: Part["params"];
  interaction: InteractionProfile;
  model: UploadedModel;
}
export interface ComponentParameterField {
  key: string;
  label: string;
  unit: string;
  min: number;
  max?: number;
  required: boolean;
  group: "params" | "interaction";
}
export interface ComponentTypeSchema {
  kind: PartKind;
  label: string;
  description: string;
  role?: "male" | "female";
  fields: ComponentParameterField[];
  requiresMating: boolean;
  supportsElectrical: boolean;
  supportsPress: boolean;
  jsonSchema: Record<string, unknown>;
}
