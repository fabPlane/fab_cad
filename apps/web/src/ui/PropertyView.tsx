/**
 * The property view (`Gui::PropertyView`): View and Data tabs, properties grouped and collapsible,
 * name and value columns, an editor per property type, placements and vectors expandable into
 * sub-rows, read-only values greyed, expressions (`=` starts one; the tooltip shows it). Edits go
 * through `setProperties` in one transaction with a recompute, like FreeCAD's property editor.
 */
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useState, type ReactNode } from "react";
import type { PropertyInfo } from "@fab-cad/client";
import { editExpression, editProperty, errorText, setVisibility } from "../commands/actions";
import { cssToTuple, fixed, formatColor, formatQuantity, pyStr, splitCamelCase, tupleToCss } from "../lib/format";
import {
  applySubEdit,
  displayValue,
  groupProperties,
  isReadOnly,
  parseInput,
  propertyKind,
  quantityOf,
  subRows,
  type SubRow,
} from "../properties/model";
import { useApp } from "../state/app";
import { echo, log } from "../state/console";
import { prompt } from "../state/dialogs";
import { useSelection } from "../state/selection";
import { labelOf, object, properties, useModel } from "../state/session";
import { VIEW_PROPERTY_DEFS, useViewProps, viewPropsOf, type ViewProps } from "../state/viewprops";
import { CheckBox, ComboBox, FloatSpinBox, Icon, QuantitySpinBox } from "./widgets";

export function PropertyView() {
  useModel();
  const selection = useSelection((s) => s.selection);
  const tab = useApp((s) => s.propertyTab);
  const showAll = useApp((s) => s.showAllProperties);
  const first = selection[0];
  const o = first ? object(first.doc, first.object) : undefined;
  return (
    <div className="property-view" data-testid="property-view">
      <div className="prop-table">
        <div className="prop-header">
          <div>Property</div>
          <div>Value</div>
        </div>
        {!first || !o ? null : tab === "data" ? (
          <DataRows doc={first.doc} name={first.object} showAll={showAll} />
        ) : (
          <ViewRows doc={first.doc} name={first.object} type={o.type} visibility={o.visibility} />
        )}
      </div>
      <div className="tabs bottom">
        <div
          className={`tab ${tab === "view" ? "active" : ""}`}
          data-testid="prop-tab-view"
          onClick={() => useApp.getState().setPropertyTab("view")}
        >
          View
        </div>
        <div
          className={`tab ${tab === "data" ? "active" : ""}`}
          data-testid="prop-tab-data"
          onClick={() => useApp.getState().setPropertyTab("data")}
        >
          Data
        </div>
      </div>
    </div>
  );
}

