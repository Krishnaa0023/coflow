#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Context } from "./core/context.js";
import { FeatureStatus } from "./core/schema.js";
import { formatStamp } from "./core/time.js";
import { redact } from "./core/redact.js";

/**
 * Lean MCP surface. Tool definitions are injected into the model's context on
 * EVERY turn, so we expose only the three tools Claude actually calls itself —
 * say / inbox / checkpoint. Everything else (pull, record, overlap checks,
 * board, search) runs automatically in the hooks/CLI and never needs to sit in
 * the per-turn tool list. Names, descriptions, and results are kept terse for
 * the same reason. Detailed usage lives once in CLAUDE.md, not in every schema.
 */

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function buildServer(ctx: Context = new Context()): McpServer {
  const server = new McpServer({ name: "coflow", version: "0.1.1" });

  server.registerTool(
    "say",
    {
      title: "Message other sessions",
      description: "Broadcast to other Claude sessions in this project. Use the compact protocol from CLAUDE.md.",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => {
      await ctx.say(message);
      return text("ok");
    },
  );

  server.registerTool(
    "inbox",
    {
      title: "New messages from other sessions",
      description: "Recent messages from the other sessions in this project.",
      inputSchema: { limit: z.number().int().positive().max(50).optional() },
    },
    async ({ limit }) => {
      const msgs = await ctx.inbox(limit ?? 20);
      const now = new Date().toISOString();
      const tz = ctx.store.p.timezone;
      return text(
        msgs.length
          ? msgs
              .map(
                (m) =>
                  `${formatStamp(m.at, now, tz)} ${m.feature}: ${redact(m.text).text}`,
              )
              .join("\n")
          : "(none)",
      );
    },
  );

  server.registerTool(
    "checkpoint",
    {
      title: "Save & push feature state",
      description: "Write your feature file and push it for the team. Call at task boundaries, not per edit.",
      inputSchema: {
        summary: z.string().optional(),
        status: FeatureStatus.optional(),
        goal: z.string().optional(),
      },
    },
    async ({ summary, status, goal }) => {
      const r = await ctx.checkpoint({ summary, status, goal });
      const extra = r.redactionHits.length ? `, ${r.redactionHits.length} redacted` : "";
      return text(`${r.feature}: ${r.message} (${r.deltasFolded} folded${extra})`);
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[coflow] MCP server ready on stdio\n");
}

const isDirect = process.argv[1] && /(?:^|\/)(mcp)\.(?:js|ts)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    process.stderr.write(`[coflow] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
