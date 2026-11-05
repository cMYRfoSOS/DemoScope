# DemoScope — серверная версия

## Render settings
- Language: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: leave empty
- Instance: Free

## Environment variable
Add this in Render → Environment:
- Key: `FACEIT_API_KEY`
- Value: your FACEIT API key

Never put the API key in `index.html`, `server.js`, GitHub, or a public message.

## Notes
The server uses the official FACEIT Data API v4. The first version displays public player profile data and lifetime statistics when available. If FACEIT returns an error, check the API key type/permissions in FACEIT App Studio.
