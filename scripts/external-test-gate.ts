/** External peer tests may mutate a real peer; local state alone is never opt-in. */
export const externalPeerSkipReason = (environment: NodeJS.ProcessEnv): string | undefined => {
  if (environment.SYNCPEER_RUN_EXTERNAL_CHECKS !== "1") {
    return "Opt in with SYNCPEER_RUN_EXTERNAL_CHECKS=1 to test an external peer";
  }
  if (!environment.SYNCPEER_DEV_SERVER_DEVICE_ID?.trim()) {
    return "Set a device ID explicitly with SYNCPEER_DEV_SERVER_DEVICE_ID for external peer tests";
  }
  return undefined;
};

export const externalApiSkipReason = (environment: NodeJS.ProcessEnv,
  url: string | undefined): string | undefined => {
  if (environment.SYNCPEER_RUN_EXTERNAL_CHECKS !== "1") {
    return "Opt in with SYNCPEER_RUN_EXTERNAL_CHECKS=1 to test an external API";
  }
  if (!url) return "Set an external API URL with SYNCPEER_SYNCTHING_API_URL";
  return undefined;
};
