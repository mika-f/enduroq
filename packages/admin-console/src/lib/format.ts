// Small presentation helpers shared across client components.

export const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

export const relativeTime = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const diffMs = d.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const sign = diffMs >= 0 ? "in " : "";
  const suffix = diffMs >= 0 ? "" : " ago";

  const units: [number, string][] = [
    [1000 * 60 * 60 * 24, "d"],
    [1000 * 60 * 60, "h"],
    [1000 * 60, "m"],
    [1000, "s"],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      return `${sign}${Math.round(abs / ms)}${label}${suffix}`;
    }
  }
  return "just now";
};
