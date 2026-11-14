import type {
  AssetEntry,
  ComponentDefinition,
  MechanismFrame,
  MechanismStates,
  Part,
  Project,
  Vec3,
  Wire,
} from "../types";
import { definitions, makePart, newId, parseProject } from "../catalog";
import {
  componentDefinitionIssues,
  createPartFromComponent,
  getComponentTypeSchemas,
  validateComponentDefinition,
  validateInteractionProfile,
  validatePartMaterial,
  MAX_PROJECT_MODEL_BYTES,
} from "../componentRegistry";
import { createRepositoryParts } from "../repository";
import {
  validateEvidenceState,
  type AssemblyEvidenceResult,
} from "../assemblyEvidence";
import { withSourceEvidence } from "../projectEvidence";
import {
  validateMechanismUpdate,
  validateMechanismProject,
  moveMechanism,
  transformMechanismFrame,
  stepMechanisms,
  mechanismScene,
  partMechanism,
} from "../mechanisms";
import { solveCircuit, validateMotion } from "../engine/physics";
import tools from "./tools.json";
export interface WorkbenchRequest {
  method: string;
  args?: Record<string, unknown>;
}
export interface WorkbenchContext {
  revision: number;
  components: ComponentDefinition[];
  assets: AssetEntry[];
  runtime?: Record<string, unknown>;
  mechanismStates?: MechanismStates;
  sourceEvidence?: AssemblyEvidenceResult | null;
}
export interface WorkbenchOutcome {
  result: Record<string, unknown>;
  project?: Project;
  component?: ComponentDefinition;
  mechanismStates?: MechanismStates;
  actuation?: { mechanismId: string; held: boolean };
}
export const workbenchTools = tools;
/** Keep UTF-16 surrogate pairs intact so Rust and strict JSON clients can decode every chunk. */
export function sliceJsonChunk(
  text: string,
  index: number,
  size: number,
): string {
  const boundary = (position: number) =>
    position > 0 &&
    position < text.length &&
    text.charCodeAt(position) >= 0xdc00 &&
    text.charCodeAt(position) <= 0xdfff &&
    text.charCodeAt(position - 1) >= 0xd800 &&
    text.charCodeAt(position - 1) <= 0xdbff
      ? position + 1
      : position;
  return text.slice(boundary(index * size), boundary((index + 1) * size));
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function vector(value: unknown, label: string): Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(
      (v) =>
        typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 100000,
    )
  )
    throw Error(`${label}必须是三个有限数值（mm/度）。`);
  return value as Vec3;
}
function safeProject(project: Project): Project {
  return parseProject(JSON.stringify(project));
}
function withoutBytes<T extends { models?: unknown[] }>(project: T) {
  return {
    ...project,
    models: project.models?.map((model) => {
      const { data: _, ...metadata } = model as Record<string, unknown>;
      return metadata;
    }),
  };
}
type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  required?: string[];
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  uniqueItems?: boolean;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
};
function validateArguments(
  value: unknown,
  schema: Schema,
  path = "args",
): void {
  if (schema.type === "object") {
    if (!object(value)) throw Error(`${path}必须为对象。`);
    for (const key of schema.required ?? [])
      if (!(key in value)) throw Error(`缺少参数：${path}.${key}`);
    for (const [key, item] of Object.entries(value)) {
      const property =
        schema.properties &&
        Object.prototype.hasOwnProperty.call(schema.properties, key)
          ? schema.properties[key]
          : undefined;
      if (property) validateArguments(item, property, `${path}.${key}`);
      else if (schema.additionalProperties === false)
        throw Error(`不支持的参数：${path}.${key}`);
      else if (object(schema.additionalProperties))
        validateArguments(item, schema.additionalProperties, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      throw Error(`${path}数组长度无效。`);
    if (
      schema.uniqueItems &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      throw Error(`${path}不能包含重复值。`);
    if (schema.items)
      value.forEach((item, index) =>
        validateArguments(item, schema.items!, `${path}[${index}]`),
      );
  } else if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isSafeInteger(value)) ||
      value < (schema.minimum ?? -Infinity) ||
      (schema.exclusiveMinimum !== undefined &&
        value <= schema.exclusiveMinimum) ||
      value > (schema.maximum ?? Infinity)
    )
      throw Error(
        `${path}必须为范围内的有限${schema.type === "integer" ? "整数" : "数值"}。`,
      );
  } else if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      value.length > (schema.maxLength ?? Infinity) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      throw Error(`${path}字符串格式无效。`);
  } else if (schema.type === "boolean" && typeof value !== "boolean")
    throw Error(`${path}必须为boolean。`);
  if (schema.enum && !schema.enum.includes(value))
    throw Error(`${path}不是支持的选项。`);
  if ("const" in schema && value !== schema.const)
    throw Error(`${path}值无效。`);
}
function checkedArgs(method: string, args: Record<string, unknown>) {
  const tool = tools.find((t) => t.name === method);
  if (!tool) throw Error(`未知MCP工具：${method}`);
  validateArguments(args, tool.inputSchema as Schema);
  return tool;
}
/** The caller applies outcomes through the same UI commit/undo path, never a second project. */
export async function dispatchWorkbenchCommand(
  project: Project,
  request: WorkbenchRequest,
  context: WorkbenchContext,
): Promise<WorkbenchOutcome> {
  if (
    !object(request) ||
    typeof request.method !== "string" ||
    (request.args !== undefined && !object(request.args))
  )
    throw Error("MCP请求格式无效。");
  const args = request.args ?? {};
  const tool = checkedArgs(request.method, args);
  const mutates = !tool.annotations.readOnlyHint;
  if (
    mutates &&
    (!Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision !== context.revision)
  )
    throw Error(
      `项目已变化：当前revision=${context.revision}，请先get_project再重试。`,
    );
  const result = (
    value: Record<string, unknown>,
    next?: Project,
    component?: ComponentDefinition,
  ): WorkbenchOutcome => ({
    result: {
      revision: context.revision + (next || component ? 1 : 0),
      ...value,
    },
    ...(next ? { project: next } : {}),
    ...(component ? { component } : {}),
  });
  const findPart = () => {
    if (typeof args.partId !== "string") throw Error("partId必须为字符串。");
    const part = project.parts.find((p) => p.id === args.partId);
    if (!part) throw Error("零件不存在。");
    return part;
  };
  switch (request.method) {
    case "new_project": {
      const next = safeProject({
        version: 1,
        name: args.name === undefined ? "未命名装配" : (args.name as string),
        parts: [],
        wires: [],
      });
      return result({ project: withoutBytes(next) }, next);
    }
    case "import_project": {
      const next = parseProject(JSON.stringify(args.project));
      return result(
        {
          project: withoutBytes(next),
          issues: validateMechanismProject(next).issues,
        },
        next,
      );
    }
    case "list_component_types":
      return result({ types: getComponentTypeSchemas() });
    case "list_components":
      return result({
        builtin: definitions,
        repository: context.assets,
        uploaded: context.components.map((c) => ({
          ...c,
          model: { ...c.model, data: undefined },
        })),
      });
    case "get_project":
      return result({ project: withoutBytes(project) });
    case "get_runtime_status":
      return result({
        runtime: context.runtime ?? { available: false },
        parts: project.parts.length,
        mechanismStates: context.mechanismStates ?? {},
      });
    case "export_project": {
      if (
        args.expectedRevision !== undefined &&
        args.expectedRevision !== context.revision
      )
        throw Error(
          `项目已变化：当前revision=${context.revision}，请从第0块重新导出。`,
        );
      const portable = safeProject(project),
        text = JSON.stringify(portable),
        chunkCharacters = 512 * 1024,
        chunkCount = Math.ceil(text.length / chunkCharacters);
      if (args.chunkIndex !== undefined) {
        const index = args.chunkIndex as number;
        if (index >= chunkCount) throw Error("chunkIndex超过导出块数。");
        return result({
          mode: "chunk",
          chunkIndex: index,
          chunkCount,
          totalCharacters: text.length,
          data: sliceJsonChunk(text, index, chunkCharacters),
        });
      }
      if (new TextEncoder().encode(text).byteLength > 3 * 1024 * 1024)
        return result({
          mode: "chunked",
          chunkCount,
          chunkCharacters,
          totalCharacters: text.length,
          instructions:
            "Call export_project with chunkIndex=0..chunkCount-1 and expectedRevision; concatenate data strings in order, then JSON.parse.",
        });
      return result({ project: portable });
    }
    case "import_component": {
      const component = validateComponentDefinition(args.component);
      if (context.components.some((c) => c.id === component.id))
        throw Error("组件ID已存在，请使用新ID。");
      if (context.components.length >= 500)
        throw Error("组件库最多保存500个组件。");
      if (
        context.components.reduce(
          (sum, c) => sum + c.model.bytes,
          component.model.bytes,
        ) > MAX_PROJECT_MODEL_BYTES
      )
        throw Error("组件库模型总量不能超过64 MiB。");
      return result(
        {
          component: {
            ...component,
            model: { ...component.model, data: undefined },
          },
          issues: componentDefinitionIssues(component),
        },
        undefined,
        component,
      );
    }
    case "add_part": {
      if (
        (typeof args.kind === "string") ===
        (typeof args.componentId === "string")
      )
        throw Error("请仅提供kind或componentId之一。");
      const position = vector(args.position, "position");
      let part: Part;
      let models = project.models;
      if (typeof args.componentId === "string") {
        const component = context.components.find(
          (c) => c.id === args.componentId,
        );
        if (!component) throw Error("组件不在用户素材库中。");
        part = createPartFromComponent(component, position);
        const exists = models?.find((m) => m.id === component.model.id);
        if (exists && exists.sha256 !== component.model.sha256)
          throw Error("模型ID与已有模型内容冲突。");
        if (!exists) models = [...(models ?? []), component.model];
      } else {
        const def = definitions.find((d) => d.kind === args.kind);
        if (!def) throw Error("未知内置类型；先调用list_components。");
        part = makePart(def.kind, position);
      }
      const next = safeProject({
        ...project,
        parts: [...project.parts, part],
        ...(models ? { models } : {}),
      });
      const checks = validateMechanismProject(next);
      const errors = checks.issues.filter(
        (i) =>
          i.severity === "error" &&
          i.category === "geometry" &&
          i.partIds.includes(part.id),
      );
      if (errors.length) throw Error(errors.map((i) => i.detail).join("；"));
      return result(
        {
          part,
          issues: checks.issues.filter((i) => i.partIds.includes(part.id)),
        },
        next,
      );
    }
    case "add_repository_parts": {
      const asset = context.assets.find((asset) => asset.id === args.assetId);
      if (!asset) throw Error("原始素材不存在；请先调用list_components。");
      const all = asset.nodes ?? [];
      if (!all.length) throw Error("该素材没有可用子零件索引。");
      const names = args.nodeNames as string[] | undefined;
      const nodes = names
        ? names.map((name) => {
            const node = all.find((node) => node.name === name);
            if (!node) throw Error(`素材子零件不存在：${name}`);
            return node;
          })
        : all;
      const parts = createRepositoryParts(
        asset,
        nodes,
        args.offset === undefined ? [0, 0, 0] : vector(args.offset, "offset"),
      );
      const next = safeProject({
        ...project,
        parts: [...project.parts, ...parts],
      });
      return result(
        {
          parts,
          issues: validateMechanismProject(next).issues.filter((issue) =>
            issue.partIds.some((id) => parts.some((part) => part.id === id)),
          ),
          scope:
            "原始网格保留外观和组关系；保守代理预检，功能参数未配置时不得视为仿真通过。",
        },
        next,
      );
    }
    case "configure_part": {
      const current = findPart();
      const nextPart = { ...current };
      if (args.kind !== undefined) {
        if (!getComponentTypeSchemas().some((s) => s.kind === args.kind))
          throw Error("未知组件类型。");
        nextPart.kind = args.kind as Part["kind"];
        if (nextPart.kind !== current.kind) {
          nextPart.params = {
            ...(current.params.assetUrl
              ? { assetUrl: current.params.assetUrl }
              : {}),
            ...(current.params.assetNode
              ? { assetNode: current.params.assetNode }
              : {}),
          };
          nextPart.interaction = {
            version: 1,
            status: "unconfigured",
            axis: [0, 1, 0],
            anchor: [0, 0, 0],
            proxySize: [...current.size],
          };
        }
      }
      if (args.name !== undefined) {
        if (typeof args.name !== "string" || args.name.length > 200)
          throw Error("名称无效。");
        nextPart.name = args.name;
      }
      if (args.fixed !== undefined) {
        if (typeof args.fixed !== "boolean")
          throw Error("fixed必须为boolean。");
        nextPart.fixed = args.fixed;
      }
      if (args.visible !== undefined) {
        if (typeof args.visible !== "boolean")
          throw Error("visible必须为boolean。");
        nextPart.visible = args.visible;
      }
      if (args.material !== undefined)
        nextPart.material = validatePartMaterial(args.material);
      if (args.color !== undefined) {
        nextPart.color = args.color as string;
        nextPart.material = {
          metalness: nextPart.material?.metalness ?? 0.15,
          roughness: nextPart.material?.roughness ?? 0.5,
          ...nextPart.material,
          useSourceColor: false,
        };
      }
      if (args.params !== undefined) {
        if (!object(args.params)) throw Error("params必须为对象。");
        nextPart.params = {
          ...nextPart.params,
          ...args.params,
        } as Part["params"];
      }
      if (args.interaction !== undefined)
        nextPart.interaction = validateInteractionProfile(args.interaction);
      const next = safeProject({
        ...project,
        parts: project.parts.map((p) => (p.id === current.id ? nextPart : p)),
      });
      return result(
        {
          part: next.parts.find((p) => p.id === current.id),
          issues: validateMechanismProject(next).issues.filter((i) =>
            i.partIds.includes(current.id),
          ),
        },
        next,
      );
    }
    case "transform_part": {
      const current = findPart();
      if (partMechanism(project, current.id))
        throw Error(
          "该零件属于功能组件，请使用transform_mechanism保持子零件约束。",
        );
      if (args.position === undefined && args.rotation === undefined)
        throw Error("必须提供position或rotation。");
      const nextPart = {
        ...current,
        position:
          args.position === undefined
            ? current.position
            : vector(args.position, "position"),
        rotation:
          args.rotation === undefined
            ? current.rotation
            : vector(args.rotation, "rotation"),
      };
      // Committing an edit restores the scene's rest state; validate both that state
      // and the live pressed scene so a reset cannot introduce a hidden collision.
      const restMotion = validateMotion(
        mechanismScene(project).physicsParts,
        current.id,
        nextPart,
      );
      const liveMotion =
        context.mechanismStates && Object.keys(context.mechanismStates).length
          ? validateMotion(
              mechanismScene(project, context.mechanismStates).physicsParts,
              current.id,
              nextPart,
            )
          : restMotion;
      const motion = !restMotion.allowed ? restMotion : liveMotion;
      if (!motion.allowed)
        throw Error(
          `移动受阻：${motion.issues.map((i) => i.detail).join("；")}`,
        );
      const next = safeProject({
        ...project,
        parts: project.parts.map((p) => (p.id === current.id ? nextPart : p)),
      });
      return result({ part: nextPart, issues: motion.issues }, next);
    }
    case "connect_wire": {
      const endpoint = (value: unknown): Wire["from"] => {
        if (
          !object(value) ||
          Object.keys(value).some((k) => !["partId", "terminal"].includes(k)) ||
          typeof value.partId !== "string" ||
          ![0, 1].includes(value.terminal as number)
        )
          throw Error("导线端点无效。");
        return { partId: value.partId, terminal: value.terminal as 0 | 1 };
      };
      const from = endpoint(args.from),
        to = endpoint(args.to);
      if (from.partId === to.partId) throw Error("请选择两个不同的电气零件。");
      if (
        project.wires.some(
          (w) =>
            (w.from.partId === from.partId &&
              w.from.terminal === from.terminal &&
              w.to.partId === to.partId &&
              w.to.terminal === to.terminal) ||
            (w.to.partId === from.partId &&
              w.to.terminal === from.terminal &&
              w.from.partId === to.partId &&
              w.from.terminal === to.terminal),
        )
      )
        throw Error("端点已经连接。");
      const wire = { id: newId(), from, to, color: "#c97b63" };
      const next = safeProject({ ...project, wires: [...project.wires, wire] });
      const scene = mechanismScene(next);
      return result(
        {
          wire,
          circuit: solveCircuit(
            scene.circuitParts,
            next.wires,
            scene.pressedIds,
          ),
        },
        next,
      );
    }
    case "remove_part": {
      const part = findPart();
      if (partMechanism(project, part.id))
        throw Error(
          "零件仍属于功能组件；请先delete_mechanism解除定义，再移除成员。",
        );
      const next = {
        ...project,
        parts: project.parts.filter((p) => p.id !== part.id),
        wires: project.wires.filter(
          (w) => w.from.partId !== part.id && w.to.partId !== part.id,
        ),
      };
      return result({ removedPartId: part.id }, next);
    }
    case "validate_project": {
      const pressed = args.pressedIds ?? [];
      const scene = mechanismScene(project, context.mechanismStates);
      if (
        !Array.isArray(pressed) ||
        pressed.some(
          (id) =>
            typeof id !== "string" ||
            !project.parts.some(
              (p) =>
                p.id === id &&
                p.kind === "button" &&
                !partMechanism(project, p.id),
            ),
        )
      )
        throw Error(
          "pressedIds只能引用独立按压开关；功能组件开关必须由真实撞针接触闭合。",
        );
      const geometry = validateMechanismProject(
          project,
          context.mechanismStates,
        ),
        circuit = solveCircuit(scene.circuitParts, project.wires, [
          ...new Set([...scene.pressedIds, ...(pressed as string[])]),
        ]);
      const sourceEvidence = context.sourceEvidence
        ? validateEvidenceState(context.sourceEvidence, context.mechanismStates)
        : null;
      return result({
        geometry,
        circuit,
        mechanismStates: context.mechanismStates ?? {},
        contacts: scene.contacts,
        sourceEvidence,
        issues: withSourceEvidence(
          [...geometry.issues, ...circuit.issues],
          sourceEvidence,
        ),
        scope: `${sourceEvidence ? `${sourceEvidence.scope}；` : ""}运行时参数代理/名义物理参数检查；不等于任意网格或制造认证。`,
      });
    }
    case "configure_mechanism": {
      const mechanism = validateMechanismUpdate(project, args.mechanism);
      const current = (project.mechanisms ?? []).find(
        (item) => item.id === mechanism.id,
      );
      const next = safeProject({
        ...project,
        mechanisms: current
          ? project.mechanisms!.map((item) =>
              item.id === mechanism.id ? mechanism : item,
            )
          : [...(project.mechanisms ?? []), mechanism],
      });
      return result(
        {
          mechanism,
          issues: validateMechanismProject(next).issues.filter((issue) =>
            issue.partIds.some((id) => mechanism.partIds.includes(id)),
          ),
        },
        next,
      );
    }
    case "delete_mechanism": {
      if (
        !(project.mechanisms ?? []).some((item) => item.id === args.mechanismId)
      )
        throw Error("功能组件不存在。");
      const next = safeProject({
        ...project,
        mechanisms: project.mechanisms!.filter(
          (item) => item.id !== args.mechanismId,
        ),
      });
      return result({ removedMechanismId: args.mechanismId }, next);
    }
    case "transform_mechanism": {
      if (typeof args.mechanismId !== "string")
        throw Error("mechanismId必须为字符串。");
      if (
        (args.frame !== undefined) ===
        (args.distance !== undefined || args.angle !== undefined)
      )
        throw Error("请提供frame，或distance/angle；二者不能混用。");
      const motion =
        args.frame !== undefined
          ? transformMechanismFrame(
              project,
              args.mechanismId,
              args.frame as unknown as MechanismFrame,
            )
          : moveMechanism(project, args.mechanismId, {
              ...(args.distance !== undefined
                ? { distance: args.distance as number }
                : {}),
              ...(args.angle !== undefined
                ? { angle: args.angle as number }
                : {}),
            });
      if (!motion.allowed)
        throw Error(
          `功能组件移动受阻：${motion.issues.map((issue) => issue.detail).join("；")}`,
        );
      const next = safeProject(motion.project);
      const mechanism = next.mechanisms?.find(
        (item) => item.id === args.mechanismId,
      );
      return result(
        {
          mechanism,
          parts: next.parts.filter((part) =>
            mechanism?.partIds.includes(part.id),
          ),
          issues: motion.issues,
        },
        next,
      );
    }
    case "press_mechanism": {
      const mechanism = project.mechanisms?.find(
        (item) => item.id === args.mechanismId,
      );
      if (!mechanism || mechanism.kind !== "press")
        throw Error("请选择按压功能组件。");
      if (
        context.sourceEvidence?.matched &&
        context.sourceEvidence.status === "fail"
      )
        throw Error(
          `源几何验证已确认不通过，禁止继续按压：${
            context.sourceEvidence.issues
              .filter((issue) => issue.severity === "error")
              .map((issue) => issue.detail)
              .join("；") || context.sourceEvidence.scope
          }`,
        );
      const held = args.held as boolean,
        duration = args.duration as number;
      let states = structuredClone(context.mechanismStates ?? {});
      const count = Math.ceil(duration * 120),
        dt = duration / count;
      let issues: ReturnType<typeof stepMechanisms>["issues"] = [];
      for (let step = 0; step < count; step++) {
        const next = stepMechanisms(
          project,
          states,
          dt,
          held ? [mechanism.id] : [],
        );
        const blocked = next.issues.filter(
          (issue) =>
            issue.severity === "error" &&
            issue.partIds.some((id) => mechanism.partIds.includes(id)),
        );
        if (blocked.length)
          throw Error(
            `按压仿真受阻：${blocked.map((issue) => issue.detail).join("；")}`,
          );
        states = next.states;
        issues = next.issues;
      }
      const scene = mechanismScene(project, states);
      const sourceEvidence = context.sourceEvidence
        ? validateEvidenceState(context.sourceEvidence, states)
        : null;
      return {
        mechanismStates: states,
        actuation: { mechanismId: mechanism.id, held },
        result: {
          revision: context.revision + 1,
          mechanismId: mechanism.id,
          state: states[mechanism.id],
          mechanismStates: states,
          held,
          duration,
          members: scene.renderParts.filter((part) =>
            mechanism.partIds.includes(part.id),
          ),
          pressedIds: scene.pressedIds,
          contacts: scene.contacts,
          sourceEvidence,
          circuit: solveCircuit(
            scene.circuitParts,
            project.wires,
            scene.pressedIds,
          ),
          issues: withSourceEvidence(
            [...scene.issues, ...issues],
            sourceEvidence,
          ),
        },
      };
    }
    default:
      throw Error("未知MCP工具。");
  }
}
