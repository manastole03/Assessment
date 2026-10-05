export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Display text for an untyped JSON value: scalars as-is, structures as JSON (never "[object Object]"). */
export function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

export function locatorText(locator: Record<string, unknown>): string {
  const { by, ...rest } = locator;
  const t = (key: string) => text(rest[key]);
  switch (by) {
    case "attribute":
      return `${t("tag")}[${t("attribute")}="${t("value")}"]`;
    case "role":
      return `${t("role")} named “${t("name")}”`;
    case "label":
      return `${t("role")} labelled “${t("label")}”`;
    case "table_cell":
      return `row “${t("row")}” × column “${t("column")}”${rest.role ? ` → ${t("role")}` : ""}`;
    case "css":
      return t("selector");
    default:
      return JSON.stringify(rest);
  }
}

export const LOCATOR_WHY: Record<string, string> = {
  attribute:
    "Contract attribute — a form-field name or link href. The vendor's server reads these, so they survive tenant relabelling and branding. (Desktop: UIA AutomationId.)",
  role: "Role + accessible name — what a screen reader would announce for this control.",
  label: "Visual label — the text a person reads next to the control, e.g. the adjacent table cell on legacy forms.",
  table_cell: "Row key × column header — finds a cell by meaning, so it still reads the right value when rows are re-ordered.",
  css: "Structural selector — last resort. Never used to read data and never allowed to drive an irreversible step.",
};
