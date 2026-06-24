#!/usr/bin/env node
/**
 * Āina Atlas MCP server
 * ---------------------
 * Exposes the live Āina Atlas Hawaii property pipeline as Claude tools over
 * stdio (works in Claude Desktop).
 *
 * It wraps REAL, verified, publicly-callable endpoints on the "aina-atlas"
 * data API (addressapi.portofcams.com) — no fabricated fields, no invented
 * paths. Each tool maps to behavior confirmed with live curl:
 *
 *   resolve_address      -> GET /atlas/geocode  + GET /atlas/parcels/bbox
 *   lookup_parcel        -> GET /atlas/search   + GET /atlas/parcel/{tmk}
 *   generate_property_brief -> lookup_parcel data -> Anthropic Messages API
 *   compare_parcels      -> lookup_parcel x2 (trivial composition)
 *
 * Design note: this deliberately does NOT wrap POST /api/bluewave/property-brief.
 * That endpoint is broken in prod (it calls non-existent /api/parcel & /api/search
 * on the data API, so every request returns "parcel not found" — verified live).
 * Instead, the brief is composed here from the working /atlas/parcel data, reusing
 * the real Hawaii-property-analyst system prompt copied from that router. This
 * sidesteps the broken piece while still producing the intended brief shape.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Config (env-driven; see .env.example)
// ---------------------------------------------------------------------------
const AINA_BASE_URL = (
  process.env.AINA_BASE_URL || "https://addressapi.portofcams.com"
).replace(/\/+$/, "");
const AINA_API_KEY = process.env.AINA_API_KEY || ""; // optional paid-tier bearer
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ""; // for the brief tool
const BRIEF_MODEL = process.env.AINA_BRIEF_MODEL || "claude-opus-4-8";

const HTTP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP helper — talks to the public /atlas/* API with sane errors + timeout
// ---------------------------------------------------------------------------
async function atlasGet<T = any>(
  path: string,
  query?: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(AINA_BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  // Anonymous access is allowed; an optional bearer unlocks paid-tier fields.
  if (AINA_API_KEY) headers["Authorization"] = `Bearer ${AINA_API_KEY}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      // Surface the server's own message (e.g. 402 purchase-required, 404).
      throw new Error(
        `Āina Atlas API ${res.status} for ${path}: ${text.slice(0, 400)}`
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `Āina Atlas API returned non-JSON for ${path}: ${text.slice(0, 200)}`
      );
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Āina Atlas API timed out after ${HTTP_TIMEOUT_MS}ms for ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// A TMK is digits-only (e.g. 121010042). Accept user input with dashes/spaces.
function normalizeTmk(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Core data calls (each wraps one verified endpoint)
// ---------------------------------------------------------------------------

/** GET /atlas/parcel/{tmk} — the full free-tier structured parcel record. */
async function getParcelByTmk(tmk: string): Promise<any> {
  const clean = normalizeTmk(tmk);
  if (!clean) throw new Error(`"${tmk}" is not a valid TMK (need digits, e.g. 121010042).`);
  return atlasGet(`/atlas/parcel/${encodeURIComponent(clean)}`);
}

/** GET /atlas/search?q= — resolve a TMK (or text) to a parcel summary. */
async function searchAtlas(q: string): Promise<any> {
  return atlasGet(`/atlas/search`, { q });
}

/** GET /atlas/geocode?q= — free-text Hawaii address -> {lat,lon,label}. */
async function geocode(q: string): Promise<{ lat: number; lon: number; label: string } | null> {
  const r = await atlasGet<{ result: any }>(`/atlas/geocode`, { q });
  return r?.result ?? null;
}

/**
 * GET /atlas/parcels/bbox — parcels intersecting a small box around a point.
 * Used to turn a geocoded lat/lon into the TMK(s) underneath it.
 */
async function parcelsNearPoint(lat: number, lon: number): Promise<any[]> {
  // ~30m box around the point (Honolulu latitudes ~ 0.00027 deg ≈ 30m).
  const d = 0.00027;
  const r = await atlasGet<{ parcels: any[] }>(`/atlas/parcels/bbox`, {
    minLon: lon - d,
    minLat: lat - d,
    maxLon: lon + d,
    maxLat: lat + d,
    max: 25,
  });
  return r?.parcels ?? [];
}

/**
 * Resolve an address OR a TMK to a single TMK string.
 * - If a TMK is provided, it's normalized and returned.
 * - Else the address is geocoded, then the bbox lookup finds the parcel under it.
 */
