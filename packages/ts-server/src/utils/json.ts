export const safeParseJSON = (v: unknown): unknown => {
  if (v == null) {
    return null;
  }

  if (typeof v === "object") {
    return v;
  }

  try {
    return JSON.parse(v as string);
  } catch {
    return v;
  }
};
