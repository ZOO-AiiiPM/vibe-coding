# vibe-coding

Local-first AI information manager for macOS. It combines notes, web clipping,
RSS/Atom subscriptions, local SQLite search, and an optional AI assistant.

This public project is the contents of this `app/` directory. The parent
workspace contains private development notes, skills, journals, and specs and is
not part of the open-source app.

## Features

- Markdown notes with CodeMirror live preview, tables, tasks, image paste/drop,
  and local attachments.
- Web clipping that fetches article metadata and stores readable Markdown.
- RSS/Atom subscriptions with unread state and local feed storage.
- Chinese-friendly full-text search powered by rusqlite, SQLite FTS5, and
  jieba tokenization.
- Optional AI panel for reading current notes/clips and answering questions
  with local tool access.

## Requirements

- macOS (Apple Silicon) for the current packaged app. Intel Macs are not yet supported.
- Node.js 22.
- pnpm 10.28.1.
- Rust toolchain with the Tauri 2 prerequisites installed.

## Development

```bash
pnpm install
pnpm tauri dev
```

Useful checks:

```bash
pnpm lint
pnpm build
cd src-tauri && cargo test
```

## Optional AI Configuration

The app runs without an AI key. To enable the AI panel, open the AI settings
button in the app and save an OpenAI-compatible API key, optional base URL, and
model. Public release builds do not contain a developer API key.

## Local Data

On macOS, the app stores its SQLite database and attachments under:

```text
~/Library/Application Support/com.vibecoding.app/
```

No notes, clips, feeds, or attachments are uploaded by the app itself.

## Release

GitHub Actions builds draft macOS releases when a `v*` tag is pushed:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Current demo builds are unsigned. On first launch, macOS may require
right-clicking the app and choosing Open.

## License

MIT
