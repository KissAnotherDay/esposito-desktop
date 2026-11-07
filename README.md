# 🎧 Esposito HI-FI — Desktop App

> A native desktop music player built with **Electron**, powered by the **Qobuz API**, with **Discord Rich Presence** support.

![Version](https://img.shields.io/badge/version-6.3.1-blue)
![Electron](https://img.shields.io/badge/Electron-31-47848F?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Screenshots](#-screenshots)
- [Requirements](#-requirements)
- [Installation](#-installation)
- [Running in Development](#-running-in-development)
- [Building the Executable](#-building-the-executable)
- [Discord Rich Presence](#-discord-rich-presence)
- [Project Structure](#-project-structure)
- [Configuration & Data Storage](#-configuration--data-storage)
- [Troubleshooting](#-troubleshooting)
- [Disclaimer](#-disclaimer)

---

## 🔎 Overview

**Esposito HI-FI** is a desktop client for high-resolution music streaming that talks to the Qobuz API. It is packaged as a standalone Electron application, so you can run it as a regular program on your computer instead of in a browser — complete with native window controls, a mini player, lyrics, and Discord integration to show what you are listening to.

---

## ✨ Features

- 🖥️ **Native desktop experience** — runs as a standalone app on Windows, macOS and Linux
- 🎵 **Qobuz API client** — browse and play music through the Qobuz API
- 💬 **Discord Rich Presence** — show your currently playing track on your Discord profile via [`discord-rpc`](https://www.npmjs.com/package/discord-rpc)
- 🪟 **Mini player** — compact secondary window (`mini.html`)
- 🎤 **Lyrics support** — dedicated lyrics module (`lyrics.js`)
- 🏷️ **Track tagging** — metadata tagging utilities (`tagger.js`)
- 🍎 **Apple library import** — import helpers for Apple Music data (`apple.js`, `apple_import.js`)
- 💾 **Persistent settings & queue** — saved automatically between sessions
- ⚙️ **Configurable API base URL** — editable from the in-app Settings
- 🎛️ **Smart window controls** — custom close/minimize/maximize buttons on Windows/Linux, native traffic-light buttons on macOS

---

## 📸 Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="screenshots/01-artist-page.png" alt="Artist page" /><br />
      <sub><b>Artist page</b> — hero banner, avatar, “Play Top” and popular tracks with quality badges</sub>
    </td>
    <td align="center" width="50%">
      <img src="screenshots/02-album-page.png" alt="Album page" /><br />
      <sub><b>Album page</b> — Hi-Res badge, track count and duration, label info and the full tracklist</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="screenshots/03-fullscreen-player.png" alt="Fullscreen player" /><br />
      <sub><b>Fullscreen player</b> — large cover art, quality badges (24-bit / 44.1 kHz) and a floating glass control panel</sub>
    </td>
    <td align="center" width="50%">
      <img src="screenshots/04-fullscreen-lyrics.png" alt="Fullscreen lyrics" /><br />
      <sub><b>Synced lyrics view</b> — compact player on the left, large scrolling lyrics on the right</sub>
    </td>
  </tr>
  <tr>
   <td align="center" colspan="2">
    <video src="https://private-user-images.githubusercontent.com/150908170/691581817-3d53d4be-12d8-4e53-b5d1-438fa572eff5.mp4?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3OTM1NTgxNTAsIm5iZiI6MTc5MzU1Nzg1MCwicGF0aCI6Ii8xNTA5MDgxNzAvNjkxNTgxODE3LTNkNTNkNGJlLTEyZDgtNGU1My1iNWQxLTQzOGZhNTcyZWZmNS5tcDQ_WC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lBVkNPRFlMU0E1M1BRSzRaQSUyRjIwMjYxMTAxJTJGdXMtZWFzdC0xJTJGczMlMkZhd3M0X3JlcXVlc3QmWC1BbXotRGF0ZT0yMDI2MTEwMVQxODMwNTBaJlgtQW16LUV4cGlyZXM9MzAwJlgtQW16LVNpZ25hdHVyZT1jZmFlMzBmOWMwMDUxMzE2MzQxMDA4NDE4ZWM1N2Y2NGY2YzhlNDY4MTU2NWQ3YTk1NGUzYjlkMmFlZjE2YjZhJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZyZXNwb25zZS1jb250ZW50LXR5cGU9dmlkZW8lMkZtcDQifQ.nKb2yMDC8-zMBE_AT11rILsBS8lzU05OurBI-1H1pi4" alt="Animated Cover From Apple Music" /><br />
    <sub><b>Animated Cover From Apple Music</b> — Animated cover on the left</sub>
   </td>
</tr>
</table>

> 💡 The floating player bar at the bottom of the main window (visible in the first two screenshots) shows the current track, its audio quality (e.g. *FLAC · 24-BIT / 44.1 kHz*), playback controls, lyrics, queue and volume.

---

## 📋 Requirements

| Requirement | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org) | **v18 or newer** | Includes `npm` |
| [Git](https://git-scm.com) | Any recent version | To clone the repository |
| [Discord Desktop App](https://discord.com/download) | Latest | Must be **running** for Rich Presence to work |
| Qobuz account | — | Required to access the Qobuz catalogue |

Check your Node.js and npm versions:

```bash
node -v
npm -v
```

---

## 📦 Installation

### 1. Clone the repository

```bash
git clone https://github.com/KissAnotherDay/esposito-desktop.git
cd esposito-desktop
```

### 2. Install all dependencies

```bash
npm install
```

This single command reads `package.json` and installs everything the project needs:

| Package | Type | Purpose |
|---|---|---|
| `electron` (^31) | devDependency | Runs the desktop app |
| `electron-builder` (^24) | devDependency | Builds the `.exe`, `.dmg`, `.AppImage`, `.deb` |
| `cross-env` (^7) | devDependency | Cross-platform environment variables for build scripts |
| `discord-rpc` (^4.0.1) | dependency | Discord Rich Presence integration |

### 3. (Optional) Install packages manually

If you ever need to install the key packages individually — for example after a corrupted `node_modules` folder — use:

```bash
# Electron + build tooling (development dependencies)
npm install --save-dev electron@^31 electron-builder@^24 cross-env@^7

# Discord Rich Presence (runtime dependency)
npm install --save discord-rpc@^4.0.1
```

> 💡 `discord-rpc` is a **runtime** dependency, so it is bundled inside the final executable. Make sure you run `npm install` **before** building, otherwise the Discord feature will not be included in the `.exe`.

---

## ▶️ Running in Development

```bash
npm start
```

This launches the app with Electron (`electron .`) so you can test changes quickly without building an installer.

---

## 🏗️ Building the Executable

Builds are handled by **electron-builder**. Always install the dependencies first (`npm install`), then pick the command for your platform.

### 🪟 Windows (`.exe` installer)

```bash
npm run build:win
```

- Produces an **NSIS installer** for **x64**
- Uses `cross-env CSC_IDENTITY_AUTO_DISCOVERY=false` so the build does not fail when no code-signing certificate is present
- The icon is taken from `build/icon.ico`

### 🍎 macOS (`.dmg` / `.zip`)

```bash
npm run build:mac
```

- Produces a `.dmg` and a `.zip`
- The icon is taken from `build/icon.png`
- Must be built on a Mac

### 🐧 Linux (`.AppImage` / `.deb`)

```bash
npm run build:linux
```

- Produces an `.AppImage` and a `.deb` package
- Category: *Audio*

### 📂 Output

All build artifacts are written to the **`dist/`** folder. On Windows you will find the installer there, named after the product, e.g. `Esposito HI-FI Setup x.x.x.exe`.

### Full quick-build example (Windows)

```bash
git clone https://github.com/KissAnotherDay/esposito-desktop.git
cd esposito-desktop
npm install
npm run build:win
```

Then open the `dist/` folder and run the generated installer.

---

## 💬 Discord Rich Presence

Esposito HI-FI uses [`discord-rpc`](https://www.npmjs.com/package/discord-rpc) to display what you are currently listening to on your Discord profile.

### How to make it work

1. **Install dependencies** with `npm install` (this installs `discord-rpc`).
2. **Open the Discord desktop app** and log in. Rich Presence talks to the local Discord client, so the **browser version of Discord will not work**.
3. **Launch Esposito HI-FI** (`npm start` or the built `.exe`).
4. In Discord, make sure activity sharing is enabled:
   **User Settings → Activity Privacy → Share your detected activity with others** (ON).
5. Start playing a track — it should appear on your profile as your current activity.

### Using your own Discord application (optional)

If you want a custom name or artwork on your presence, you can create your own application:

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Copy the **Application (Client) ID**.
3. Replace the client ID used by the Discord RPC code in the project with yours.
4. Upload artwork under **Rich Presence → Art Assets** and reference the asset keys in the presence payload.

---

## 🗂️ Project Structure

```
esposito-desktop/
├── build/              # App icons used by electron-builder
├── main.js             # Electron main process (windows, app lifecycle, Discord RPC)
├── preload.js          # Secure bridge between main and renderer processes
├── index.html          # Main application window
├── mini.html           # Mini player window
├── style.css           # Application styles
├── app.js              # Core application logic
├── ui.js               # User interface logic
├── player.js           # Audio playback engine
├── api.js              # Qobuz API client
├── lyrics.js           # Lyrics handling
├── tagger.js           # Metadata tagging
├── apple.js            # Apple library helpers
├── apple_import.js     # Apple library import logic
├── hi_res_bdge.jpg     # Hi-Res badge asset
├── package.json        # Dependencies, scripts and electron-builder config
└── package-lock.json   # Locked dependency versions
```

---

## ⚙️ Configuration & Data Storage

- **Settings and queue state** are stored in `localStorage` and persist across sessions inside Electron's user data directory.
- The **API base URL** can be changed in the app's **Settings** panel.
- **Window controls**: custom buttons appear automatically when running inside Electron; on macOS the native traffic-light buttons are used instead.

---

## 🛠️ Troubleshooting

<details>
<summary><b>Discord status does not appear</b></summary>

- Make sure the **Discord desktop app** is open (not the web version).
- Confirm that `discord-rpc` is installed: `npm ls discord-rpc`.
- Check that *Share your detected activity with others* is enabled in Discord settings.
- Restart both Discord and Esposito HI-FI.
</details>

<details>
<summary><b><code>npm install</code> fails or is very slow</b></summary>

- Verify Node.js is v18+ (`node -v`).
- Delete `node_modules` and `package-lock.json`, then run `npm install` again.
- Electron downloads a large binary on first install — check your internet connection or proxy settings.
</details>

<details>
<summary><b>Windows build fails with a code-signing error</b></summary>

Use the provided script (`npm run build:win`) rather than calling `electron-builder` directly — it sets `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing.
</details>

<details>
<summary><b>Windows build fails with a permissions / symlink error</b></summary>

Run your terminal **as Administrator** or enable **Developer Mode** in Windows Settings, then retry the build.
</details>

<details>
<summary><b>The built app starts without Discord support</b></summary>

Delete `dist/` and `node_modules/`, run `npm install`, then rebuild so `discord-rpc` is packaged correctly.
</details>

---

## ⚠️ Disclaimer

This is an **unofficial** project and is **not affiliated with, endorsed by, or sponsored by Qobuz or Discord**. All trademarks belong to their respective owners. A valid Qobuz account is required to use streaming features; please respect Qobuz's Terms of Service and the rights of artists and labels.

---

<p align="center">Made with ❤️ using Electron</p>
