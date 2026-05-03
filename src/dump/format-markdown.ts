/**
 * Pure serializer: DumpData → markdown string.
 * No I/O. All formatting logic lives here.
 */

import type { DumpData, DumpPart, DumpVerbosity } from "../types.ts"

/** Render a markdown table row. */
function row(...cells: string[]): string {
  return `| ${cells.join(" | ")} |`
}

function tableHeader(...headers: string[]): string {
  const sep = headers.map(() => "---")
  return [row(...headers), row(...sep)].join("\n")
}

function pad(n: number, total: number): string {
  return String(n).padStart(total, " ")
}

function fmtPct(pct: number): string {
  return `${pct.toFixed(1)}%`
}

function fmtPartId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id
}

function renderPart(p: DumpPart, verbosity: DumpVerbosity): string {
  const flagStr = p.flags.length > 0 ? ` ⚑ ${p.flags.join(", ")}` : ""
  const compactedStr = p.alreadyCompacted ? " [compacted]" : ""
  const typeStr = p.tool ? `${p.type}(${p.tool})` : p.type
  const preview = verbosity === "minimal" ? "" : ` — ${p.preview}`

  return `  - \`${fmtPartId(p.partId)}\` ${typeStr} ${p.tokens}t${compactedStr}${flagStr}${preview}`
}

/**
 * Serialize DumpData to a human-readable markdown report.
 *
 * Verbosity levels:
 *   minimal → Overview + Top 10 + Cleanup candidates only
 *   normal  → + Conversation list with previews (80 chars)
 *   verbose → + Full per-part previews up to 200 chars
 */
export function serializeMarkdown(data: DumpData, verbosity: DumpVerbosity): string {
  const lines: string[] = []
  const ts = new Date(data.generatedAt).toISOString()

  // -----------------------------------------------------------------------
  // Header
  lines.push(`# ctxlite context dump`)
  lines.push(``)
  lines.push(`Generated: ${ts}  `)
  lines.push(`Session: \`${data.sessionId}\``)
  lines.push(``)

  // -----------------------------------------------------------------------
  // Overview
  lines.push(`## Overview`)
  lines.push(``)
  lines.push(tableHeader("Metric", "Value"))
  lines.push(row("Context window (tokens)", String(data.contextWindowTokens)))
  lines.push(row("Used tokens (estimate)", String(data.totalTokens)))
  lines.push(row("Used %", fmtPct(data.usedPct)))
  lines.push(row("Messages", String(data.messages.length)))
  lines.push(row("Parts analyzed", String(data.messages.reduce((s, m) => s + m.parts.length, 0))))
  lines.push(row("Already compacted", String(data.nAlreadyCompacted)))
  lines.push(row("Cleanup candidates", String(data.cleanupCandidates.length)))
  lines.push(``)

  // -----------------------------------------------------------------------
  // Startup overhead note
  lines.push(`## Startup overhead`)
  lines.push(``)
  lines.push(
    `> Startup overhead inspection (system prompt + MCP tool descriptions) is unavailable ` +
    `in this SDK version. The ctxlite plugin does not have access to the pre-conversation ` +
    `system prompt payload at tool-execution time.`,
  )
  lines.push(``)

  // -----------------------------------------------------------------------
  // Conversation (skipped for minimal)
  if (verbosity !== "minimal") {
    lines.push(`## Conversation`)
    lines.push(``)
    for (const msg of data.messages) {
      const totalMsgTokens = msg.parts.reduce((s, p) => s + p.tokens, 0)
      lines.push(`### Message ${pad(msg.messageIdx, 3)} — ${msg.role} (\`${fmtPartId(msg.messageId)}\`) ${totalMsgTokens}t`)
      lines.push(``)
      for (const p of msg.parts) {
        lines.push(renderPart(p, verbosity))
      }
      lines.push(``)
    }
  }

  // -----------------------------------------------------------------------
  // Top 10 offenders
  lines.push(`## Top 10 token offenders`)
  lines.push(``)
  lines.push(tableHeader("#", "Part ID", "Type", "Tokens"))
  data.topOffenders.forEach((o, i) => {
    const typeStr = o.tool ? `${o.type}(${o.tool})` : o.type
    lines.push(row(String(i + 1), `\`${fmtPartId(o.partId)}\``, typeStr, String(o.tokens)))
  })
  lines.push(``)

  // -----------------------------------------------------------------------
  // Cleanup candidates
  lines.push(`## Cleanup candidates (${data.cleanupCandidates.length})`)
  lines.push(``)
  if (data.cleanupCandidates.length === 0) {
    lines.push(`No cleanup candidates found.`)
  } else {
    lines.push(tableHeader("Part ID", "Type", "Tokens", "Flags", "Preview"))
    for (const c of data.cleanupCandidates) {
      const typeStr = c.tool ? `${c.type}(${c.tool})` : c.type
      lines.push(
        row(
          `\`${fmtPartId(c.partId)}\``,
          typeStr,
          String(c.tokens),
          c.flags.join(", "),
          c.preview.replace(/\|/g, "\\|"),
        ),
      )
    }
  }
  lines.push(``)

  // -----------------------------------------------------------------------
  // How to apply
  lines.push(`## How to apply`)
  lines.push(``)
  lines.push(`Use \`ctxlite_compact\` with a selector to clean up candidates:`)
  lines.push(``)
  lines.push(`\`\`\`json`)
  lines.push(`{`)
  lines.push(`  "selector": {`)
  lines.push(`    "filter": {`)
  lines.push(`      "flaggedAs": ["superseded-tool-result", "large-error"]`)
  lines.push(`    }`)
  lines.push(`  },`)
  lines.push(`  "dryRun": true`)
  lines.push(`}`)
  lines.push(`\`\`\``)
  lines.push(``)
  lines.push(`Set \`dryRun: false\` after reviewing the preview.`)
  lines.push(``)

  return lines.join("\n")
}
