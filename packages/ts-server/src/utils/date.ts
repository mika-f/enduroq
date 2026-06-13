export const toISO = (v: unknown): string => {
  return (v instanceof Date ? v : new Date(v as string)).toISOString();
};