function GroupRow({ name, open, toggle }: { name: string; open: boolean; toggle: () => void }) {
  return (
    <div className="prop-row group" onClick={toggle} data-testid={`prop-group-${name}`}>
      <div>
        <span style={{ fontSize: 9, width: 12 }}>{open ? "▼" : "▶"}</span>
        {name}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------ Data tab

function DataRows({ doc, name, showAll }: { doc: string; name: string; showAll: boolean }) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const groups = groupProperties(properties(doc, name), { showAll });
  const out: ReactNode[] = [];
  for (const g of groups) {
    const open = !closed.has(g.name);
    out.push(
      <GroupRow
        key={`g:${g.name}`}
        name={g.name}
        open={open}
        toggle={() => {
          const n = new Set(closed);
          if (open) n.add(g.name);
          else n.delete(g.name);
          setClosed(n);
        }}
      />,
    );
    if (open) for (const p of g.rows) out.push(<PropertyRow key={p.name} doc={doc} name={name} p={p} />);
  }
  return <>{out}</>;
}

function exprTooltip(p: PropertyInfo): string {
  return `${p.doc || p.name}${p.expression ? `\n\nExpression: =${p.expression}` : ""}`;
}

function PropertyRow({ doc, name, p }: { doc: string; name: string; p: PropertyInfo }) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const kind = propertyKind(p);
  const ro =
    isReadOnly(p) ||
    kind === "none" ||
    kind === "link" ||
    kind === "linkSub" ||
    kind === "linkList" ||
    kind === "linkSubList" ||
    kind === "map";
  const subs = subRows(p);
  const hasExpr = !!p.expression && (!p.expressionPath || p.expressionPath === p.name);
  const label = splitCamelCase(p.name);

  const commitText = async (text: string) => {
    setEditing(false);
    if (text.trim().startsWith("=")) {
      await editExpression(doc, name, p.name, text.trim().slice(1).trim() || null).catch((e) => log.error(errorText(e)));
      return;
    }
    const r = parseInput(p, text);
    if (!r.ok) {
      log.error(`${label}: ${r.error}`);
      return;
    }
    await editProperty(doc, name, p.name, r.value, r.python).catch((e) => log.error(errorText(e)));
  };

  let valueCell: ReactNode;
  if (kind === "bool" && !ro) {
    valueCell = (
      <CheckBox
        testId={`prop-edit-${p.name}`}
        checked={!!p.value}
        onChange={(b) => void editProperty(doc, name, p.name, b, b ? "True" : "False").catch((e) => log.error(errorText(e)))}
        label={p.value ? "true" : "false"}
      />
    );
  } else if (editing && !ro) {
    valueCell = <ValueEditor p={p} onCommit={commitText} onCancel={() => setEditing(false)} doc={doc} name={name} />;
  } else {
    valueCell = (
      <>
        {kind === "color" && Array.isArray(p.value) && (
          <span className="color-swatch" style={{ background: tupleToCss(p.value as number[]) }} />
        )}
        <span data-testid={`prop-value-${p.name}`}>{displayValue(p, (n) => labelOf(doc, n))}</span>
        {hasExpr && <Icon name="bound-expression" size={14} className="icon expr-icon" />}
      </>
    );
  }
  const onValueClick = () => {
    if (!ro && kind !== "bool" && subs.length === 0) setEditing(true);
    if (!ro && subs.length > 0) setExpanded(true);
  };

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="prop-row" data-testid={`prop-row-${p.name}`} title={exprTooltip(p)}>
            <div className="prop-name" onClick={() => subs.length && setExpanded(!expanded)}>
              <span className="toggle">{subs.length ? (expanded ? "▼" : "▶") : ""}</span>
              {label}
            </div>
            <div
              className={`prop-value ${ro ? "readonly" : ""} ${hasExpr ? "expression" : ""} ${editing ? "editing" : ""}`}
              data-testid={`prop-cell-${p.name}`}
              onClick={onValueClick}
            >
              {valueCell}
            </div>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="menu-content">
            <ContextMenu.Item
              className="menu-item"
              disabled={isReadOnly(p)}
              onSelect={() =>
                setTimeout(async () => {
                  const e = await prompt("Formula editor", `Expression for ${label}:`, p.expression ?? "");
                  if (e !== null) await editExpression(doc, name, p.name, e.trim() || null).catch((x) => log.error(errorText(x)));
                }, 0)
              }
            >
              <span className="icon-slot">
                <Icon name="bound-expression" />
              </span>
              <span className="text">Expression…</span>
            </ContextMenu.Item>
            <ContextMenu.Item
              className="menu-item"
              disabled={!p.expression}
              onSelect={() => setTimeout(() => void editExpression(doc, name, p.name, null).catch((x) => log.error(errorText(x))), 0)}
            >
              <span className="icon-slot">
                <Icon name="bound-expression-unset" />
              </span>
              <span className="text">Clear expression</span>
            </ContextMenu.Item>
            <ContextMenu.Separator className="menu-separator" />
            <ContextMenu.CheckboxItem
              className="menu-item"
              checked={useApp.getState().showAllProperties}
              onCheckedChange={(b) => useApp.getState().setShowAllProperties(b)}
            >
              <span className="icon-slot">{useApp.getState().showAllProperties ? "✔" : ""}</span>
              <span className="text">Show hidden</span>
            </ContextMenu.CheckboxItem>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {expanded && subs.map((s) => <SubRowView key={s.path} doc={doc} name={name} p={p} s={s} depth={1} readOnly={ro} />)}
    </>
  );
}

