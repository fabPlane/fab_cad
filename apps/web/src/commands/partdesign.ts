/**
 * Part Design commands (`src/Mod/PartDesign/Gui/Command*.cpp`). Part Design features are created
 * the way FreeCAD's commands create them — with Python (`body.newObject(...)`, `Profile`,
 * `Base = (feature, ['Edge1'])`) through `RunPython` — inside an API transaction, and edited in a
 * feature task dialog before OK commits (Cancel aborts).
 */
import { client } from "../state/session";
import { activeBody, bodyOf, useActiveBody } from "../state/activeBody";
import { useApp } from "../state/app";
import { echo, log } from "../state/console";
import { selectedObjects, useSelection } from "../state/selection";
import { object, objects } from "../state/session";
import { pyStr } from "../lib/format";
import { openFeatureTask, type FieldDef } from "../tasks/featureTask";
import { openSketchPlaneTask } from "../tasks/sketchTasks";
import { command, errorText, pythonJson, settle } from "./actions";
import { registerCommands, type CommandContext, type CommandDef } from "./registry";

const hasDoc = (c: CommandContext) => c.connected && !!c.doc && !c.editing && !c.taskOpen;

const q = (s: string) => pyStr(s);
const obj = (doc: string, name: string) => `App.getDocument(${q(doc)}).getObject(${q(name)})`;

async function runPy(code: string): Promise<void> {
  const r = await client().runPython(code, "exec");
  if (r.exception) throw new Error(r.exception.trim().split("\n").pop() ?? r.exception);
}

/** Body origin features by role (`XY_Plane` → its internal name). */
export async function originFeatures(doc: string, body: string): Promise<Record<string, string>> {
  return pythonJson<Record<string, string>>(
    "import json",
    `json.dumps({f.Role: f.Name for f in App.getDocument(${q(doc)}).getObject(${q(body)}).Origin.OriginFeatures})`,
  );
}

/** `PartDesign_Body`: a body with its origin hidden, made active. */
export async function createBody(doc: string): Promise<string> {
  let name = "";
  await command(doc, "Create body", async () => {
    const info = await client().addObject(doc, "PartDesign::Body", { name: "Body" });
    name = info.name;
    await runPy(
      [
        `__b = ${obj(doc, name)}`,
        "if __b.Origin:",
        "    __b.Origin.Visibility = False",
        "    for __f in __b.Origin.OriginFeatures: __f.Visibility = False",
        "del __b",
      ].join("\n"),
    ).catch(() => undefined);
  });
  echo([
    `App.activeDocument().addObject('PartDesign::Body','${name}')`,
    `App.ActiveDocument.getObject('${name}').Label = 'Body'`,
    `Gui.activateView('Gui::View3DInventor', True)`,
    `Gui.activeView().setActiveObject('pdbody', App.activeDocument().${name})`,
    "Gui.Selection.clearSelection()",
    `Gui.Selection.addSelection(App.ActiveDocument.${name})`,
    "App.ActiveDocument.recompute()",
  ]);
  useActiveBody.getState().set(doc, name);
  useSelection.getState().select({ doc, object: name, sub: "" }, { echo: false });
  return name;
}

async function ensureBody(doc: string): Promise<string> {
  const b = activeBody(doc);
  if (b) return b;
  return createBody(doc);
}

// ------------------------------------------------------------------------------ sketches

/** `PartDesign_NewSketch`: on a selected planar face, or on a base plane chosen in the task dialog. */
export async function newPartDesignSketch(doc: string): Promise<void> {
  const sel = useSelection.getState().selection.filter((s) => s.doc === doc);
  const face = sel.find((s) => s.sub.startsWith("Face"));
  const body = face ? (bodyOf(doc, face.object) ?? (await ensureBody(doc))) : await ensureBody(doc);
  if (face) {
    await createAttachedSketch(doc, body, face.object, face.sub);
    return;
  }
  const origin = await originFeatures(doc, body);
  openSketchPlaneTask(doc, async (plane) => {
    const target = origin[plane];
    if (!target) throw new Error(`the body has no ${plane}`);
    await createAttachedSketch(doc, body, target, "");
  });
}

