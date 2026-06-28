# Deploying the Āina Atlas remote MCP server

`build/index.js` is the unchanged **stdio** server (Claude Desktop / npm).
`build/http.js` is the new **remote Streamable HTTP** server — deploy this so the
connector is reachable over HTTPS (and eligible for the Anthropic Connectors Directory).

## 1. Build
```bash
npm ci && npm run build
```

## 2. Run — IMPORTANT: no Anthropic key on the public box
```bash
PORT=8090 node build/http.js
```
Leave `ANTHROPIC_API_KEY` **unset** on the public deployment. The keyless parcel
tools (`resolve_address`, `lookup_parcel`, `compare_parcels`) work fine; the
credit-spending `generate_property_brief` tool is **hidden when no key is set**, so
strangers can't run up your Anthropic bill. (Set the key only on a private/auth'd instance.)

## 3. systemd unit (Vultr 144.202.116.229)
Deploy the repo to `/root/aina-atlas-mcp`, then `/etc/systemd/system/aina-atlas-mcp.service`:
```ini
[Unit]
Description=Aina Atlas remote MCP server
After=network.target

[Service]
WorkingDirectory=/root/aina-atlas-mcp
Environment=PORT=8090
ExecStart=/usr/bin/node build/http.js
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
systemctl enable --now aina-atlas-mcp
```

## 4. DNS + Nginx Proxy Manager
- Cloudflare: `A  aina-atlas-mcp.portofcams.com -> 144.202.116.229`
- NPM: new proxy host `aina-atlas-mcp.portofcams.com -> 127.0.0.1:8090`, SSL on, **Websockets support enabled** (SSE needs it).

## 5. Verify
```bash
curl https://aina-atlas-mcp.portofcams.com/healthz
curl https://aina-atlas-mcp.portofcams.com/privacy
```

## 6. List the remote entry in the MCP Registry
- Confirm `server-remote.json` `remotes[0].url` matches the deployed host.
- `mcp-publisher login github` (browser device code) then `mcp-publisher publish server-remote.json`.

## 7. Anthropic Connectors Directory (now eligible)
Requirements this build already meets: remote HTTPS endpoint, every tool carries
`readOnlyHint`, public privacy policy at `/privacy`. Still required: a **Team or
Enterprise Claude org** — the submission portal lives in Claude.ai admin settings
(not available on individual plans). Submit there, then track status in the
submissions dashboard.

## Local smoke test (already passing)
```bash
PORT=8099 node build/http.js &
curl -s localhost:8099/healthz
# initialize -> capture mcp-session-id header -> notifications/initialized -> tools/list
```
