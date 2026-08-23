import http from "node:http";
import { randomBytes } from "node:crypto";
import type { LanFixture, LanPhase } from "./protocol.ts";

export interface RegisteredProfile {
  profile: "trusted" | "untrusted";
  deviceId: string;
  registeredAtMs: number;
}

export interface PhaseReport {
  phase: LanPhase;
  status: "running" | "passed" | "failed" | "skipped";
  details?: unknown;
  updatedAtMs: number;
}

interface CoordinatorState {
  profiles: Map<RegisteredProfile["profile"], RegisteredProfile>;
  phases: Map<LanPhase, PhaseReport>;
  fixture: LanFixture | null;
  finalStatus: "passed" | "failed" | null;
}

const json = (value: unknown): string => JSON.stringify(value);

const readBody = async (request: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const writeJson = (response: http.ServerResponse, status: number, value: unknown): void => {
  const body = json(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
};

const waitFor = async <T>(read: () => T | null, timeoutMs: number, label: string): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

export class LanCoordinator {
  readonly token: string;
  readonly state: CoordinatorState = {
    profiles: new Map(),
    phases: new Map(),
    fixture: null,
    finalStatus: null,
  };
  private server: http.Server | null = null;
  private address = "";
  private actionHandler: ((action: string, details: unknown) => Promise<unknown>) | null = null;

  constructor(token?: string) {
    this.token = token ?? randomBytes(24).toString("hex");
  }

  async start(host = "0.0.0.0", port = 0): Promise<string> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, host, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Coordinator did not expose a TCP address.");
    this.address = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`;
    return this.address;
  }

  setAdvertisedBase(baseUrl: string): void {
    this.address = baseUrl.replace(/\/$/g, "");
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  get baseUrl(): string {
    if (!this.address) throw new Error("Coordinator has not started.");
    return this.address;
  }

  get port(): number {
    const parsed = new URL(this.baseUrl);
    return Number(parsed.port);
  }

  async waitForProfile(profile: RegisteredProfile["profile"], timeoutMs: number): Promise<RegisteredProfile> {
    return waitFor(() => this.state.profiles.get(profile) ?? null, timeoutMs, `${profile} identity registration`);
  }

  async waitForFinalStatus(timeoutMs: number): Promise<"passed" | "failed"> {
    return waitFor(() => this.state.finalStatus, timeoutMs, "client final result");
  }

  setFixture(fixture: LanFixture): void {
    this.state.fixture = fixture;
  }

  setActionHandler(handler: (action: string, details: unknown) => Promise<unknown>): void {
    this.actionHandler = handler;
  }

  private authorized(request: http.IncomingMessage): boolean {
    return request.headers["x-syncpeer-lan-token"] === this.token;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!this.authorized(request)) {
      writeJson(response, 401, { error: "Invalid coordinator token." });
      return;
    }
    const method = request.method ?? "GET";
    const pathname = new URL(request.url ?? "/", "http://coordinator").pathname;
    try {
      if (method === "GET" && pathname === "/v1/status") {
        writeJson(response, 200, {
          profiles: [...this.state.profiles.values()],
          phases: [...this.state.phases.values()],
          finalStatus: this.state.finalStatus,
        });
        return;
      }
      if (method === "GET" && pathname === "/v1/fixture") {
        if (!this.state.fixture) {
          writeJson(response, 409, { error: "Fixture is not ready." });
          return;
        }
        writeJson(response, 200, this.state.fixture);
        return;
      }
      if (method === "POST" && pathname === "/v1/register") {
        const body = await readBody(request) as Partial<RegisteredProfile>;
        if ((body.profile !== "trusted" && body.profile !== "untrusted") || !body.deviceId) {
          writeJson(response, 400, { error: "A profile and deviceId are required." });
          return;
        }
        const profile: RegisteredProfile = {
          profile: body.profile,
          deviceId: body.deviceId,
          registeredAtMs: Date.now(),
        };
        this.state.profiles.set(profile.profile, profile);
        writeJson(response, 200, profile);
        return;
      }
      if (method === "POST" && pathname === "/v1/phase") {
        const body = await readBody(request) as Partial<PhaseReport>;
        if (!body.phase || !body.status) {
          writeJson(response, 400, { error: "A phase and status are required." });
          return;
        }
        const report: PhaseReport = {
          phase: body.phase,
          status: body.status,
          details: body.details,
          updatedAtMs: Date.now(),
        };
        this.state.phases.set(report.phase, report);
        writeJson(response, 200, report);
        return;
      }
      if (method === "POST" && pathname === "/v1/finalize") {
        const body = await readBody(request) as { status?: "passed" | "failed" };
        if (body.status !== "passed" && body.status !== "failed") {
          writeJson(response, 400, { error: "A final status is required." });
          return;
        }
        this.state.finalStatus = body.status;
        writeJson(response, 200, { status: body.status });
        return;
      }
      if (method === "POST" && pathname === "/v1/action") {
        const body = await readBody(request) as { action?: string; details?: unknown };
        if (!body.action || !this.actionHandler) {
          writeJson(response, 409, { error: "Coordinator action handling is unavailable." });
          return;
        }
        writeJson(response, 200, await this.actionHandler(body.action, body.details));
        return;
      }
      writeJson(response, 404, { error: "Unknown coordinator endpoint." });
    } catch (error) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const coordinatorRequest = async <T>(args: {
  baseUrl: string;
  token: string;
  method: "GET" | "POST";
  pathname: string;
  body?: unknown;
}): Promise<T> => {
  const response = await fetch(`${args.baseUrl}${args.pathname}`, {
    method: args.method,
    headers: {
      "x-syncpeer-lan-token": args.token,
      ...(args.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Coordinator request failed with HTTP ${response.status}.`);
  }
  return payload;
};