export async function createAttachedSketch(doc: string, body: string | null, support: string, sub: string): Promise<string> {
  let name = "";
  const lines = [
    body
      ? `${obj(doc, body)}.newObject('Sketcher::SketchObject','Sketch')`
      : `App.activeDocument().addObject('Sketcher::SketchObject','Sketch')`,
    `App.getDocument(${q(doc)}).getObject('Sketch').AttachmentSupport = (${obj(doc, support)},[${q(sub)}])`,
    `App.getDocument(${q(doc)}).getObject('Sketch').MapMode = 'FlatFace'`,
    "App.ActiveDocument.recompute()",
  ];
  echo(lines);
  await command(doc, "Create a new sketch", async () => {
    const r = await pythonJson<{ name: string }>(
      [
        "import json",
        `__d = App.getDocument(${q(doc)})`,
        body
          ? `__sk = __d.getObject(${q(body)}).newObject('Sketcher::SketchObject','Sketch')`
          : "__sk = __d.addObject('Sketcher::SketchObject','Sketch')",
        `__sk.AttachmentSupport = (__d.getObject(${q(support)}),[${q(sub)}])`,
        "__sk.MapMode = 'FlatFace'",
      ].join("\n"),
      "json.dumps({'name': __sk.Name})",
    );
    name = r.name;
  });
  echo(`Gui.getDocument(${q(doc)}).setEdit(App.getDocument(${q(doc)}).getObject(${q(name)}), 0)`);
  const { startSketchEdit } = await import("../sketcher/session");
  await startSketchEdit(doc, name);
  return name;
}

// ------------------------------------------------------------------------------ sketch-based features

const TYPE_LABELS: Record<string, string> = {
  Length: "Dimension",
  UpToLast: "Through all",
  UpToFirst: "To first",
  UpToFace: "Up to face",
  TwoLengths: "Two dimensions",
  UpToShape: "Up to shape",
  ThroughAll: "Through all",
  Angle: "Dimension",
};

const noSideType = (get: (p: string) => unknown) => get("SideType") === undefined;

