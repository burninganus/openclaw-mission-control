#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_FILE="${ROOT_DIR}/src/lib/transports/http-transport.ts"
AGENTS_FILE="${ROOT_DIR}/src/components/agents-view.tsx"

if [[ ! -f "${TARGET_FILE}" ]]; then
  echo "Target file not found: ${TARGET_FILE}" >&2
  exit 1
fi

if [[ ! -f "${AGENTS_FILE}" ]]; then
  echo "Target file not found: ${AGENTS_FILE}" >&2
  exit 1
fi

HTTP_PATCHED=0
AGENTS_PATCHED=0

if grep -q "runCliCaptureBoth as runLocalCliCaptureBoth" "${TARGET_FILE}"; then
  HTTP_PATCHED=1
fi

if ! grep -q 'requestRestart("Agent settings updated — restart to pick up changes.");' "${AGENTS_FILE}"; then
  AGENTS_PATCHED=1
fi

if [[ "${HTTP_PATCHED}" -eq 1 && "${AGENTS_PATCHED}" -eq 1 ]]; then
  echo "http transport and agent-save restart patches are already applied."
  exit 0
fi

python3 - "${TARGET_FILE}" "${HTTP_PATCHED}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
already_patched = sys.argv[2] == "1"
text = path.read_text(encoding="utf-8")

if already_patched or "runCliCaptureBoth as runLocalCliCaptureBoth" in text:
    print("http-transport exec compatibility patch is already applied.")
    raise SystemExit(0)

def replace_once(source: str, candidates: list[str], replacement: str, label: str) -> str:
    for candidate in candidates:
        if candidate in source:
            return source.replace(candidate, replacement, 1)
    raise SystemExit(f"Could not patch {label}; upstream file changed too much.")

text = replace_once(
    text,
    [
        'import { getGatewayUrl } from "../paths";\n'
        'import { GatewayRpcClient } from "../gateway-rpc";\n'
        'import { parseJsonFromCliOutput, type RunCliResult } from "../openclaw-cli";\n',
        'import { getGatewayToken, getGatewayUrl } from "../paths";\n'
        'import { GatewayRpcClient } from "../gateway-rpc";\n'
        'import { parseJsonFromCliOutput, type RunCliResult } from "../openclaw-cli";\n',
    ],
    'import { readdir as readDirLocal } from "fs/promises";\n'
    'import { getGatewayToken, getGatewayUrl } from "../paths";\n'
    'import { GatewayRpcClient } from "../gateway-rpc";\n'
    'import {\n'
    '  parseJsonFromCliOutput,\n'
    '  runCli as runLocalCli,\n'
    '  runCliCaptureBoth as runLocalCliCaptureBoth,\n'
    '  runCliJson as runLocalCliJson,\n'
    '  type RunCliResult,\n'
    '} from "../openclaw-cli";\n',
    "imports",
)

text = replace_once(
    text,
    [
        '  constructor(gatewayUrl?: string, token?: string) {\n'
        '    this.token = token || process.env.OPENCLAW_GATEWAY_TOKEN || "";\n'
        '    this.gatewayUrlCache = gatewayUrl || null;\n'
        '  }\n'
        '\n'
        '  getTransport(): TransportMode {\n',
        '  constructor(gatewayUrl?: string, token?: string) {\n'
        '    this.token = token ?? getGatewayToken();\n'
        '    this.gatewayUrlCache = gatewayUrl || null;\n'
        '  }\n'
        '\n'
        '  getTransport(): TransportMode {\n',
    ],
    '  constructor(gatewayUrl?: string, token?: string) {\n'
    '    this.token = token ?? getGatewayToken();\n'
    '    this.gatewayUrlCache = gatewayUrl || null;\n'
    '  }\n'
    '\n'
    '  private isExecToolUnavailable(error: unknown): boolean {\n'
    '    const message = String(error || "").toLowerCase();\n'
    '    return (\n'
    '      message.includes("tool not available: exec") ||\n'
    '      (message.includes("/tools/invoke exec returned 404") && message.includes("not available"))\n'
    '    );\n'
    '  }\n'
    '\n'
    '  getTransport(): TransportMode {\n',
    "constructor",
)

text = replace_once(
    text,
    [
        '  async runJson<T>(args: string[], timeout = 15000): Promise<T> {\n'
        '    const command = `openclaw ${args.join(" ")} --json`;\n'
        '    const raw = await this.execCommand(command, timeout);\n'
        '    return parseJsonFromCliOutput<T>(raw, command);\n'
        '  }\n',
    ],
    '  async runJson<T>(args: string[], timeout = 15000): Promise<T> {\n'
    '    const command = `openclaw ${args.join(" ")} --json`;\n'
    '    try {\n'
    '      const raw = await this.execCommand(command, timeout);\n'
    '      return parseJsonFromCliOutput<T>(raw, command);\n'
    '    } catch (error) {\n'
    '      if (!this.isExecToolUnavailable(error)) throw error;\n'
    '      return runLocalCliJson<T>(args, timeout);\n'
    '    }\n'
    '  }\n',
    "runJson",
)

