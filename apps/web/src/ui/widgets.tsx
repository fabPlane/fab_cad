/**
 * Qt-like input widgets: `Gui::QuantitySpinBox` (a unit-aware line edit with spin arrows),
 * float/int spin boxes, check boxes, combo boxes and group boxes, styled after FreeCAD Light.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fixed, formatQuantity } from "../lib/format";
import { parseFloatInput, parseIntInput, parseQuantityInput } from "../properties/model";
import { iconUrl } from "./icons";

export function Icon({
  name,
  size = 16,
  className,
  title,
}: {
  name: string | undefined;
  size?: number;
  className?: string;
  title?: string;
}) {
  return <img className={className ?? "icon"} src={iconUrl(name)} width={size} height={size} alt="" draggable={false} title={title} />;
}

interface SpinProps {
  value: number;
  onCommit: (value: number, text: string) => void;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Keep editing after Enter (task panels) instead of closing (property editor). */
  onDone?: () => void;
  onCancel?: () => void;
  testId?: string;
  className?: string;
}

function clamp(v: number, min?: number, max?: number): number {
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}

function SpinShell(props: {
  text: string;
  setText: (t: string) => void;
  commit: (t: string) => boolean;
  stepBy: (dir: 1 | -1) => void;
  invalid: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
  testId?: string;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.autoFocus) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [props.autoFocus]);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      if (props.commit(props.text)) props.onDone?.();
    } else if (e.key === "Escape") props.onCancel?.();
    else if (e.key === "ArrowUp") (e.preventDefault(), props.stepBy(1));
    else if (e.key === "ArrowDown") (e.preventDefault(), props.stepBy(-1));
  };
  return (
    <span className={`spin ${props.invalid ? "invalid" : ""} ${props.className ?? ""}`} title={props.title}>
      <input
        ref={ref}
        data-testid={props.testId}
        value={props.text}
        disabled={props.disabled}
        onChange={(e) => props.setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => {
          if (props.commit(props.text)) props.onDone?.();
        }}
        spellCheck={false}
      />
      <span className="spin-buttons">
        <button tabIndex={-1} disabled={props.disabled} onMouseDown={(e) => (e.preventDefault(), props.stepBy(1))}>
          ▴
        </button>
        <button tabIndex={-1} disabled={props.disabled} onMouseDown={(e) => (e.preventDefault(), props.stepBy(-1))}>
          ▾
        </button>
      </span>
    </span>
  );
}

/** `Gui::QuantitySpinBox`: accepts `10`, `10 mm`, `1 in`, `2 ft 3 in`; shows `10.00 mm`. */
export function QuantitySpinBox(props: SpinProps & { unit: string }) {
  const shown = formatQuantity(props.value, props.unit);
  const [text, setText] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  const last = useRef(shown);
  useEffect(() => {
    if (shown !== last.current) {
      last.current = shown;
      setText(shown);
      setInvalid(false);
    }
  }, [shown]);
  const commit = (t: string): boolean => {
    if (t === shown) return true;
    const r = parseQuantityInput(t, props.unit);
    if (!r.ok) {
      setInvalid(true);
      return false;
    }
    const v = clamp((r.value as { value: number }).value, props.min, props.max);
    setInvalid(false);
    last.current = formatQuantity(v, props.unit);
    setText(last.current);
    props.onCommit(v, t);
    return true;
  };
  const stepBy = (dir: 1 | -1) => {
    const v = clamp(props.value + dir * (props.step ?? 1), props.min, props.max);
    props.onCommit(v, formatQuantity(v, props.unit));
  };
  return (
    <SpinShell
      text={text}
      setText={(t) => {
        setText(t);
        setInvalid(t.trim() !== "" && !parseQuantityInput(t, props.unit).ok);
      }}
      commit={commit}
      stepBy={stepBy}
      invalid={invalid}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      onDone={props.onDone}
      onCancel={props.onCancel}
      testId={props.testId}
      className={props.className}
      title={invalid ? "Invalid quantity" : undefined}
    />
  );
}

export function FloatSpinBox(props: SpinProps & { decimals?: number; integer?: boolean }) {
  const shown = props.integer ? String(Math.round(props.value)) : fixed(props.value, props.decimals);
  const [text, setText] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  const last = useRef(shown);
  useEffect(() => {
    if (shown !== last.current) {
      last.current = shown;
      setText(shown);
      setInvalid(false);
    }
  }, [shown]);
  const parse = (t: string) => (props.integer ? parseIntInput(t) : parseFloatInput(t));
  const commit = (t: string): boolean => {
    if (t === shown) return true;
    const r = parse(t);
    if (!r.ok) {
      setInvalid(true);
      return false;
    }
    const v = clamp(r.value as number, props.min, props.max);
    last.current = props.integer ? String(v) : fixed(v, props.decimals);
    setText(last.current);
    props.onCommit(v, t);
    return true;
  };
  const stepBy = (dir: 1 | -1) => {
    const v = clamp(props.value + dir * (props.step ?? 1), props.min, props.max);
    props.onCommit(v, String(v));
  };
  return (
    <SpinShell
      text={text}
      setText={(t) => {
        setText(t);
        setInvalid(t.trim() !== "" && !parse(t).ok);
      }}
      commit={commit}
      stepBy={stepBy}
      invalid={invalid}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      onDone={props.onDone}
      onCancel={props.onCancel}
      testId={props.testId}
      className={props.className}
    />
  );
}

export function CheckBox(props: {
  checked: boolean;
  onChange: (b: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label className={`checkbox ${props.disabled ? "disabled" : ""}`}>
      <input
        type="checkbox"
        data-testid={props.testId}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label !== undefined && <span>{props.label}</span>}
    </label>
  );
}

export function ComboBox(props: {
  value: string;
  options: { value: string; label?: string }[] | string[];
  onChange: (v: string) => void;
  disabled?: boolean;
  testId?: string;
  autoFocus?: boolean;
}) {
  const opts = (props.options as (string | { value: string; label?: string })[]).map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  return (
    <select
      className="combo"
      data-testid={props.testId}
      value={props.value}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label ?? o.value}
        </option>
      ))}
    </select>
  );
}

export function GroupBox({
  title,
  icon,
  children,
  collapsible = true,
}: {
  title: string;
  icon?: string;
  children: ReactNode;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="taskbox">
      <div className="taskbox-header" onClick={() => collapsible && setOpen(!open)}>
        {icon && <Icon name={icon} size={24} />}
        <span className="taskbox-title">{title}</span>
        {collapsible && <span className="taskbox-toggle">{open ? "▴" : "▾"}</span>}
      </div>
      {open && <div className="taskbox-body">{children}</div>}
    </div>
  );
}

export function FormRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="form-row">
      <label className="form-label">{label}</label>
      <div className="form-field">{children}</div>
    </div>
  );
}

export function Button(props: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  icon?: string;
  testId?: string;
  primary?: boolean;
  title?: string;
}) {
  return (
    <button
      className={`btn ${props.primary ? "primary" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
      data-testid={props.testId}
      title={props.title}
    >
      {props.icon && <Icon name={props.icon} />}
      {props.children}
    </button>
  );
}