export const FEATURE_FIELDS: Record<string, FieldDef[]> = {
  Pad: [
    { prop: "Type", label: "Type", kind: "enum", enumLabels: TYPE_LABELS },
    { prop: "Length", label: "Length", kind: "quantity" },
    { prop: "SideType", label: "Side", kind: "enum" },
    { prop: "Length2", label: "2nd length", kind: "quantity", visible: (g) => g("Type") === "TwoLengths" || g("SideType") === "Two sides" },
    { prop: "Offset", label: "Offset to face", kind: "quantity", visible: (g) => g("Type") === "UpToFace" },
    { prop: "Midplane", label: "Symmetric to plane", kind: "bool", visible: noSideType },
    { prop: "Reversed", label: "Reversed", kind: "bool" },
    { prop: "TaperAngle", label: "Taper angle", kind: "quantity" },
    { prop: "Refine", label: "Refine", kind: "bool" },
  ],
  Pocket: [
    { prop: "Type", label: "Type", kind: "enum", enumLabels: TYPE_LABELS },
    { prop: "Length", label: "Length", kind: "quantity" },
    { prop: "SideType", label: "Side", kind: "enum" },
    { prop: "Length2", label: "2nd length", kind: "quantity", visible: (g) => g("Type") === "TwoLengths" || g("SideType") === "Two sides" },
    { prop: "Midplane", label: "Symmetric to plane", kind: "bool", visible: noSideType },
    { prop: "Reversed", label: "Reversed", kind: "bool" },
    { prop: "TaperAngle", label: "Taper angle", kind: "quantity" },
    { prop: "Refine", label: "Refine", kind: "bool" },
  ],
  Revolution: [
    { prop: "Type", label: "Type", kind: "enum", enumLabels: TYPE_LABELS },
    { prop: "Angle", label: "Angle", kind: "quantity" },
    { prop: "SideType", label: "Side", kind: "enum" },
    { prop: "Midplane", label: "Symmetric to plane", kind: "bool", visible: noSideType },
    { prop: "Reversed", label: "Reversed", kind: "bool" },
    { prop: "Refine", label: "Refine", kind: "bool" },
  ],
  Groove: [
    { prop: "Type", label: "Type", kind: "enum", enumLabels: TYPE_LABELS },
    { prop: "Angle", label: "Angle", kind: "quantity" },
    { prop: "SideType", label: "Side", kind: "enum" },
    { prop: "Midplane", label: "Symmetric to plane", kind: "bool", visible: noSideType },
    { prop: "Reversed", label: "Reversed", kind: "bool" },
    { prop: "Refine", label: "Refine", kind: "bool" },
  ],
  Fillet: [
    { prop: "Radius", label: "Radius", kind: "quantity" },
    { prop: "UseAllEdges", label: "Use all edges", kind: "bool" },
  ],
  Chamfer: [
    { prop: "ChamferType", label: "Type", kind: "enum" },
    { prop: "Size", label: "Size", kind: "quantity" },
    { prop: "Size2", label: "Size 2", kind: "quantity", visible: (g) => g("ChamferType") === "Two distances" },
    { prop: "Angle", label: "Angle", kind: "quantity", visible: (g) => g("ChamferType") === "Distance and Angle" },
    { prop: "FlipDirection", label: "Flip direction", kind: "bool" },
    { prop: "UseAllEdges", label: "Use all edges", kind: "bool" },
  ],
  Mirrored: [{ prop: "Refine", label: "Refine", kind: "bool" }],
  LinearPattern: [
    { prop: "Mode", label: "Mode", kind: "enum" },
    { prop: "Length", label: "Length", kind: "quantity" },
    { prop: "Offset", label: "Offset", kind: "quantity" },
    { prop: "Occurrences", label: "Occurrences", kind: "int", min: 1 },
    { prop: "Reversed", label: "Reverse direction", kind: "bool" },
  ],
  PolarPattern: [
    { prop: "Mode", label: "Mode", kind: "enum" },
    { prop: "Angle", label: "Angle", kind: "quantity" },
    { prop: "Offset", label: "Offset", kind: "quantity" },
    { prop: "Occurrences", label: "Occurrences", kind: "int", min: 1 },
    { prop: "Reversed", label: "Reverse direction", kind: "bool" },
  ],
};

const FEATURE_TITLES: Record<string, string> = {
  Pad: "Pad",
  Pocket: "Pocket",
  Revolution: "Revolution",
  Groove: "Groove",
  Fillet: "Fillet",
  Chamfer: "Chamfer",
  Mirrored: "Mirror",
  LinearPattern: "Linear Pattern",
  PolarPattern: "Polar Pattern",
};

/** The profile for a sketch-based feature: the selected sketch, else the body's last unused sketch. */
export function findProfile(doc: string, body: string | null): string | null {
  const sel = selectedObjects(useSelection.getState().selection, doc)
    .map((n) => object(doc, n))
    .find((o) => o?.type === "Sketcher::SketchObject");
  if (sel) return sel.name;
  const sketches = objects(doc).filter(
    (o) =>
      o.type === "Sketcher::SketchObject" &&
      (!body || bodyOf(doc, o.name) === body) &&
      !o.inList.some((n) =>
        /^PartDesign::(Pad|Pocket|Revolution|Groove|AdditiveLoft|SubtractiveLoft|AdditivePipe|SubtractivePipe)$/.test(
          object(doc, n)?.type ?? "",
        ),
      ),
  );
  return sketches[sketches.length - 1]?.name ?? null;
}

