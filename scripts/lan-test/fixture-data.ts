import { getDefaultDiscoveryServer } from "../../packages/core/src/ui/discoveryServer.ts";

export const LAN_FIXTURE_FOLDER_ID = "syncpeer-lan";
export const LAN_FIXTURE_ENCRYPTED_FOLDER_ID = "syncpeer-lan-encrypted";
export const LAN_FIXTURE_ENCRYPTED_PASSWORD = "correct horse battery staple";
export const LAN_FIXTURE_HELLO_CONTENT = "hello from the LAN fixture\n";
export const LAN_FIXTURE_BLOB_SIZE = 30 * 1024 * 1024;
export const SYNCTHING_GLOBAL_DISCOVERY_SERVER = getDefaultDiscoveryServer();
