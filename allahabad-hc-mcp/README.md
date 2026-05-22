# Allahabad High Court — MCP Server

A Model Context Protocol (MCP) server that provides structured, real-time access to the Allahabad High Court's data. Designed to power AI agents that help lawyers with case management, court scheduling, and legal research.

## Tools (10)

| Tool | Description | CAPTCHA? |
|------|-------------|----------|
| `get_case_status` | Search case by type/number/year — returns parties, coram, next hearing | Yes |
| `get_cause_list` | Fetch today's cause list PDFs and parsed listings | No |
| `get_bench_roster` | Current bench constitution — which judge hears what | No |
| `search_judgments` | Search judgments via eLegalix, or fetch RSS headline feed | No |
| `get_defective_list` | Official list of defective case filings | No |
| `get_court_calendar` | Holidays, vacations, working day status for any date | No (local data) |
| `get_advocate_cases` | All cases for an advocate by roll number | Yes |
| `get_case_history` | Listing history and IA details for a case | Yes |
| `get_court_view` | Live display board — cases being heard right now | No |
| `get_justice_clock` | Disposal & institution statistics | No |

## Resources

- `allahabad-hc://info` — Court metadata, URLs, case types, calendar
- `allahabad-hc://case-types` — Full list of 30 case type codes with IDs

## Setup

```bash
cd allahabad-hc-mcp
npm install
```

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "allahabad-hc": {
      "command": "node",
      "args": ["/path/to/allahabad-hc-mcp/server.js"]
    }
  }
}
```

### With Claude Code

```bash
claude mcp add allahabad-hc node /path/to/allahabad-hc-mcp/server.js
```

## CAPTCHA Handling

Some court endpoints (case status, advocate cases, case history) require solving a CAPTCHA. The flow is:

1. **First call** — tool returns `captcha_required` with a `captcha_url` and `session_token`
2. **User solves** the CAPTCHA (view the image URL)
3. **Second call** — pass `session_token` + `captcha_answer` to get the actual data

For tools that don't need CAPTCHA (cause list, bench roster, court view, etc.), data is returned immediately.

## Example Agent Prompts

- "Is my bail application BAIL 1234/2024 listed tomorrow?"
- "Show me today's cause list for Lucknow bench"
- "Which bench is hearing Writ-A cases today?"
- "Get all my pending cases — my roll number is UP/1234/2020"
- "Is the court working on May 25th?"
- "What cases are being heard right now in Allahabad?"
- "Show me the latest judgment headlines"

## Architecture

```
┌─────────────┐     stdio      ┌──────────────────┐     HTTP      ┌──────────────────────┐
│ Claude/Agent │ ◄────────────► │ allahabad-hc-mcp │ ◄──────────► │ allahabadhighcourt.in│
│  (LLM)      │   MCP protocol │   (Node.js)      │  fetch+parse │ courtview2.*         │
└─────────────┘                └──────────────────┘              │ elegalix.*           │
                                                                  └──────────────────────┘
```

The server makes HTTP requests to the court website, parses HTML responses using cheerio, and returns structured JSON via MCP tools. No official API exists — all data is scraped from the public court website.
