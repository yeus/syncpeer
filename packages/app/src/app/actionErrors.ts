import { reportUiError } from "../lib/tauriAdapters.js";
import { setError, type AppState } from "./state.ts";

export const reportActionError = (
  state: AppState,
  event: string,
  error: unknown,
  details?: unknown,
) => {
  setError(state, event, error, details);
  reportUiError(event, error, details);
};
