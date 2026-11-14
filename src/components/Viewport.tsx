import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  createPartVisual,
  disposeObject,
  labelSprite,
  terminalLocal,
} from "./geometry";
import { validateMotion } from "../engine/physics";
import { bayonetSolids } from "../engine/bayonet";
import type { Part, UploadedModel, Vec3, Wire } from "../types";
import { loadImportedModelScene } from "../modelImport";
import { applyPartMaterial } from "../materials";
import { applyVisualDeformation } from "../visualDeformation";
import type { VisualDeformations } from "../visualDeformation";
import { ContactMarkerLayer } from "../contactMarkers";
import type { ContactMarker } from "../contactMarkers";

export interface ViewportProps {
  parts: Part[];
  models?: UploadedModel[];
  deformations?: VisualDeformations;
  trackedPartIds?: string[];
  contactMarkers?: ContactMarker[];
  wires: Wire[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onTransform: (id: string, position: Vec3, rotation: Vec3) => void;
  tool: "select" | "move" | "rotate" | "wire";
  view: "perspective" | "top" | "front";
  showGrid: boolean;
  xray: boolean;
  exploded: boolean;
  running: boolean;
  pressedIds: string[];
  poweredLampIds: string[];
  collisionIds: string[];
  resetKey: number;
}
interface Entry {
  object: THREE.Group;
  deformation: THREE.Group;
  signature: string;
  loaded: boolean;
}
interface Runtime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  transform: TransformControls;
  models: Map<string, Entry>;
  grid: THREE.GridHelper;
  wires: THREE.Group;
  selection: THREE.Group;
  selectionSignature: string;
  wireSignature: string;
  dragging: boolean;
  sync: () => void;
  fit: () => void;
}
// Keep immutable source scenes cached; displayed instances own their disposable resources.
const assetScenes = new Map<string, Promise<THREE.Group>>();
function loadAssetScene(url: string) {
  let pending = assetScenes.get(url);
  if (!pending) {
    pending = new GLTFLoader()
      .loadAsync(url)
      .then((gltf) => gltf.scene)
      .catch((error) => {
        assetScenes.delete(url);
        throw error;
      });
    assetScenes.set(url, pending);
  }
  return pending;
}
function cloneAssetObject(source: THREE.Object3D) {
  source.updateWorldMatrix(true, true);
  const clone = source.clone(true);
  source.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry = child.geometry.clone();
    const cloneMaterial = (original: THREE.Material) => {
      const material = original.clone();
      // Each copied texture gets its own GPU allocation; source images remain immutable.
      for (const key of Object.keys(material)) {
        const value = (material as unknown as Record<string, unknown>)[key];
        if (value instanceof THREE.Texture)
          (material as unknown as Record<string, unknown>)[key] = value.clone();
      }
      return material;
    };
    child.material = Array.isArray(child.material)
      ? child.material.map(cloneMaterial)
      : cloneMaterial(child.material);
    child.castShadow = true;
    child.receiveShadow = true;
  });
  clone.updateMatrixWorld(true);
  return clone;
}
const radians = Math.PI / 180;
function partTransform(
  object: THREE.Object3D,
  part: Part,
  index: number,
  exploded: boolean,
) {
  object.position.fromArray(part.position);
  if (exploded && part.kind !== "base") object.position.y += 12 + index * 6;
  object.rotation.set(
    part.rotation[0] * radians,
    part.rotation[1] * radians,
    part.rotation[2] * radians,
    "XYZ",
  );
  object.visible = part.visible;
}
function appearance(object: THREE.Object3D, xray: boolean, collision: boolean) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(child.material)
      ? child.material
      : [child.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (!material.userData.baseColor)
        material.userData.baseColor = material.color.clone();
      if (collision) material.color.set("#dd6658");
      else material.color.copy(material.userData.baseColor);
      material.transparent = xray || Boolean(material.userData.baseTransparent);
      material.opacity = xray ? 0.34 : (material.userData.baseOpacity ?? 1);
      material.depthWrite = xray
        ? false
        : (material.userData.baseDepthWrite ?? true);
    }
  });
}
function signature(part: Part, model?: UploadedModel) {
  const params = { ...part.params };
  delete params.compression;
  return JSON.stringify([
    part.kind,
    part.size,
    part.color,
    part.material,
    params,
    part.model,
    model?.sha256,
  ]);
}
function worldTerminal(part: Part, terminal: number, model: THREE.Object3D) {
  return model.localToWorld(terminalLocal(part, terminal));
}

