import { scryptPasswordKdf } from "@syncpeer/core/kdf";

interface PasswordKdfRequest {
  password: Uint8Array;
  salt: Uint8Array;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PasswordKdfRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = event => {
  const { password, salt } = event.data;
  void scryptPasswordKdf(password, salt).then(key => {
    password.fill(0);
    scope.postMessage({ key });
  }, error => {
    password.fill(0);
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  });
};
