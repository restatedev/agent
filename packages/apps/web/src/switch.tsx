/** An on/off button with switch semantics, labelled by `label` for screen readers. */
export function Switch({
  label,
  checked,
  disabled,
  describedBy,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  describedBy?: string;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="web-search-toggle"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="web-search-toggle-track" aria-hidden="true">
        <span />
      </span>
      {checked ? "Enabled" : "Disabled"}
    </button>
  );
}

/** A visible label next to its switch, one row of a tool list. */
export function ToolSwitch(props: Parameters<typeof Switch>[0]) {
  return (
    <div className="agent-tool-toggle">
      <span>{props.label}</span>
      <Switch {...props} />
    </div>
  );
}