export default function Viewport(props: ViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const runtimeRef = useRef<Runtime | null>(null);
  const [webglError, setWebglError] = useState(false);
  const [assetError, setAssetError] = useState("");
  const [motionHint, setMotionHint] = useState("");
  const [loadedAssets, setLoadedAssets] = useState<string[]>([]);

  useEffect(() => {
    const host = hostRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setWebglError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute(
      "aria-label",
      "三维装配视图，拖动旋转，滚轮缩放，点击选择零件",
    );
    renderer.domElement.setAttribute("data-testid", "viewport-canvas");
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#e9eef2");
    scene.fog = new THREE.Fog("#e9eef2", 380, 1200);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.2, 2500);
    camera.position.set(108, 94, 125);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 13, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 8;
    controls.maxDistance = 900;
    controls.maxPolarAngle = Math.PI * 0.495;
    const ambient = new THREE.HemisphereLight("#eef7ff", "#8c9eaa", 2.4);
    scene.add(ambient);
    const key = new THREE.DirectionalLight("#fff5e9", 3.4);
    key.position.set(-60, 150, 70);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -155;
    key.shadow.camera.right = 155;
    key.shadow.camera.top = 155;
    key.shadow.camera.bottom = -155;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 450;
    key.shadow.normalBias = 0.14;
    key.shadow.bias = -0.0002;
    key.shadow.radius = 3;
    scene.add(key);
    const fill = new THREE.DirectionalLight("#d7e9ff", 1.3);
    fill.position.set(100, 50, -80);
    scene.add(fill);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({
        color: "#e8eef2",
        roughness: 0.95,
        metalness: 0,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.06;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(600, 60, "#b0c0c9", "#d2dde3");
    grid.position.y = 0.01;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.7;
    scene.add(grid);
    const origin = new THREE.Group();
    for (const [points, color] of [
      [[new THREE.Vector3(), new THREE.Vector3(25, 0, 0)], "#d98b77"],
      [[new THREE.Vector3(), new THREE.Vector3(0, 0, 25)], "#7c9ab9"],
    ] as [THREE.Vector3[], string][]) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }),
      );
      origin.add(line);
    }
    origin.position.y = 0.03;
    scene.add(origin);
    const wires = new THREE.Group();
    scene.add(wires);
    const selection = new THREE.Group();
    scene.add(selection);
    const transform = new TransformControls(camera, renderer.domElement);
    transform.setSize(0.8);
    scene.add(transform.getHelper());
    const models = new Map<string, Entry>();
    const contactLayer = new ContactMarkerLayer();
    scene.add(contactLayer.group);
    let alive = true;
    let frame = 0;
    let previousTime = performance.now();
    let pointerDown = new THREE.Vector2();
    let pointerMoved = false;
    let wasTransform = false;
    let dragAccepted: Part | null = null;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const rt: Runtime = {
      renderer,
      scene,
      camera,
      controls,
      transform,
      models,
      grid,
      wires,
      selection,
      selectionSignature: "",
      wireSignature: "",
      dragging: false,
      sync: () => {},
      fit: () => {},
    };
    runtimeRef.current = rt;
    const updateSelection = () => {
      const p = latest.current;
      const selected = p.parts.find(
        (part) => part.id === p.selectedId && part.visible,
      );
      const selectionSignature = JSON.stringify([
        selected?.id,
        selected?.size,
        selected?.kind,
        selected ? Boolean(p.deformations?.[selected.id]) : false,
      ]);
      if (selectionSignature !== rt.selectionSignature) {
        disposeObject(selection);
        selection.clear();
        rt.selectionSignature = selectionSignature;
        if (selected) {
          const model = models.get(selected.id)?.object;
          if (model) {
            selection.position.copy(model.position);
            selection.rotation.copy(model.rotation);
            const [w, h, d] = selected.size;
            const edge = new THREE.LineSegments(
              new THREE.EdgesGeometry(
                new THREE.BoxGeometry(w + 0.4, h + 0.4, d + 0.4),
              ),
              new THREE.LineBasicMaterial({
                color: "#26889e",
                transparent: true,
                opacity: 0.8,
                depthTest: false,
              }),
            );
            edge.renderOrder = 5;
            const frame = new THREE.Group();
            frame.name = "deformedSelectionFrame";
            frame.add(edge);
            selection.add(frame);
            const measuredWidth =
              selected.kind === "bayonet-pin"
                ? Math.max(
                    ...bayonetSolids(selected).flatMap((solid) =>
                      solid.vertices.map((v) => 2 * Math.hypot(v[0], v[2])),
                    ),
                  )
                : w;
            const dim = new THREE.Line(
              new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(-measuredWidth / 2, h / 2 + 5, d / 2 + 1),
                new THREE.Vector3(measuredWidth / 2, h / 2 + 5, d / 2 + 1),
              ]),
              new THREE.LineBasicMaterial({
                color: "#487482",
                depthTest: false,
              }),
            );
            selection.add(dim);
            for (const x of [-measuredWidth / 2, measuredWidth / 2])
              selection.add(
                new THREE.Line(
                  new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(x, h / 2 + 3.5, d / 2 + 1),
                    new THREE.Vector3(x, h / 2 + 6.5, d / 2 + 1),
                  ]),
                  new THREE.LineBasicMaterial({
                    color: "#487482",
                    depthTest: false,
                  }),
                ),
              );
            const label = labelSprite(
              `${p.deformations?.[selected.id] ? "初始 " : ""}${selected.kind === "bayonet-pin" ? "包络 Ø " : selected.kind === "bayonet-socket" ? "外径 Ø " : ""}${measuredWidth.toFixed(selected.kind === "bayonet-pin" ? 2 : 1)} mm`,
              "#3a6473",
              "#edf4f6",
            );
            label.position.set(0, h / 2 + 8, d / 2 + 1);
            selection.add(label);
          }
        }
      }
      if (selected) {
        const model = models.get(selected.id)?.object;
        if (model) {
          selection.position.copy(model.position);
          selection.rotation.copy(model.rotation);
          const frame = selection.getObjectByName("deformedSelectionFrame");
          if (frame)
            applyVisualDeformation(frame, p.deformations?.[selected.id]);
        }
      }
      if (!rt.dragging) {
        const model = selected ? models.get(selected.id)?.object : null;
        if (
          model &&
          !selected?.fixed &&
          !p.exploded &&
          !p.running &&
          (p.tool === "move" || p.tool === "rotate")
        ) {
          if (transform.object !== model) transform.attach(model);
          transform.setMode(p.tool === "move" ? "translate" : "rotate");
          transform.setSpace("world");
        } else transform.detach();
      }
    };
    rt.sync = () => {
      const p = latest.current;
      const ids = new Set(p.parts.map((part) => part.id));
      for (const [id, entry] of models)
        if (!ids.has(id)) {
          if (transform.object === entry.object) transform.detach();
          scene.remove(entry.object);
          disposeObject(entry.object);
          models.delete(id);
        }
      p.parts.forEach((part, index) => {
        const uploadedModel = part.model
          ? p.models?.find((model) => model.id === part.model!.id)
          : undefined;
        const sig = signature(part, uploadedModel);
        let entry = models.get(part.id);
        if (!entry || entry.signature !== sig) {
          if (entry) {
            if (transform.object === entry.object) transform.detach();
            scene.remove(entry.object);
            disposeObject(entry.object);
          }
          const object = new THREE.Group();
          object.userData.partId = part.id;
          const deformation = new THREE.Group();
          deformation.name = "partVisualDeformation";
          object.add(deformation);
          const hasSourceModel = Boolean(part.model || part.params.assetUrl);
          const visual = createPartVisual(
            hasSourceModel ? { ...part, kind: "asset" } : part,
          );
          applyPartMaterial(visual, part, { cloneMaterials: false });
          deformation.add(visual);
          entry = {
            object,
            deformation,
            signature: sig,
            loaded: !hasSourceModel,
          };
          models.set(part.id, entry);
          scene.add(object);
          if (hasSourceModel) {
            const currentEntry = entry;
            setLoadedAssets((previous) =>
              previous.filter((id) => id !== part.id),
            );
            const pending = part.model
              ? uploadedModel
                ? loadImportedModelScene(uploadedModel)
                : Promise.reject(new Error("项目缺少上传模型数据"))
              : loadAssetScene(String(part.params.assetUrl));
            pending
              .then((sourceScene) => {
                if (!alive || models.get(part.id) !== currentEntry) return;
                const source =
                  !part.model && part.params.assetNode
                    ? sourceScene.getObjectByName(String(part.params.assetNode))
                    : sourceScene;
                if (!source) {
                  setAssetError(`模型节点不存在：${part.name}`);
                  return;
                }
                const loaded = cloneAssetObject(source);
                const bounds = new THREE.Box3().setFromObject(loaded, true);
                const size = bounds.getSize(new THREE.Vector3());
                const center = bounds.getCenter(new THREE.Vector3());
                // Exported collections retain assembly coordinates. Normalize only their display wrapper.
                const wrapper = new THREE.Group();
                wrapper.add(loaded);
                loaded.position.sub(center);
                wrapper.scale.set(
                  part.size[0] / (size.x || 1),
                  part.size[1] / (size.y || 1),
                  part.size[2] / (size.z || 1),
                );
                loaded.traverse((child) => {
                  if (child instanceof THREE.Mesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    if (uploadedModel?.format === "stl") {
                      for (const material of Array.isArray(child.material)
                        ? child.material
                        : [child.material]) {
                        if (material instanceof THREE.MeshStandardMaterial)
                          material.color.set(part.color);
                      }
                    }
                  }
                });
                applyPartMaterial(loaded, part, { cloneMaterials: false });
                deformation.remove(visual);
                disposeObject(visual);
                deformation.add(wrapper);
                // The type owns these electrical contact proxies, independently of the visual mesh.
                if (
                  ["battery", "lamp", "button", "resistor"].includes(part.kind)
                ) {
                  for (const terminal of [0, 1]) {
                    const contact = new THREE.Mesh(
                      new THREE.SphereGeometry(0.8, 10, 8),
                      new THREE.MeshStandardMaterial({
                        color: terminal === 0 ? "#dc7055" : "#526877",
                      }),
                    );
                    contact.position.copy(terminalLocal(part, terminal));
                    contact.userData.terminal = terminal;
                    contact.userData.editorOverlay = true;
                    deformation.add(contact);
                  }
                }
                currentEntry.loaded = true;
                setLoadedAssets((previous) => [
                  ...new Set([...previous, part.id]),
                ]);
                appearance(
                  object,
                  latest.current.xray,
                  latest.current.collisionIds.includes(part.id),
                );
              })
              .catch(() => {
                if (alive && models.get(part.id) === currentEntry)
                  setAssetError(`无法载入 ${part.name}，当前显示尺寸包围盒`);
              });
          }
          rt.selectionSignature = "";
        }
        if (!(rt.dragging && transform.object === entry.object))
          partTransform(entry.object, part, index, p.exploded);
        applyVisualDeformation(entry.deformation, p.deformations?.[part.id]);
        appearance(entry.object, p.xray, p.collisionIds.includes(part.id));
      });
      contactLayer.update(p.exploded ? [] : (p.contactMarkers ?? []));
      viewportRef.current?.setAttribute(
        "data-contact-markers",
        JSON.stringify(contactLayer.poses()),
      );
      // Read committed Three transforms, rather than echoing input props, for mechanism diagnostics.
      const tracked = [...new Set(p.trackedPartIds ?? [])].flatMap((id) => {
        const object = models.get(id)?.object;
        return object ? [{ id, object }] : [];
      });
      viewportRef.current?.setAttribute(
        "data-rendered-positions",
        JSON.stringify(
          Object.fromEntries(
            tracked.map(({ id, object }) => [id, object.position.toArray()]),
          ),
        ),
      );
      viewportRef.current?.setAttribute(
        "data-rendered-rotations",
        JSON.stringify(
          Object.fromEntries(
            tracked.map(({ id, object }) => [
              id,
              [
                object.rotation.x / radians,
                object.rotation.y / radians,
                object.rotation.z / radians,
              ],
            ]),
          ),
        ),
      );
      grid.visible = p.showGrid;
      origin.visible = p.showGrid;
      updateSelection();
      const wireSignature = JSON.stringify([
        p.wires,
        p.parts.map((part) => [
          part.id,
          part.position,
          part.rotation,
          part.size,
          part.visible,
        ]),
        p.exploded,
        p.deformations,
        p.poweredLampIds,
      ]);
      if (wireSignature !== rt.wireSignature) {
        disposeObject(wires);
        wires.clear();
        rt.wireSignature = wireSignature;
        p.wires.forEach((wire) => {
          const from = p.parts.find((part) => part.id === wire.from.partId),
            to = p.parts.find((part) => part.id === wire.to.partId);
          const fromModel = from && models.get(from.id)?.deformation,
            toModel = to && models.get(to.id)?.deformation;
          if (
            !from ||
            !to ||
            !fromModel ||
            !toModel ||
            !from.visible ||
            !to.visible
          )
            return;
          fromModel.updateMatrixWorld(true);
          toModel.updateMatrixWorld(true);
          const start = worldTerminal(from, wire.from.terminal, fromModel),
            end = worldTerminal(to, wire.to.terminal, toModel);
          const distance = start.distanceTo(end);
          const a = start
            .clone()
            .add(new THREE.Vector3(0, Math.min(8, distance * 0.2), 0));
          const b = end
            .clone()
            .add(new THREE.Vector3(0, Math.min(8, distance * 0.2), 0));
          const midpoint = start.clone().lerp(end, 0.5);
          midpoint.y += Math.min(12, distance * 0.15);
          const curve = new THREE.CatmullRomCurve3([
            start,
            a,
            midpoint,
            b,
            end,
          ]);
          const mesh = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 48, 0.38, 8, false),
            new THREE.MeshStandardMaterial({
              color: wire.color,
              roughness: 0.52,
              metalness: 0.15,
            }),
          );
          mesh.castShadow = true;
          wires.add(mesh);
        });
      }
    };
    rt.fit = () => {
      const bounds = new THREE.Box3();
      models.forEach((entry) => {
        if (entry.object.visible) bounds.expandByObject(entry.object);
      });
      if (bounds.isEmpty())
        bounds.setFromCenterAndSize(
          new THREE.Vector3(0, 12, 0),
          new THREE.Vector3(86, 45, 64),
        );
      const center = bounds.getCenter(new THREE.Vector3());
      const extent = bounds.getSize(new THREE.Vector3());
      const max = Math.max(extent.x, extent.y, extent.z, 30);
      const distance = Math.max(max * 2.25, (max / camera.aspect) * 1.9);
      controls.target.copy(center);
      const view = latest.current.view;
      if (view === "top")
        camera.position
          .copy(center)
          .add(new THREE.Vector3(0.01, distance, 0.01));
      else if (view === "front")
        camera.position
          .copy(center)
          .add(new THREE.Vector3(0, max * 0.025, distance));
      else
        camera.position
          .copy(center)
          .add(
            new THREE.Vector3(0.78, 0.68, 0.95)
              .normalize()
              .multiplyScalar(distance),
          );
      camera.lookAt(center);
      controls.update();
    };
    transform.addEventListener("dragging-changed", (event) => {
      rt.dragging = Boolean(event.value);
      controls.enabled = !rt.dragging;
      if (rt.dragging) {
        wasTransform = true;
        dragAccepted = null;
        setMotionHint("拖动时实时检查装配路径");
      }
    });
    transform.addEventListener("objectChange", () => {
      if (!rt.dragging || !transform.object) return;
      const p = latest.current;
      const current = p.parts.find(
        (part) => part.id === transform.object?.userData.partId,
      );
      if (!current) return;
      const object = transform.object;
      const next: Part = {
        ...current,
        position: object.position.toArray() as Vec3,
        rotation: [
          object.rotation.x / radians,
          object.rotation.y / radians,
          object.rotation.z / radians,
        ],
      };
      const result = validateMotion(p.parts, current.id, next);
      if (result.allowed) {
        dragAccepted = next;
        appearance(object, p.xray, p.collisionIds.includes(current.id));
        setMotionHint("路径可达 · 松开应用");
      } else {
        setMotionHint(result.issues[0]?.title ?? "路径受到相邻零件阻挡");
        appearance(object, p.xray, true);
      }
      selection.position.copy(object.position);
      selection.rotation.copy(object.rotation);
    });
    transform.addEventListener("mouseUp", () => {
      const p = latest.current;
      const object = transform.object;
      if (!object) return;
      const current = p.parts.find(
        (part) => part.id === object.userData.partId,
      );
      if (!current) return;
      const next: Part = {
        ...current,
        position: object.position.toArray() as Vec3,
        rotation: [
          object.rotation.x / radians,
          object.rotation.y / radians,
          object.rotation.z / radians,
        ],
      };
      const result = validateMotion(p.parts, current.id, next);
      partTransform(object, current, p.parts.indexOf(current), p.exploded);
      rt.selectionSignature = "";
      if (result.allowed)
        p.onTransform(current.id, next.position, next.rotation);
      else if (dragAccepted) {
        p.onTransform(current.id, dragAccepted.position, dragAccepted.rotation);
        setMotionHint("已停在最后可达位置");
      } else setMotionHint(result.issues[0]?.title ?? "移动被阻挡");
      rt.sync();
    });
    const down = (event: PointerEvent) => {
      pointerDown.set(event.clientX, event.clientY);
      pointerMoved = false;
      wasTransform = rt.dragging || Boolean(transform.axis);
    };
    const move = (event: PointerEvent) => {
      if (
        pointerDown.distanceTo(
          new THREE.Vector2(event.clientX, event.clientY),
        ) > 4
      )
        pointerMoved = true;
    };
    const up = (event: PointerEvent) => {
      if (pointerMoved || wasTransform || event.button !== 0) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(
        [...models.values()]
          .filter((entry) => entry.object.visible)
          .map((entry) => entry.object),
        true,
      );
      let selected: string | null = null;
      if (hits.length) {
        let object: THREE.Object3D | null = hits[0].object;
        while (object && !object.userData.partId) object = object.parent;
        selected = object?.userData.partId ?? null;
      }
      latest.current.onSelect(selected);
      setMotionHint("");
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);
    const resize = () => {
      const width = host.clientWidth,
        height = host.clientHeight;
      if (width && height) {
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    rt.sync();
    rt.fit();
    const animate = (now: number) => {
      if (!alive) return;
      const dt = Math.min((now - previousTime) / 1000, 0.05);
      previousTime = now;
      const p = latest.current;
      p.parts.forEach((part) => {
        const entry = models.get(part.id);
        if (!entry) return;
        const compression = Number(
          part.params.compression ??
            (p.pressedIds.includes(part.id) ? (part.params.travel ?? 1) : 0),
        );
        const previous = Number(entry.object.userData.compression ?? 0);
        const value = THREE.MathUtils.lerp(
          previous,
          compression,
          1 - Math.exp(-dt * 24),
        );
        entry.object.userData.compression = value;
        const hasSourceModel = Boolean(part.model || part.params.assetUrl);
        const externallyDeformed = Boolean(p.deformations?.[part.id]);
        const coil = hasSourceModel
          ? undefined
          : entry.object.getObjectByName("spring");
        if (coil) {
          const height = Number(coil.userData.height);
          const internalCompression = externallyDeformed ? 0 : value;
          coil.scale.y = Math.max(
            0.15,
            (height - internalCompression) / height,
          );
          coil.position.y =
            (part.kind === "button" ? -part.size[1] * 0.02 : 0) -
            internalCompression / 2;
        }
        const actuator = hasSourceModel
          ? undefined
          : entry.object.getObjectByName("actuator");
        if (actuator) actuator.position.y = externallyDeformed ? 0 : -value;
        if (hasSourceModel && part.kind === "lamp" && entry.loaded) {
          const powered = p.poweredLampIds.includes(part.id);
          entry.object.traverse((child) => {
            if (
              !(child instanceof THREE.Mesh) ||
              child.userData.terminal !== undefined
            )
              return;
            for (const material of Array.isArray(child.material)
              ? child.material
              : [child.material]) {
              if (!(material instanceof THREE.MeshStandardMaterial)) continue;
              if (!material.userData.baseEmissive) {
                material.userData.baseEmissive = material.emissive.clone();
                material.userData.baseEmissiveIntensity =
                  material.emissiveIntensity;
              }
              material.emissive.copy(
                powered
                  ? new THREE.Color("#ffdf8a")
                  : material.userData.baseEmissive,
              );
              material.emissiveIntensity = powered
                ? 1.6
                : material.userData.baseEmissiveIntensity;
            }
          });
        }
        const bulb = (
          !hasSourceModel ? entry.object.getObjectByName("bulb") : undefined
        ) as THREE.Mesh | undefined;
        if (bulb) {
          const material = bulb.material as THREE.MeshStandardMaterial;
          const powered = p.poweredLampIds.includes(part.id);
          material.emissiveIntensity = powered ? 2.4 : 0;
          const light = entry.object.getObjectByName(
            "lampLight",
          ) as THREE.PointLight;
          if (light) light.intensity = powered ? 65 : 0;
        }
      });
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointermove", move);
      renderer.domElement.removeEventListener("pointerup", up);
      transform.dispose();
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      if (host.contains(renderer.domElement))
        host.removeChild(renderer.domElement);
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    runtimeRef.current?.sync();
  }, [
    props.parts,
    props.models,
    props.deformations,
    props.trackedPartIds,
    props.contactMarkers,
    props.wires,
    props.selectedId,
    props.tool,
    props.showGrid,
    props.xray,
    props.exploded,
    props.running,
    props.collisionIds,
    props.poweredLampIds,
  ]);
  useEffect(() => {
    runtimeRef.current?.fit();
  }, [props.view, props.resetKey]);
  return (
    <div
      ref={viewportRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 300,
        overflow: "hidden",
      }}
      data-testid="viewport"
      data-rendered-positions="{}"
      data-rendered-rotations="{}"
      data-contact-markers="{}"
      data-loaded-assets={
        props.parts.filter((part) => loadedAssets.includes(part.id)).length
      }
      data-powered-lamps={props.poweredLampIds.length}
      data-deformed-parts={
        Object.values(props.deformations ?? {}).filter(
          (value) => Math.abs(value.ratio - 1) > 0.0001,
        ).length
      }
    >
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      {webglError && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeContent: "center",
            padding: 40,
            color: "#627583",
          }}
        >
          无法初始化三维视图。请启用硬件加速或使用支持 WebGL 的浏览器。
        </div>
      )}
      {Boolean(props.contactMarkers?.length) && !props.exploded && (
        <div
          aria-label="机械接触点标记"
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            padding: "6px 9px",
            borderRadius: 5,
            background: "rgba(255,255,255,.92)",
            color: "#506c79",
            fontSize: 11,
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              color: props.contactMarkers?.some((marker) => marker.contact)
                ? "#20a66b"
                : "#d58a31",
            }}
          >
            ● 撞针端点
          </span>
          {" · "}
          <span
            style={{
              color: props.contactMarkers?.some((marker) => marker.contact)
                ? "#20a66b"
                : "#248dcd",
            }}
          >
            ◌ 固定触发点
          </span>
          {" · "}
          {props.contactMarkers?.some((marker) => marker.contact)
            ? "接触"
            : "分离"}
        </div>
      )}
      {(motionHint || props.exploded || assetError) && (
        <div
          style={{
            position: "absolute",
            bottom: 54,
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: "85%",
            padding: "8px 13px",
            borderRadius: 6,
            background: "rgba(255,255,255,.94)",
            border: "1px solid #d7e2e8",
            color: "#506c79",
            fontSize: 11,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {motionHint ||
            (props.exploded ? "爆炸视图 · 仅用于观察零件层级" : assetError)}
        </div>
      )}
    </div>
  );
}
