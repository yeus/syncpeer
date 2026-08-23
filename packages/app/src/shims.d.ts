declare module "lz4js";

declare module "*.proto?raw" {
  const content: string;
  export default content;
}

declare const __SYNCPEER_APP_VERSION__: string;
declare const __SYNCPEER_BUILD_COMMIT__: string;
declare const __SYNCPEER_BUILD_TIME_UTC__: string;

interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
declare const __SYNCPEER_LAN_E2E__: boolean;