async function sketchBased(doc: string, kind: "Pad" | "Pocket" | "Revolution" | "Groove"): Promise<void> {
  const selBody = selectedObjects(useSelection.getState().selection, doc)
    .map((n) => bodyOf(doc, n))
    .find((b) => b);
  const body = selBody ?? (await ensureBody(doc));
  const profile = findProfile(doc, body);
  if (!profile) {
    log.warning(`${kind}: select a sketch (a closed profile) first, or create one with "Create sketch".`);
    return;
  }
  const defaults: Record<string, string> = {
    Pad: "f.Length = 10\nf.ReferenceAxis = (sk,['N_Axis'])",
    Pocket: "f.Length = 5\nf.ReferenceAxis = (sk,['N_Axis'])",
    Revolution: "f.ReferenceAxis = (sk,['V_Axis'])\nf.Angle = 360.0",
    Groove: "f.ReferenceAxis = (sk,['V_Axis'])\nf.Angle = 360.0",
  };
  const c = client();
  await c.openTransaction(doc, kind);
  try {
    const r = await pythonJson<{ name: string }>(
      [
        "import json",
        `__d = App.getDocument(${q(doc)})`,
        `__b = __d.getObject(${q(body)})`,
        `sk = __d.getObject(${q(profile)})`,
        "__prev = __b.Tip",
        `f = __b.newObject('PartDesign::${kind}','${kind}')`,
        "f.Profile = (sk, ['',])",
        defaults[kind]!,
        "sk.Visibility = False",
        "if __prev and __prev != f: __prev.Visibility = False",
        "__d.recompute()",
      ].join("\n"),
      "json.dumps({'name': f.Name})",
    );
    const name = r.name;
    echo([
      `${obj(doc, body)}.newObject('PartDesign::${kind}','${name}')`,
      `${obj(doc, name)}.Profile = (${obj(doc, profile)}, ['',])`,
      ...defaults[kind]!.split("\n").map((l) => l.replace(/^f\./, `${obj(doc, name)}.`).replace("(sk,", `(${obj(doc, profile)},`)),
      "App.ActiveDocument.recompute()",
      `${obj(doc, profile)}.Visibility = False`,
    ]);
    await settle();
    useSelection.getState().select({ doc, object: name, sub: "" }, { echo: false });
    openFeatureTask({ doc, object: name, title: FEATURE_TITLES[kind]!, icon: `PartDesign_${kind}`, fields: FEATURE_FIELDS[kind]! });
  } catch (e) {
    await c.abortTransaction(doc).catch(() => undefined);
    await settle();
    log.error(`${kind} failed: ${errorText(e)}`);
  }
}

// ------------------------------------------------------------------------------ dress-up

async function dressUp(doc: string, kind: "Fillet" | "Chamfer"): Promise<void> {
  const sel = useSelection.getState().selection.filter((s) => s.doc === doc && /^(Edge|Face)\d+$/.test(s.sub));
  const base = sel[0]?.object;
  if (!base) {
    log.warning(`${kind}: select edges or faces of a Part Design feature first.`);
    return;
  }
  const subs = [...new Set(sel.filter((s) => s.object === base).map((s) => s.sub))];
  const body = bodyOf(doc, base) ?? (await ensureBody(doc));
  const value = kind === "Fillet" ? "f.Radius = 1" : "f.Size = 1";
  const c = client();
  await c.openTransaction(doc, kind);
  try {
    const r = await pythonJson<{ name: string }>(
      [
        "import json",
        `__d = App.getDocument(${q(doc)})`,
        `__b = __d.getObject(${q(body)})`,
        `__base = __d.getObject(${q(base)})`,
        `f = __b.newObject('PartDesign::${kind}','${kind}')`,
        `f.Base = (__base, [${subs.map(q).join(",")}])`,
        value,
        "__base.Visibility = False",
        "__d.recompute()",
      ].join("\n"),
      "json.dumps({'name': f.Name})",
    );
    const name = r.name;
    echo([
      `${obj(doc, body)}.newObject('PartDesign::${kind}','${name}')`,
      `${obj(doc, name)}.Base = (${obj(doc, base)},[${subs.map(q).join(",")}])`,
      value.replace("f.", `${obj(doc, name)}.`),
      `${obj(doc, base)}.Visibility = False`,
      "App.ActiveDocument.recompute()",
    ]);
    await settle();
    useSelection.getState().select({ doc, object: name, sub: "" }, { echo: false });
    openFeatureTask({
      doc,
      object: name,
      title: kind,
      icon: `PartDesign_${kind}`,
      fields: FEATURE_FIELDS[kind]!,
      extra: () => `${subs.length} element${subs.length === 1 ? "" : "s"}: ${subs.join(", ")}`,
    });
  } catch (e) {
    await c.abortTransaction(doc).catch(() => undefined);
    await settle();
    log.error(`${kind} failed: ${errorText(e)}`);
  }
}