text = replace_once(
    text,
    [
        '  async run(\n'
        '    args: string[],\n'
        '    timeout = 15000,\n'
        '    stdin?: string,\n'
        '  ): Promise<string> {\n'
        '    const command = `openclaw ${args.join(" ")}`;\n'
        '    if (stdin) {\n'
        '      const result = await this.invoke<\n'
        '        { output?: string; stdout?: string; result?: string; content?: unknown; details?: unknown } | string\n'
        '      >("exec", { command, stdin }, timeout, "json");\n'
        '      return this.resultToText(result);\n'
        '    }\n'
        '    return this.execCommand(command, timeout);\n'
        '  }\n',
    ],
    '  async run(\n'
    '    args: string[],\n'
    '    timeout = 15000,\n'
    '    stdin?: string,\n'
    '  ): Promise<string> {\n'
    '    const command = `openclaw ${args.join(" ")}`;\n'
    '    try {\n'
    '      if (stdin) {\n'
    '        const result = await this.invoke<\n'
    '          { output?: string; stdout?: string; result?: string; content?: unknown; details?: unknown } | string\n'
    '        >("exec", { command, stdin }, timeout, "json");\n'
    '        return this.resultToText(result);\n'
    '      }\n'
    '      return this.execCommand(command, timeout);\n'
    '    } catch (error) {\n'
    '      if (!this.isExecToolUnavailable(error)) throw error;\n'
    '      return runLocalCli(args, timeout, stdin);\n'
    '    }\n'
    '  }\n',
    "run",
)

text = replace_once(
    text,
    [
        '  async runCapture(args: string[], timeout = 15000): Promise<RunCliResult> {\n'
        '    const command = `openclaw ${args.join(" ")}`;\n'
        '    try {\n'
        '      const stdout = await this.execCommand(command, timeout);\n'
        '      return { stdout, stderr: "", code: 0 };\n'
        '    } catch (err) {\n'
        '      return {\n'
        '        stdout: "",\n'
        '        stderr: err instanceof Error ? err.message : String(err),\n'
        '        code: 1,\n'
        '      };\n'
        '    }\n'
        '  }\n',
    ],
    '  async runCapture(args: string[], timeout = 15000): Promise<RunCliResult> {\n'
    '    const command = `openclaw ${args.join(" ")}`;\n'
    '    try {\n'
    '      const stdout = await this.execCommand(command, timeout);\n'
    '      return { stdout, stderr: "", code: 0 };\n'
    '    } catch (err) {\n'
    '      if (this.isExecToolUnavailable(err)) {\n'
    '        return runLocalCliCaptureBoth(args, timeout);\n'
    '      }\n'
    '      return {\n'
    '        stdout: "",\n'
    '        stderr: err instanceof Error ? err.message : String(err),\n'
    '        code: 1,\n'
    '      };\n'
    '    }\n'
    '  }\n',
    "runCapture",
)

text = replace_once(
    text,
    [
        '  async readdir(path: string): Promise<string[]> {\n'
        '    const raw = await this.execCommand(`ls -1 "${path}"`);\n'
        '    return raw.split("\\n").filter(Boolean);\n'
        '  }\n',
    ],
    '  async readdir(path: string): Promise<string[]> {\n'
    '    try {\n'
    '      const raw = await this.execCommand(`ls -1 "${path}"`);\n'
    '      return raw.split("\\n").filter(Boolean);\n'
    '    } catch (error) {\n'
    '      if (!this.isExecToolUnavailable(error)) throw error;\n'
    '      const entries = await readDirLocal(path);\n'
    '      return entries.map(String);\n'
    '    }\n'
    '  }\n',
    "readdir",
)

path.write_text(text, encoding="utf-8")
print("Applied http-transport exec compatibility patch.")
PY

python3 - "${AGENTS_FILE}" "${AGENTS_PATCHED}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
already_patched = sys.argv[2] == "1"
text = path.read_text(encoding="utf-8")
needle = '      requestRestart("Agent settings updated — restart to pick up changes.");\n'

if already_patched or needle not in text:
    print("agent-save restart patch is already applied.")
    raise SystemExit(0)

text = text.replace(needle, "", 1)
path.write_text(text, encoding="utf-8")
print("Applied agent-save restart patch.")
PY