function SubRowView({
  doc,
  name,
  p,
  s,
  depth,
  readOnly,
}: {
  doc: string;
  name: string;
  p: PropertyInfo;
  s: SubRow;
  depth: number;
  readOnly: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const exprPath = `${p.name}.${s.path}`;
  const hasExpr = p.expression !== undefined && p.expressionPath === exprPath;
  const commit = async (v: number) => {
    setEditing(false);
    const r = applySubEdit(p, s.path, v);
    if (!r) return;
    await editProperty(doc, name, p.name, r.value, r.python).catch((e) => log.error(errorText(e)));
  };
  const editable = !readOnly && !s.children;
  return (
    <>
      <div className="prop-row" data-testid={`prop-row-${p.name}.${s.path}`}>
        <div className="prop-name" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => s.children && setExpanded(!expanded)}>
          <span className="toggle">{s.children ? (expanded ? "▼" : "▶") : ""}</span>
          {s.label}
        </div>
        <div
          className={`prop-value ${readOnly ? "readonly" : ""} ${hasExpr ? "expression" : ""} ${editing ? "editing" : ""}`}
          data-testid={`prop-cell-${p.name}.${s.path}`}
          onClick={() => editable && setEditing(true)}
        >
          {editing && editable ? (
            s.kind === "quantity" ? (
              <QuantitySpinBox
                autoFocus
                value={s.value as number}
                unit={s.unit ?? ""}
                onCommit={(v) => void commit(v)}
                onCancel={() => setEditing(false)}
                onDone={() => setEditing(false)}
              />
            ) : (
              <FloatSpinBox
                autoFocus
                value={s.value as number}
                decimals={2}
                onCommit={(v) => void commit(v)}
                onCancel={() => setEditing(false)}
                onDone={() => setEditing(false)}
              />
            )
          ) : (
            <span>{s.display}</span>
          )}
        </div>
      </div>
      {expanded &&
        s.children?.map((c) => <SubRowView key={c.path} doc={doc} name={name} p={p} s={c} depth={depth + 1} readOnly={readOnly} />)}
    </>
  );
}

