# Free AI ReCaptcha Solver by Raptor

A browser extension that automatically solves reCAPTCHA image challenges using a built-in ONNX neural network. Completely free — no API key or registration required.

## Features

- Solves 3×3 and 4×4 reCAPTCHA image challenges locally using on-device AI models
- Auto-opens the reCAPTCHA checkbox and starts solving without user interaction
- Configurable solve delay (default 2 s) to avoid triggering bot detection
- Perceptual hash cache — a bundled SQLite database of known image hashes with verified answers is checked before running inference, improving both speed and accuracy

## Installation

Requires Chrome 111+.

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder

## Configuration

Click the extension icon to open the popup. Available settings:

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | On | Master on/off switch |
| Auto-open | On | Automatically click the reCAPTCHA checkbox |
| Auto-solve | On | Automatically solve the image challenge |
| Between tile clicks | 300 ms | Pause between clicking individual tiles (3×3 only) |
| Dynamic reveal → click | 850 ms | Pause from a new dynamic tile image appearing to clicking it (counts recognition time already spent) |
| Last click → verify | 850 ms | Pause between the final tile click and pressing Verify |
| Disabled sites | — | Hostnames where the extension is inactive |

A random 0–300 ms jitter is added to each timeout above every time it fires. Tiles in a 3×3 challenge are clicked in a randomized order.

## How It Works

1. Content scripts injected into reCAPTCHA frames intercept the challenge UI.
2. Each challenge image is perceptually hashed and looked up in the bundled SQLite cache (`db/captcha.sqlite`). Cache hits return the verified answer without running inference.
3. On a cache miss, the images are passed to two ONNX models running entirely in the browser: `models/type.onnx` determines whether each tile contains the target object (3×3 challenges); `models/grid.onnx` scores each tile position for the correct selection (4×4 challenges).
4. Matching tiles are clicked via the MAIN-world content script that wraps the page's `addEventListener`.

## Changes in this fork

Forked from [CaptchaRaptor/captchaplugin](https://github.com/CaptchaRaptor/captchaplugin) at commit `6138f62`.
This fork has no network code of its own: nothing is sent to any server, and no server can send it commands.

### Removed: remote control (WS addon)
- Deleted the `ws-addon/` folder. It kept a permanent connection to `wss://ws.captcharaptor.com`,
  took solving tasks from that server, and used the `debugger`, `tabs` and all-sites permissions to
  solve captchas for third parties with your IP address and Google login.
- Deleted the `extension/ws/background_ws.js` stub and the WS mode switch in the popup.

### Removed: data uploads
- Deleted `extension/uploader.js`, which uploaded captcha images, selected tiles and solve results to
  `captcharaptor.com` every hour and whenever the computer went idle. It was on by default.
- Removed the random reporting key generated per browser profile.
- Removed the local IndexedDB image log (`caplog` database) that stored every captcha image for upload.
- Deleted the Reports page (`reports.html`, `reports.js` and the Reports section of the popup).

### Tightened permissions
- Dropped the `alarms` and `idle` permissions, which only the uploader used.
- Bundled files (models, ONNX Runtime, helper scripts) are now exposed only to reCAPTCHA frames on
  `google.com` and `recaptcha.net`. Upstream exposed them to every website, which also let any site
  detect the extension.
- The SQLite database and its library are no longer exposed to web pages; only the background script uses them.

### Cleanup
- Deleted unused files: `lib/selector.js` and `lib/sql-wasm.mjs`.
- Removed two unused fetch helpers from `background.js`.
- Removed the popup link to `captchaplugin.com`.

### Known issues
- Turning the solver off tries to show grey icons (`icon/16g.png`, `32g`, `48g`, `128g`) that don't exist.
  This bug is in upstream too.

## License

MIT — see [LICENSE](LICENSE)
