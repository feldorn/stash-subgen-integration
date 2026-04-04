# Subgen Integration Plugin for Stash

A [Stash](https://github.com/stashapp/stash) plugin that integrates with [Subgen](https://github.com/McCloudS/subgen) to automatically generate subtitles for your media library scenes.

## Features

- **One-click subtitle generation** — adds a "Generate Subtitles" option to the scene three-dot menu
- **In-browser subtitle editor** — view and edit generated `.srt` files without leaving Stash (appears as "Edit Subtitles" in the menu when a subtitle already exists)
- **Automatic Stash scan trigger** — after generation, Stash is automatically rescanned so the subtitle appears immediately
- **MP4 pipe compatibility fix** — optionally remuxes files whose moov atom is not at the start, which would otherwise cause Subgen to fail
- **Multilingual support** — auto-detects audio language; translates to English or transcribes in the native language depending on your settings
- **Configurable settings** — Subgen URL, translate to English, debug logging, auto-fix, and backup creation are all configurable from the Stash plugin settings UI
- **SPA-aware** — survives Stash's single-page app navigation without page reloads

## How It Works

The plugin has two components:

**JavaScript frontend** (`subgen-integration.js`) runs inside the Stash web UI. It injects menu items into the scene detail dropdown, handles user interaction, and calls the Python backend via Stash's GraphQL `runPluginTask` / `runPluginOperation` mutations.

**Python backend** (`subgen-integration.py`) runs server-side inside the Stash container. It queries the Stash GraphQL API for the scene's file path, uploads the video file to Subgen's `/asr` endpoint, writes the returned `.srt` file next to the video, and triggers a Stash metadata scan.

## Dependencies

### Required

| Dependency | Purpose | Notes |
|---|---|---|
| [Stash](https://github.com/stashapp/stash) | Media server and plugin host | v0.23.0+ recommended; older versions may pass booleans as strings (handled) |
| [Subgen](https://github.com/McCloudS/subgen) | AI subtitle generation service | Must be running and network-reachable from the Stash container |
| Python 3 | Runs the backend script | Must be available inside the Stash container |
| `ffmpeg` | Pipe compatibility check and remux | Must be available inside the Stash container (standard in most Stash Docker images) |

### Python Packages (backend)

The following packages must be available in the Python environment inside the Stash container:

```
requests
urllib3
```

Install with:

```bash
pip install requests urllib3
```

These are typically pre-installed in Stash Docker images. If not, install them inside the container or add them to your Docker setup.

### Docker / Network Setup

This plugin is designed for a **Docker Compose** deployment where Stash and Subgen run as sibling containers on the same Docker network.

By default the plugin connects to Subgen at `http://subgen:9000`, using the Docker container name as the hostname. If your Subgen container has a different name or runs on a different host/port, configure the URL in the plugin settings.

Example `docker-compose.yml` snippet:

```yaml
services:
  stash:
    image: stashapp/stash:latest
    # ... your stash config ...

  subgen:
    image: mccloud/subgen:latest
    environment:
      - WHISPER_MODEL=medium
      - CONCURRENT_TRANSCRIPTIONS=2
      # Add other Subgen config as needed
    ports:
      - "9000:9000"
```

Both services must be on the same Docker network so `stash` can reach `http://subgen:9000`.

## Installation

1. Copy the three plugin files into your Stash plugins directory:
   ```
   ~/.stash/plugins/subgen-integration/
   ├── subgen-integration.js
   ├── subgen-integration.py
   └── subgen-integration.yml
   ```

2. In Stash, go to **Settings → Plugins** and click **Reload Plugins**.

3. The plugin will appear as **Subgen** in the plugin list.

## Configuration

Go to **Settings → Plugins → Subgen** to configure:

| Setting | Default | Description |
|---|---|---|
| **Subgen Webhook URL** | `http://subgen:9000` | URL to your Subgen instance. Leave blank to use the default Docker network address. |
| **Translate to English** | Off | When enabled, Whisper translates any audio language to English subtitles (`.eng.srt`). Safe for English audio — translating English to English is a no-op. Disable if you want native-language subtitles (`.srt`). |
| **Debug Logging** | Off | Enables verbose logging to the browser console (F12). Useful for troubleshooting. |
| **Auto-fix Pipe Compatibility Issues** | Off | Automatically remuxes MP4 files that fail the ffmpeg pipe compatibility check (moov atom not at start). Recommended if you encounter silent failures. |
| **Create Backup Files** | Off | Creates a `.bak` copy of the original file before remuxing. Useful for safety during testing. |

## Usage

1. Navigate to any scene detail page in Stash.
2. Click the **three-dot menu** (⋮) in the scene header.
3. Select **Generate Subtitles**.
4. A confirmation dialog will appear. Subtitle generation runs server-side and may take several minutes depending on video length and your hardware.
5. Progress is visible in the Stash server logs.
6. Once complete, the subtitle file (`.eng.srt`) is saved next to the video and Stash is automatically rescanned.
7. If a subtitle already exists, an **Edit Subtitles** option will also appear in the menu, opening an in-browser editor with line numbers.

## Subtitle Files

Generated subtitles are saved in the same directory as the source video. The filename depends on the **Translate to English** setting:

| Setting | Output file | Notes |
|---|---|---|
| Translate to English = On | `video.eng.srt` | Any audio language → English subtitles |
| Translate to English = Off | `video.srt` | Audio transcribed in its detected language |

The plugin checks for existing subtitles in priority order: `.eng.srt`, `.en.srt`, `.srt`.

Audio language is always auto-detected by Whisper — no configuration required. The source language does not need to be specified. Whisper's translate task is safe for English audio; translating English to English produces identical output to transcription.

## Troubleshooting

**"File not found in Stash container"** — The video path queried from Stash does not exist inside the container. Verify your volume mounts match between your compose file and Stash's library paths.

**Subgen returns empty response** — The video file may have pipe compatibility issues. Enable **Auto-fix Pipe Compatibility Issues** in plugin settings.

**Subtitle generated but not appearing in Stash** — The automatic rescan may have been skipped. Manually trigger a library scan in Stash (**Tasks → Scan**).

**"Could not trigger automatic scan"** — Non-fatal. The subtitle is saved successfully; trigger a manual scan.

**Debug logging** — Enable **Debug Logging** in plugin settings and open your browser's developer console (F12) for detailed trace output.

## License

MIT