// ------------------------------------------------------------------------------ transformations

async function transformed(doc: string, kind: "Mirrored" | "LinearPattern" | "PolarPattern"): Promise<void> {
  const features = selectedObjects(useSelection.getState().selection, doc).filter((n) =>
    (object(doc, n)?.type ?? "").startsWith("PartDesign::"),
  );
  if (!features.length) {
    log.warning(`${kind}: select the features to transform first.`);
    return;
  }
  const body = bodyOf(doc, features[0]!) ?? (await ensureBody(doc));
  const origin = await originFeatures(doc, body);
  const setup: Record<string, string> = {
    Mirrored: `f.MirrorPlane = (__d.getObject(${q(origin.YZ_Plane ?? "YZ_Plane")}), [''])`,
    LinearPattern: `f.Direction = (__d.getObject(${q(origin.X_Axis ?? "X_Axis")}), [''])\nf.Length = 30\nf.Occurrences = 3`,
    PolarPattern: `f.Axis = (__d.getObject(${q(origin.Z_Axis ?? "Z_Axis")}), [''])\nf.Angle = 360\nf.Occurrences = 3`,
  };
  const c = client();
  await c.openTransaction(doc, kind);
  try {
    const r = await pythonJson<{ name: string }>(
      [
        "import json",
        `__d = App.getDocument(${q(doc)})`,
        `__b = __d.getObject(${q(body)})`,
        "__prev = __b.Tip",
        `f = __b.newObject('PartDesign::${kind}','${kind}')`,
        `f.Originals = [${features.map((n) => `__d.getObject(${q(n)})`).join(",")}]`,
        setup[kind]!,
        "if __prev and __prev != f: __prev.Visibility = False",
        "__d.recompute()",
      ].join("\n"),
      "json.dumps({'name': f.Name})",
    );
    const name = r.name;
    echo([
      `${obj(doc, body)}.newObject('PartDesign::${kind}','${name}')`,
      `${obj(doc, name)}.Originals = [${features.map((n) => obj(doc, n)).join(",")}]`,
      ...setup[kind]!.split("\n").map((l) =>
        l.replace(/^f\./, `${obj(doc, name)}.`).replace(/__d\.getObject/g, `App.getDocument(${q(doc)}).getObject`),
      ),
      "App.ActiveDocument.recompute()",
    ]);
    await settle();
    useSelection.getState().select({ doc, object: name, sub: "" }, { echo: false });
    openFeatureTask({ doc, object: name, title: FEATURE_TITLES[kind]!, icon: `PartDesign_${kind}`, fields: FEATURE_FIELDS[kind]! });
  } catch (e) {
    await c.abortTransaction(doc).catch(() => undefined);
    await settle();
    log.error(`${kind} failed: ${errorText(e)}`);
  }
}

