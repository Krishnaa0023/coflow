/**
 * Hook I/O. Claude Code feeds hooks a JSON event on stdin and reads a JSON
 * decision on stdout. These helpers keep the handlers tiny and fast.
 */

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  [k: string]: unknown;
}

export async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

export function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

/** Pull the set of file paths an Edit/Write/MultiEdit/NotebookEdit will touch. */
export function filesFromToolInput(input: Record<string, unknown> = {}): string[] {
  const out = new Set<string>();
  for (const key of ["file_path", "notebook_path", "path"]) {
    const v = input[key];
    if (typeof v === "string" && v) out.add(v);
  }
  // MultiEdit-style: { edits: [...] } still carries a single file_path, handled
  // above. Guard for any array of {file_path} just in case.
  const edits = input["edits"];
  if (Array.isArray(edits)) {
    for (const e of edits) {
      const fp = (e as Record<string, unknown>)?.["file_path"];
      if (typeof fp === "string" && fp) out.add(fp);
    }
  }
  return [...out];
}
