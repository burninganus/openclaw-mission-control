/**
 * HTTP transport — talks to the Gateway's HTTP API endpoints.
 *
 * Used for hosted deployments where the platform communicates with
 * the Gateway over HTTP, and for self-hosted users who prefer HTTP over CLI subprocesses.
 *
 * Primary endpoint: POST /tools/invoke (always enabled on the Gateway)
 * Auth: Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>
 */

import { readdir as readDirLocal } from "fs/promises";
import { getGatewayToken, getGatewayUrl } from "../paths";
import { GatewayRpcClient } from "../gateway-rpc";
import {
  parseJsonFromCliOutput,
  runCli as runLocalCli,
  runCliCaptureBoth as runLocalCliCaptureBoth,
  runCliJson as runLocalCliJson,
  type RunCliResult,
} from "../openclaw-cli";
import type { OpenClawClient, TransportMode } from "../openclaw-client";

export class HttpTransport implements OpenClawClient {
  private token: string;
  private gatewayUrlCache: string | null = null;
  private rpcClient: GatewayRpcClient | null = null;

  constructor(gatewayUrl?: string, token?: string) {
    this.token = token ?? getGatewayToken();
    this.gatewayUrlCache = gatewayUrl || null;
  }

  private isExecToolUnavailable(error: unknown): boolean {
    const message = String(error || "").toLowerCase();
    return (
      message.includes("tool not available: exec") ||
      (message.includes("/tools/invoke exec returned 404") && message.includes("not available"))
    );
  }

  getTransport(): TransportMode {
    return "http";
  }

  private async getGwUrl(): Promise<string> {
    if (this.gatewayUrlCache) return this.gatewayUrlCache;
    this.gatewayUrlCache = await getGatewayUrl();
    return this.gatewayUrlCache;
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) return {};
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * Invoke a Gateway tool via POST /tools/invoke.
   * Returns the parsed JSON response body.
   */
  private async invoke<T>(
    tool: string,
    args: Record<string, unknown> = {},
    timeout = 15000,
    action?: "json",
  ): Promise<T> {
    const gwUrl = await this.getGwUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${gwUrl}/tools/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          tool,
          args,
          ...(action ? { action } : {}),
        }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; result?: T; error?: { message?: string } }
        | T
        | null;
      if (!res.ok) {
        const text =
          (body && typeof body === "object" && "error" in body && body.error?.message) ||
          JSON.stringify(body) ||
          "";
        throw new Error(
          `Gateway /tools/invoke ${tool} returned ${res.status}: ${text}`,
        );
      }
      if (body && typeof body === "object" && "ok" in body) {
        if (body.ok === false) {
          throw new Error(body.error?.message || `Tool ${tool} failed`);
        }
        return (body.result as T) ?? ({} as T);
      }
      return (body || {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Execute a shell command inside the Gateway via the exec tool.
   * Returns the raw stdout.
   */
  private resultToText(
    result:
      | { output?: string; stdout?: string; result?: string; content?: unknown; details?: unknown; text?: string }
      | string,
  ): string {
    if (typeof result === "string") return result;
    if (typeof result.output === "string") return result.output;
    if (typeof result.stdout === "string") return result.stdout;
    if (typeof result.result === "string") return result.result;
    if (typeof result.text === "string") return result.text;
    if (Array.isArray(result.content)) {
      const text = result.content
        .map((item) =>
          item && typeof item === "object" && "text" in item ? String(item.text || "") : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
    if (typeof result.details === "string") return result.details;
    return JSON.stringify(result.details || result);
  }

  private async execCommand(
    command: string,
    timeout = 15000,
  ): Promise<string> {
    const result = await this.invoke<
      { output?: string; stdout?: string; result?: string; content?: unknown; details?: unknown } | string
    >("exec", { command }, timeout, "json");
    return this.resultToText(result);
  }

  // ── OpenClawClient interface ──────────────────────

  async runJson<T>(args: string[], timeout = 15000): Promise<T> {
    const command = `openclaw ${args.join(" ")} --json`;
    try {
      const raw = await this.execCommand(command, timeout);
      return parseJsonFromCliOutput<T>(raw, command);
    } catch (error) {
      if (!this.isExecToolUnavailable(error)) throw error;
      return runLocalCliJson<T>(args, timeout);
    }
  }

  async run(
    args: string[],
    timeout = 15000,
    stdin?: string,
  ): Promise<string> {
    const command = `openclaw ${args.join(" ")}`;
    try {
      if (stdin) {
        const result = await this.invoke<
          { output?: string; stdout?: string; result?: string; content?: unknown; details?: unknown } | string
        >("exec", { command, stdin }, timeout, "json");
        return this.resultToText(result);
      }
      return this.execCommand(command, timeout);
    } catch (error) {
      if (!this.isExecToolUnavailable(error)) throw error;
      return runLocalCli(args, timeout, stdin);
    }
  }

  async runCapture(args: string[], timeout = 15000): Promise<RunCliResult> {
    const command = `openclaw ${args.join(" ")}`;
    try {
      const stdout = await this.execCommand(command, timeout);
      return { stdout, stderr: "", code: 0 };
    } catch (err) {
      if (this.isExecToolUnavailable(err)) {
        return runLocalCliCaptureBoth(args, timeout);
      }
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        code: 1,
      };
    }
  }

  async gatewayRpc<T>(
    method: string,
    params?: Record<string, unknown>,
    timeout = 15000,
  ): Promise<T> {
    if (!this.rpcClient) {
      this.rpcClient = new GatewayRpcClient(this.gatewayUrlCache || undefined, this.token);
    }
    return this.rpcClient.request<T>(method, params || {}, timeout);
  }

  async readFile(path: string): Promise<string> {
    const result = await this.invoke<
      { content?: string; output?: string; details?: unknown; text?: string } | string
    >("read", { path });
    if (typeof result === "string") return result;
    if (typeof result.content === "string") return result.content;
    return this.resultToText(result);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.invoke("write", { path, content });
  }

  async readdir(path: string): Promise<string[]> {
    try {
      const raw = await this.execCommand(`ls -1 "${path}"`);
      return raw.split("\n").filter(Boolean);
    } catch (error) {
      if (!this.isExecToolUnavailable(error)) throw error;
      const entries = await readDirLocal(path);
      return entries.map(String);
    }
  }

  async gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
    const gwUrl = await this.getGwUrl();
    return fetch(`${gwUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        ...this.authHeaders(),
      },
    });
  }
}