/** The in-place editor of a value cell. Typing `=` first turns any editor into an expression. */
function ValueEditor({
  p,
  onCommit,
  onCancel,
}: {
  p: PropertyInfo;
  onCommit: (text: string) => void;
  onCancel: () => void;
  doc: string;
  name: string;
}) {
  const kind = propertyKind(p);
  const [exprMode, setExprMode] = useState(false);
  const [text, setText] = useState(p.expression ? `=${p.expression}` : "");
  if (exprMode || p.expression) {
    return (
      <input
        type="text"
        autoFocus
        data-testid={`prop-edit-${p.name}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onCommit(text);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onCommit(text)}
      />
    );
  }
  const startExpr = (e: React.KeyboardEvent) => {
    if (e.key === "=") {
      e.preventDefault();
      setText("=");
      setExprMode(true);
    }
  };
  switch (kind) {
    case "quantity": {
      const q = quantityOf(p.value, p.unit);
      return (
        <span onKeyDownCapture={startExpr} style={{ display: "flex", flex: 1 }}>
          <QuantitySpinBox
            autoFocus
            testId={`prop-edit-${p.name}`}
            value={q.value}
            unit={q.unit || p.unit || ""}
            onCommit={(_v, t) => onCommit(t)}
            onExpression={onCommit}
            onDone={onCancel}
            onCancel={onCancel}
          />
        </span>
      );
    }
    case "float":
    case "int":
      return (
        <span onKeyDownCapture={startExpr} style={{ display: "flex", flex: 1 }}>
          <FloatSpinBox
            autoFocus
            testId={`prop-edit-${p.name}`}
            value={typeof p.value === "number" ? p.value : 0}
            integer={kind === "int"}
            onCommit={(v) => onCommit(String(v))}
            onExpression={onCommit}
            onDone={onCancel}
            onCancel={onCancel}
          />
        </span>
      );
    case "enum":
      return (
        <ComboBox
          autoFocus
          testId={`prop-edit-${p.name}`}
          value={String(p.value)}
          options={(p.enum ?? []).filter((v) => !v.startsWith("?"))}
          onChange={(v) => onCommit(v)}
        />
      );
    case "color":
      return (
        <input
          type="color"
          autoFocus
          defaultValue={Array.isArray(p.value) ? tupleToCss(p.value as number[]) : "#cccccc"}
          onChange={(e) => onCommit(e.target.value)}
          onBlur={onCancel}
        />
      );
    default:
      return (
        <input
          type="text"
          autoFocus
          data-testid={`prop-edit-${p.name}`}
          defaultValue={typeof p.value === "string" ? p.value : displayValue(p)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onCommit((e.target as HTMLInputElement).value);
            if (e.key === "Escape") onCancel();
          }}
          onBlur={(e) => onCommit(e.target.value)}
        />
      );
  }
}

// ------------------------------------------------------------------------------ View tab

function ViewRows({ doc, name, type, visibility }: { doc: string; name: string; type: string; visibility: boolean }) {
  const overrides = useViewProps((s) => s.overrides);
  const vp = viewPropsOf(doc, name, type, overrides);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const groups = [...new Set(VIEW_PROPERTY_DEFS.map((d) => d.group))].sort();
  const set = (patch: Partial<ViewProps>, python: string) => {
    useViewProps.getState().set(doc, name, patch);
    echo(`FreeCADGui.getDocument(${pyStr(doc)}).getObject(${pyStr(name)}).${Object.keys(patch)[0]} = ${python}`);
  };
  const out: ReactNode[] = [];
  for (const g of groups) {
    const open = !closed.has(g);
    out.push(
      <GroupRow
        key={g}
        name={g}
        open={open}
        toggle={() => {
          const n = new Set(closed);
          if (open) n.add(g);
          else n.delete(g);
          setClosed(n);
        }}
      />,
    );
    if (!open) continue;
    for (const d of VIEW_PROPERTY_DEFS.filter((x) => x.group === g)) {
      const value = d.name === "Visibility" ? visibility : vp[d.name as keyof ViewProps];
      let cell: ReactNode;
      if (d.kind === "bool") {
        cell = (
          <CheckBox
            testId={`view-edit-${d.name}`}
            checked={!!value}
            label={value ? "true" : "false"}
            onChange={(b) => (d.name === "Visibility" ? void setVisibility(doc, [name], b) : set({ [d.name]: b }, b ? "True" : "False"))}
          />
        );
      } else if (editing === d.name) {
        if (d.kind === "enum")
          cell = (
            <ComboBox
              autoFocus
              value={String(value)}
              options={d.enum!}
              onChange={(v) => {
                set({ [d.name]: v } as Partial<ViewProps>, pyStr(v));
                setEditing(null);
              }}
            />
          );
        else if (d.kind === "color")
          cell = (
            <input
              type="color"
              autoFocus
              defaultValue={String(value)}
              onChange={(e) =>
                set(
                  { [d.name]: e.target.value } as Partial<ViewProps>,
                  `(${cssToTuple(e.target.value)
                    .map((x) => fixed(x))
                    .join(",")})`,
                )
              }
              onBlur={() => setEditing(null)}
            />
          );
        else if (d.kind === "angle")
          cell = (
            <QuantitySpinBox
              autoFocus
              value={Number(value)}
              unit="deg"
              onCommit={(v) => (set({ [d.name]: v } as Partial<ViewProps>, pyStr(formatQuantity(v, "deg"))), setEditing(null))}
              onCancel={() => setEditing(null)}
            />
          );
        else
          cell = (
            <FloatSpinBox
              autoFocus
              value={Number(value)}
              integer={d.kind === "int"}
              min={d.min}
              max={d.max}
              onCommit={(v) => (set({ [d.name]: v } as Partial<ViewProps>, String(v)), setEditing(null))}
              onCancel={() => setEditing(null)}
            />
          );
      } else {
        const text =
          d.kind === "color"
            ? formatColor(String(value))
            : d.kind === "angle"
              ? formatQuantity(Number(value), "deg")
              : d.kind === "float"
                ? fixed(Number(value))
                : String(value);
        cell = (
          <>
            {d.kind === "color" && <span className="color-swatch" style={{ background: String(value) }} />}
            <span data-testid={`view-value-${d.name}`}>{text}</span>
          </>
        );
      }
      out.push(
        <div className="prop-row" key={d.name} title={d.doc} data-testid={`view-row-${d.name}`}>
          <div className="prop-name">
            <span className="toggle" />
            {splitCamelCase(d.name)}
          </div>
          <div className={`prop-value ${editing === d.name ? "editing" : ""}`} onClick={() => d.kind !== "bool" && setEditing(d.name)}>
            {cell}
          </div>
        </div>,
      );
    }
  }
  return <>{out}</>;
}
