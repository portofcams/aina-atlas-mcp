# Privacy Policy — Āina Atlas MCP

This MCP server provides read-only lookups over publicly available Hawaii property/GIS data (parcel, zoning, FEMA flood, USGS lava/tsunami, ahupuaʻa context, ADU, AVM) and can compose an AI property brief.

- **No personal data collected.** The tools take a Hawaii address or TMK and return public parcel/hazard records. No end-user personal information is requested, stored, or transmitted.
- **Read-only, no retention.** Lookups are read-only. The server stores nothing and logs nothing beyond transient operational errors needed to run.
- **Data source.** Public Hawaii county/state GIS endpoints + FEMA NFHL (public records).
- **AI brief.** If `ANTHROPIC_API_KEY` is configured, parcel data is sent to the Anthropic API to generate a text brief; this server retains none of it.

Contact: john@binnacleai.com — BlueWave Projects (https://bluewaveprojects.com)
Last updated: 2026-06-24