/** Double-click on a Part Design feature: its parameters in a task dialog, one undo step. */
export async function editFeature(doc: string, name: string): Promise<void> {
  const o = object(doc, name);
  if (!o || useApp.getState().task) return;
  const kind = o.type.replace(/^PartDesign::/, "");
  const fields = FEATURE_FIELDS[kind];
  if (!fields) return;
  await client().openTransaction(doc, `Edit ${o.label}`);
  echo(`Gui.getDocument(${q(doc)}).setEdit(App.getDocument(${q(doc)}).getObject(${q(name)}), 0)`);
  openFeatureTask({ doc, object: name, title: FEATURE_TITLES[kind] ?? kind, icon: `PartDesign_${kind}`, fields });
}

export function registerPartDesignCommands(): void {
  const list: CommandDef[] = [
    { id: "PartDesign_Body", isActive: hasDoc, run: (c) => createBody(c.doc!) },
    { id: "PartDesign_NewSketch", isActive: hasDoc, run: (c) => newPartDesignSketch(c.doc!) },
    { id: "PartDesign_CompSketches", items: ["PartDesign_NewSketch", "Sketcher_MapSketch", "Sketcher_EditSketch"] },
    { id: "PartDesign_Pad", isActive: hasDoc, run: (c) => sketchBased(c.doc!, "Pad") },
    { id: "PartDesign_Pocket", isActive: hasDoc, run: (c) => sketchBased(c.doc!, "Pocket") },
    { id: "PartDesign_Revolution", isActive: hasDoc, run: (c) => sketchBased(c.doc!, "Revolution") },
    { id: "PartDesign_Groove", isActive: hasDoc, run: (c) => sketchBased(c.doc!, "Groove") },
    { id: "PartDesign_Fillet", isActive: hasDoc, run: (c) => dressUp(c.doc!, "Fillet") },
    { id: "PartDesign_Chamfer", isActive: hasDoc, run: (c) => dressUp(c.doc!, "Chamfer") },
    { id: "PartDesign_Mirrored", isActive: hasDoc, run: (c) => transformed(c.doc!, "Mirrored") },
    { id: "PartDesign_LinearPattern", isActive: hasDoc, run: (c) => transformed(c.doc!, "LinearPattern") },
    { id: "PartDesign_PolarPattern", isActive: hasDoc, run: (c) => transformed(c.doc!, "PolarPattern") },
    {
      id: "PartDesign_CompPrimitiveAdditive",
      items: ["PartDesign_AdditiveBox", "PartDesign_AdditiveCylinder", "PartDesign_AdditiveSphere", "PartDesign_AdditiveCone"],
    },
    {
      id: "PartDesign_CompPrimitiveSubtractive",
      items: ["PartDesign_SubtractiveBox", "PartDesign_SubtractiveCylinder", "PartDesign_SubtractiveSphere", "PartDesign_SubtractiveCone"],
    },
    ...(["Box", "Cylinder", "Sphere", "Cone"] as const).flatMap((p) =>
      (["Additive", "Subtractive"] as const).map(
        (k): CommandDef => ({
          id: `PartDesign_${k}${p}`,
          menuText: `${k} ${p.toLowerCase()}`,
          pixmap: `PartDesign_${k}${p}`,
          isActive: hasDoc,
          run: async (c) => {
            const doc = c.doc!;
            const body = await ensureBody(doc);
            await command(doc, `${k} ${p}`, async () => {
              await runPy(
                [
                  `__d = App.getDocument(${q(doc)})`,
                  `__b = __d.getObject(${q(body)})`,
                  "__prev = __b.Tip",
                  `__f = __b.newObject('PartDesign::${k}${p}','${k}${p}')`,
                  "if __prev and __prev != __f: __prev.Visibility = False",
                ].join("\n"),
              );
            });
            echo(`${obj(doc, body)}.newObject('PartDesign::${k}${p}','${k}${p}')`);
          },
        }),
      ),
    ),
    {
      id: "PartDesign_DuplicateSelection",
      isActive: (c) => hasDoc(c) && c.selection.length > 0,
      run: async (c) => {
        const { runCommand } = await import("./registry");
        const { makeContext } = await import("./context");
        await runCommand("Std_DuplicateSelection", makeContext());
      },
    },
  ];
  registerCommands(list);
}
