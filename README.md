# musicxml-editor

A browser-based, WYSIWYG **MusicXML editor**. Add, move, and remove notes on a
staff, and import/export MusicXML — everything client-side, no backend.

**Use it at [musicxml-editor.netlify.app](https://musicxml-editor.netlify.app).**

Its Import feature also recovers MusicXML from a photo, scan, or PDF of sheet
music (via a client-side optical-music-recognition pipeline) and from MIDI
files.

## Layout

- **`editor/`** — the WYSIWYG MusicXML editor (Preact), the primary app and the
  deploy target. See [`editor/PLAN.md`](editor/PLAN.md).
- **`lib/import-image/`** — the OMR pipeline that powers the editor's "import
  from an image/PDF" feature, folded into the root toolchain. See
  [`lib/import-image/AGENTS.md`](lib/import-image/AGENTS.md).

See [`AGENTS.md`](AGENTS.md) for the full architecture and development notes.

## Development

Requires only `make` and `docker`.

```sh
make build       # build the editor into editor/dist
make dev         # build + rebuild on change
make pr-ready    # format, lint, typecheck, build, unit-test
```

## Deployment

Netlify deploys the editor from `editor/dist` — see `netlify.toml`.
