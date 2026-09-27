/**
 * The task dialog pattern FreeCAD's feature commands follow (`TaskFeatureParameters`): the command
 * opens a transaction and creates the feature; the dialog edits its properties with a live
 * recompute; OK commits the transaction (one undo step), Cancel aborts it (the feature is gone and
 * whatever the command hid is shown again).
 */
import { useState, type ReactNode } from "react";
import { isTaggedAs, type PropertyInput } from "@fab-cad/client";
import { errorText, settle } from "../commands/actions";
import { fixed, pyBool, pyNum, pyStr } from "../lib/format";
import { assignmentEcho, quantityOf } from "../properties/model";
import { useApp } from "../state/app";
import { echo, log } from "../state/console";
import { client, labelOf, property, refreshUndo, useModel } from "../state/session";
import { CheckBox, ComboBox, FloatSpinBox, FormRow, GroupBox, QuantitySpinBox } from "../ui/widgets";

export interface FieldDef {
  prop: string;
  label: string;
  kind: "quantity" | "float" | "int" | "bool" | "enum";
  /** Display names for enumeration values (`Length` → `Dimension`). */
  enumLabels?: Record<string, string>;
  /** Only shown when this returns true (reads other properties' current values). */
  visible?: (get: (prop: string) => unknown) => boolean;
  min?: number;
  max?: number;
  step?: number;
}

export interface FeatureTaskSpec {
  doc: string;
  object: string;
  title: string;
  icon: string;
  fields: FieldDef[];
  /** Extra content above or below the fields (edge lists, plane choices, ...). */
  extra?: () => ReactNode;
  /** Runs after the transaction is committed. */
  afterAccept?: () => Promise<void> | void;
  /** Runs after the transaction is aborted. */
  afterReject?: () => Promise<void> | void;
}

/** Set properties of the feature inside the open transaction, echo, and recompute. */
export async function setLive(
  doc: string,
  object: string,
  values: Record<string, PropertyInput>,
  python: Record<string, string>,
): Promise<void> {
  echo(Object.entries(python).map(([k, v]) => assignmentEcho(doc, object, k, v)));
  try {
    await client().setProperties(doc, object, values);
    const r = await client().recompute(doc);
    for (const e of r.errors) log.error(`${labelOf(doc, e.object)}: ${e.message}`);
  } catch (e) {
    log.error(errorText(e));
  }
  await settle();
}

function FieldEditor({ doc, object, f }: { doc: string; object: string; f: FieldDef }) {
  useModel();
  const p = property(doc, object, f.prop);
  if (!p) return null;
  const ro = p.status.includes("ReadOnly");
  const testId = `task-${f.prop}`;
  switch (f.kind) {
    case "quantity": {
      const q = quantityOf(p.value, p.unit);
      return (
        <QuantitySpinBox
          value={q.value}
          unit={q.unit || p.unit || "mm"}
          min={f.min}
          max={f.max}
          step={f.step}
          disabled={ro}
          testId={testId}
          onCommit={(v) =>
            void setLive(
              doc,
              object,
              { [f.prop]: { $type: "Quantity", value: v, unit: q.unit || p.unit || "mm" } },
              { [f.prop]: pyStr(`${fixed(v)} ${q.unit}`) },
            )
          }
        />
      );
    }
    case "float":
    case "int":
      return (
        <FloatSpinBox
          value={typeof p.value === "number" ? p.value : 0}
          integer={f.kind === "int"}
          min={f.min}
          max={f.max}
          step={f.step}
          disabled={ro}
          testId={testId}
          onCommit={(v) => void setLive(doc, object, { [f.prop]: v }, { [f.prop]: f.kind === "int" ? String(v) : pyNum(v) })}
        />
      );
    case "bool":
      return (
        <CheckBox
          checked={!!p.value}
          disabled={ro}
          testId={testId}
          onChange={(b) => void setLive(doc, object, { [f.prop]: b }, { [f.prop]: pyBool(b) })}
          label={f.label}
        />
      );
    case "enum":
      return (
        <ComboBox
          value={String(p.value)}
          disabled={ro}
          testId={testId}
          options={(p.enum ?? []).filter((v) => !v.startsWith("?")).map((v) => ({ value: v, label: f.enumLabels?.[v] ?? v }))}
          onChange={(v) => void setLive(doc, object, { [f.prop]: v }, { [f.prop]: pyStr(v) })}
        />
      );
  }
}

function FeatureTaskBody({ spec }: { spec: FeatureTaskSpec }) {
  useModel();
  const get = (prop: string) => {
    const v = property(spec.doc, spec.object, prop)?.value;
    return isTaggedAs(v, "Quantity") ? v.value : v;
  };
  return (
    <GroupBox title={`${spec.title} parameters`} icon={spec.icon}>
      {spec.extra?.()}
      {spec.fields
        .filter((f) => property(spec.doc, spec.object, f.prop) && (!f.visible || f.visible(get)))
        .map((f) =>
          f.kind === "bool" ? (
            <div className="form-row" key={f.prop}>
              <FieldEditor doc={spec.doc} object={spec.object} f={f} />
            </div>
          ) : (
            <FormRow key={f.prop} label={f.label}>
              <FieldEditor doc={spec.doc} object={spec.object} f={f} />
            </FormRow>
          ),
        )}
    </GroupBox>
  );
}

/** Open the dialog for a feature created inside an open transaction. */
export function openFeatureTask(spec: FeatureTaskSpec): void {
  useApp.getState().openTask({
    id: `feature:${spec.doc}:${spec.object}`,
    title: spec.title,
    icon: spec.icon,
    render: () => <FeatureTaskBody spec={spec} />,
    accept: async () => {
      await client().recompute(spec.doc);
      await client().commitTransaction(spec.doc);
      echo(`App.getDocument(${pyStr(spec.doc)}).recompute()`);
      await settle();
      void refreshUndo(spec.doc);
      await spec.afterAccept?.();
    },
    reject: async () => {
      await client()
        .abortTransaction(spec.doc)
        .catch(() => undefined);
      echo(`App.getDocument(${pyStr(spec.doc)}).abortTransaction()`);
      await settle();
      void refreshUndo(spec.doc);
      await spec.afterReject?.();
    },
  });
}

/** A task dialog with free content and OK / Cancel (dialogs that create on OK: primitives, booleans). */
export function openSimpleTask(opts: {
  id: string;
  title: string;
  icon: string;
  render: () => ReactNode;
  accept: () => Promise<boolean | void> | boolean | void;
  reject?: () => Promise<void> | void;
  buttons?: ("ok" | "cancel" | "close")[];
}): void {
  useApp.getState().openTask({
    id: opts.id,
    title: opts.title,
    icon: opts.icon,
    render: opts.render,
    accept: opts.accept,
    reject: opts.reject ?? (() => undefined),
    ...(opts.buttons ? { buttons: opts.buttons } : {}),
  });
}

/** Local state hook for simple task forms. */
export function useForm<T extends Record<string, unknown>>(initial: T): [T, (patch: Partial<T>) => void] {
  const [v, setV] = useState(initial);
  return [v, (patch) => setV((cur) => ({ ...cur, ...patch }))];
}