async function resolveToTmk(opts: { address?: string; tmk?: string }): Promise<{
  tmk: string;
  via: string;
  geocode?: { lat: number; lon: number; label: string };
}> {
  if (opts.tmk) {
    const clean = normalizeTmk(opts.tmk);
    if (!clean) throw new Error(`"${opts.tmk}" is not a valid TMK.`);
    return { tmk: clean, via: "tmk" };
  }
  if (!opts.address) {
    throw new Error("Provide either an address or a tmk.");
  }

  // 1) Try /atlas/search first (handles bare-TMK-as-text and some addresses).
  const searched = await searchAtlas(opts.address);
  if (searched?.kind === "tmk" && Array.isArray(searched.results) && searched.results[0]?.tmk) {
    return { tmk: normalizeTmk(searched.results[0].tmk), via: "search" };
  }

  // 2) Geocode the address, then find the parcel under the centroid via bbox.
  const g = await geocode(opts.address);
  if (!g) {
    throw new Error(
      `Could not geocode "${opts.address}". Try a more specific Hawaii address (street + city), or pass a TMK directly.`
    );
  }
  const nearby = await parcelsNearPoint(g.lat, g.lon);
  if (!nearby.length || !nearby[0]?.tmk) {
    throw new Error(
      `Geocoded "${opts.address}" to ${g.label} (${g.lat}, ${g.lon}), but no parcel was found at that point. Pass a TMK directly if you have one.`
    );
  }
  return { tmk: normalizeTmk(nearby[0].tmk), via: "geocode+bbox", geocode: g };
}

// ---------------------------------------------------------------------------
// AI property brief — composed locally from real parcel data.
// _SYSTEM / _SCHEMA are copied verbatim from the live router
// (routers/bluewave_property_brief.py) so the brief shape matches John's product.
// ---------------------------------------------------------------------------
const BRIEF_SYSTEM = `You are a Hawaii property analyst. Given a parcel record from the
state GIS service, you draft a short factual brief for the homeowner
in spec-sheet voice (third-person, no "you" or "we").

Return ONLY valid JSON matching the schema. Cite specific parcel
fields when relevant (TMK, acres, zoning code, island). Hawaii
risks to flag when applicable: lava zone (Big Island), flood zone,
shoreline setback (within 40ft of MHHW), archaeological/cultural
sites (anywhere coastal or upcountry), termite pressure (statewide),
salt-air corrosion (windward + south shores).

Disclaimer must include "Public-record summary, not legal or
appraisal advice."`;

const BRIEF_SCHEMA = `Schema:
{
  "summary": string,
  "snapshot": {
    "tmk": string,
    "island": string,
    "county": string,
    "acres": number,
    "zoning": string,
    "homeowner_exemption": string|null
  },
  "watch_outs": [string],
  "recommended_actions": [string],
  "deep_links": [{ "label": string, "url": string }],
  "disclaimer": string
}`;

async function composeBrief(parcel: any): Promise<any> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      "generate_property_brief needs ANTHROPIC_API_KEY in the environment. " +
        "The lookup_parcel and resolve_address tools work without it."
    );
  }
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: BRIEF_MODEL,
    max_tokens: 8192,
    // Adaptive thinking is the recommended default on Opus 4.8.
    thinking: { type: "adaptive" },
    system: BRIEF_SYSTEM + "\n\n" + BRIEF_SCHEMA,
    messages: [
      {
        role: "user",
        content:
          "Parcel record (Āina Atlas / Hawaii state GIS):\n" +
          JSON.stringify(parcel, null, 2) +
          "\n\nGenerate the JSON brief now.",
      },
    ],
  });

  // Pull the first text block and parse the model's JSON.
  const textBlock = msg.content.find((b) => b.type === "text");
  const raw = textBlock && "text" in textBlock ? textBlock.text : "";
  const jsonStr = extractJson(raw);
  try {
    return JSON.parse(jsonStr);
  } catch {
    // If the model wrapped prose around it, return the raw text so the caller
    // still gets something useful instead of a crash.
    return { summary: raw, _note: "Model did not return strict JSON; raw text above." };
  }
}

/** Grab the first {...} JSON object from a string (handles code-fence wrapping). */
function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return s.slice(start, end + 1);
  return s.trim();
}

