# Āina Atlas MCP

An [MCP](https://modelcontextprotocol.io) server that exposes my live **Āina Atlas** Hawaii property pipeline as Claude tools. Ask Claude about any Hawaii address or TMK and it can pull the real parcel record — zoning, lava/tsunami/FEMA flood hazards, ahupuaʻa context, ADU eligibility, AVM, tax-appeal window — and draft an AI property brief.

It wraps the **real, publicly-callable** `/atlas/*` endpoints on my "aina-atlas" data API (no key required for lookups), and composes the brief locally via the Anthropic API. Every field returned is whatever the live API returns — nothing is fabricated.

> Honest scope line: this wraps my live Āina Atlas property pipeline. The lookup tools hit the production data API directly. The brief is drafted by Claude from that real parcel data, reusing the same Hawaii-property-analyst prompt as my web product.

## Tools

| Tool | Input | What it does | Backing |
| --- | --- | --- | --- |
| `resolve_address` | `address` or `tmk` | Resolve a Hawaii address (or TMK) to a Tax Map Key | `GET /atlas/geocode` + `GET /atlas/parcels/bbox` + `GET /atlas/search` (public) |
| `lookup_parcel` | `address` or `tmk` | Full structured parcel record | `GET /atlas/search` + `GET /atlas/parcel/{tmk}` (public, no key) |
| `generate_property_brief` | `address` or `tmk` | Parcel lookup → Claude-drafted brief (summary, snapshot, watch-outs, actions, deep links) | `lookup_parcel` data → Anthropic Messages API |
| `compare_parcels` | `a`, `b` (each an address or TMK) | Two parcels side by side + a key-field diff | Two `lookup_parcel` calls |

`lookup_parcel`, `resolve_address`, and `compare_parcels` work with **no API key**. `generate_property_brief` needs `ANTHROPIC_API_KEY`.

## What the parcel record includes

The `lookup_parcel` response is the live free-tier Āina Atlas JSON, including:
`tmk`, `island`, `address`, `acres`, `owner`, `land_value`, `building_value`, `has_homeowner_exemption`, `zoning` (`code`, `land_use`), `hazards` (`lava`, `tsunami_evac`, `fema_flood`), `hawaiian_context` (`ahupuaa`, `moku`, `mokupuni`, `gis_acres`), `slope` (elevation, slope %, classification, aspect, solar exposure), `native_plants`, `tax_appeal` (county appeal window + deadline), `nearby_places`, `county_links`, `centroid`, `geometry` (rings), `adu` (eligibility, max unit size, notes), `ocean_view`, `shoreline`, `soil`, `rainfall`, `conservation`, `wildfire`, `property_tax`, `zoning_rules`, `avm`, and `deed_link`.

## Install

```bash
cd aina-atlas-mcp
npm install
npm run build        # compiles src/ -> build/index.js
cp .env.example .env # then fill in ANTHROPIC_API_KEY for the brief tool
```

Quick smoke test from the shell (lists the tools over stdio — no key needed):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node build/index.js
```

## Add to Claude Desktop

Edit `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "aina-atlas": {
      "command": "node",
      "args": ["/Users/johnthomasair/code/aina-atlas-mcp/build/index.js"],
      "env": {
        "AINA_BASE_URL": "https://addressapi.portofcams.com",
        "ANTHROPIC_API_KEY": "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Use an absolute path to `build/index.js`. Restart Claude Desktop; the `aina-atlas` tools appear in the tools menu. Leave `ANTHROPIC_API_KEY` out if you only want the lookup tools (the brief tool will return a clear "needs ANTHROPIC_API_KEY" error).

## Demo prompts

- **"What are the flood and lava-zone risks at 500 Ala Moana Blvd, Honolulu?"** — calls `lookup_parcel`, reads `hazards.fema_flood` / `hazards.lava`.
- **"Give me an Āina Atlas property brief for TMK 121010042."** — calls `generate_property_brief`.
- **"Compare TMK 121010042 and 121010015 — zoning, value, and ADU eligibility."** — calls `compare_parcels`.
- **"What ahupuaʻa is this parcel in, and is it ADU-eligible?"** — `lookup_parcel`, reads `hawaiian_context.ahupuaa` and `adu`.

## Configuration

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `AINA_BASE_URL` | no | `https://addressapi.portofcams.com` | Āina Atlas data API base |
| `ANTHROPIC_API_KEY` | for brief only | — | Drafts the property brief |
| `AINA_BRIEF_MODEL` | no | `claude-opus-4-8` | Model for the brief |
| `AINA_API_KEY` | no | — | Optional paid-tier bearer (unlocks paid surfaces; not needed for the lookup tools) |

## Architecture notes / TODO

- **Why the brief is composed here instead of wrapping the server's brief endpoint:** the data API exposes the public brief route `POST /api/bluewave/property-brief`, but it is **broken in production** — its internal parcel lookup calls `/api/parcel` and `/api/search`, while the live data API only serves `/atlas/parcel` and `/atlas/search`, so every request returns `"parcel not found"` (verified live). This server therefore wraps the working `/atlas/parcel` data and drafts the brief itself, reusing that endpoint's real system prompt. **TODO (server-side, not this repo):** a one-line path fix in `routers/bluewave_property_brief.py` (`/api/parcel`→`/atlas/parcel`, `/api/search`→`/atlas/search`) would restore the upstream endpoint; this MCP could then optionally call it directly.
- **Paid report PDF (`GET /atlas/report/{tmk}`)** and the **insurance-brief preview (`/api/insurebrief/*`)** are intentionally **not** exposed as tools: the report is a binary PDF behind a paywall (402), and the insurebrief proxy currently 404s against the live data-API build (its `/atlas/insurebrief/*` routes aren't deployed yet — verified). Both are TODOs pending real, callable backing.

## License

MIT

---

## Work with me

I'm John Thomas — I run **BlueWave Projects**, an AI build studio. I ship production MCP servers, Claude agents, and LLM-in-the-loop pipelines — usually in days, not months — over real, often regulated data (FAA Part 135, maritime AIS, Hawaii property records). USCG Master Captain; deep in aviation, maritime, and construction operations.

Want Claude wired into your own data or workflow? **john@binnacleai.com** · https://bluewaveprojects.com
