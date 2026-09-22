export const settingsText = (value: unknown, label: string, maximum = 4096) => {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
};

export const settingsInteger = (value: unknown, label: string, minimum = 0) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`Invalid ${label}.`);
  return Number(value);
};