// ---------------------------------------------------------------------------
// MCP server + tool definitions
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "aina-atlas-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "resolve_address",
    description:
      "Resolve a Hawaii street address (or a TMK) to a Tax Map Key (TMK) parcel id. " +
      "Geocodes the address (HI-bounded Nominatim) then finds the parcel under it. " +
      "Use this first when you only have an address; feed the TMK into lookup_parcel.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Free-text Hawaii address, e.g. '500 Ala Moana Blvd, Honolulu'." },
        tmk: { type: "string", description: "A TMK (digits, dashes ok). If given, address is ignored." },
      },
    },
  },
  {
    name: "lookup_parcel",
    description:
      "Look up the full Āina Atlas parcel record for a Hawaii property by address or TMK. " +
      "Returns the real structured JSON: TMK, island, acres, owner, zoning, land/building value, " +
      "hazards (lava zone, tsunami evacuation, FEMA flood), Hawaiian context (ahupuaʻa / moku / mokupuni), " +
      "slope & solar exposure, native plants, ADU eligibility, AVM, tax-appeal window, and deep links. " +
      "This is the core lookup and needs no API key.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Hawaii address to resolve, e.g. '500 Ala Moana Blvd, Honolulu'." },
        tmk: { type: "string", description: "TMK parcel id (digits, dashes ok), e.g. 121010042. Skips address resolution." },
      },
    },
  },
  {
    name: "generate_property_brief",
    description:
      "Generate an AI property brief for a Hawaii address: a plain-English summary, a quick-facts snapshot, " +
      "Hawaii-specific watch-outs (lava/flood/shoreline/cultural sites), recommended next steps, and deep links. " +
      "Looks up the real parcel via Āina Atlas, then drafts the brief with Claude. Requires ANTHROPIC_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Hawaii address to brief, e.g. '500 Ala Moana Blvd, Honolulu'." },
        tmk: { type: "string", description: "TMK instead of an address (digits, dashes ok)." },
      },
    },
  },
  {
    name: "compare_parcels",
    description:
      "Compare two Hawaii parcels side by side. Each input may be an address or a TMK. " +
      "Returns both full parcel records plus a compact diff of key fields (acres, zoning, values, hazards, ADU).",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "First parcel: an address or TMK." },
        b: { type: "string", description: "Second parcel: an address or TMK." },
      },
      required: ["a", "b"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Treat an input string as a TMK if it's basically all digits; else an address.
function asResolveOpts(input: string): { address?: string; tmk?: string } {
  const digits = input.replace(/[^0-9]/g, "");
  const looksLikeTmk = digits.length >= 8 && digits.length <= 13 && /^[0-9\- ]+$/.test(input.trim());
  return looksLikeTmk ? { tmk: input } : { address: input };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "resolve_address": {
        const a = args as { address?: string; tmk?: string };
        const r = await resolveToTmk(a);
        return jsonResult(r);
      }

      case "lookup_parcel": {
        const a = args as { address?: string; tmk?: string };
        const { tmk, via, geocode: g } = await resolveToTmk(a);
        const parcel = await getParcelByTmk(tmk);
        return jsonResult({ resolved_via: via, ...(g ? { geocode: g } : {}), parcel });
      }

      case "generate_property_brief": {
        const a = args as { address?: string; tmk?: string };
        const { tmk } = await resolveToTmk(a);
        const parcel = await getParcelByTmk(tmk);
        const brief = await composeBrief(parcel);
        return jsonResult({
          tmk,
          brief,
          generated_at: new Date().toISOString(),
          source: "Āina Atlas (addressapi.portofcams.com) parcel data; brief drafted by " + BRIEF_MODEL,
        });
      }

      case "compare_parcels": {
        const a = args as { a: string; b: string };
        if (!a.a || !a.b) throw new Error("compare_parcels needs both 'a' and 'b'.");
        const [ra, rb] = await Promise.all([
          resolveToTmk(asResolveOpts(a.a)),
          resolveToTmk(asResolveOpts(a.b)),
        ]);
        const [pa, pb] = await Promise.all([getParcelByTmk(ra.tmk), getParcelByTmk(rb.tmk)]);
        return jsonResult({ a: pa, b: pb, diff: diffParcels(pa, pb) });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    // Return a useful, non-crashing error to the model.
    return {
      content: [{ type: "text", text: `Error in ${name}: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
});

// A compact, human-readable comparison of the fields that matter most.
function diffParcels(a: any, b: any) {
  const pick = (p: any) => ({
    tmk: p?.tmk ?? null,
    island: p?.island ?? null,
    acres: p?.acres ?? null,
    zoning: p?.zoning?.code ?? null,
    land_value: p?.land_value ?? null,
    building_value: p?.building_value ?? null,
    lava: p?.hazards?.lava ?? null,
    tsunami_evac: p?.hazards?.tsunami_evac ?? null,
    fema_flood: p?.hazards?.fema_flood ?? null,
    adu_eligible: p?.adu?.eligible ?? null,
    ahupuaa: p?.hawaiian_context?.ahupuaa ?? null,
  });
  return { a: pick(a), b: pick(b) };
}

function jsonResult(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP stdio channel and must stay clean.
  console.error(
    `aina-atlas-mcp running on stdio (data: ${AINA_BASE_URL}; brief model: ${BRIEF_MODEL}; ` +
      `brief ${ANTHROPIC_API_KEY ? "enabled" : "DISABLED — set ANTHROPIC_API_KEY"})`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
