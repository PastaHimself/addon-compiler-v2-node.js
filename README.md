# Add-On Compiler

Node.js + Next.js rewrite of the original Wails/Go Minecraft Bedrock add-on compiler. This version is designed for Vercel and processes uploaded folders or packaged archives through server-side Node routes.

## Stack

- Next.js App Router
- TypeScript
- Vercel Blob for uploads and compiled output artifacts
- JSZip for archive ingest/export
- Vitest for core compiler tests

## Features

- Upload extracted folders or packaged files: `.zip`, `.mcpack`, `.mcaddon`, `.mcworld`
- Hosted workflow is upload-based. The Vercel deployment does not scan local Bedrock folders directly.
- Build a catalog of:
  - Resource Packs
  - Add-Ons
  - Behavior Packs
  - Worlds
  - Pairing and duplicate warnings
- Compile targets to:
  - Resource Pack -> `.mcpack`
  - Behavior Pack -> `.mcpack`
  - Add-On -> `.mcaddon` or `.zip`
  - World -> `.mcworld`
- Update Script API dependencies to `beta`
- Normalize add-ons using `texts/en_US.lang`
- Store output artifacts in Vercel Blob and return download URLs

## Environment

Set the following environment variable in Vercel and local development:

```bash
BLOB_READ_WRITE_TOKEN=...
```

Use Node.js 20 or newer for local development.

If Vercel Blob client uploads fail with `Failed to retrieve the client token`:

- Verify `BLOB_READ_WRITE_TOKEN` exists in the project environment.
- In Vercel, make sure System Environment Variables are enabled so Blob can infer its callback URL.
- For local tunneling flows, set:

```bash
VERCEL_BLOB_CALLBACK_URL=https://your-public-tunnel-url.example
```

## Development

```bash
npm install
npm run dev
```

## Test

```bash
npm test
```

## Deploy to Vercel

1. Create a Vercel Blob store and connect it to the project.
2. Set `BLOB_READ_WRITE_TOKEN`.
3. Deploy as a standard Next.js project.

All server routes use the Node.js runtime and rebuild a temporary workspace per request from the uploaded Blob session.
