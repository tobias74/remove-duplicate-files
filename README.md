# Duplicate Remover

A React/Vite duplicate-file remover that can run as a browser app or as a Tauri desktop app with a native filesystem backend.

## Requirements

- Browser mode: a Chromium desktop browser with the File System Access API, such as Chrome, Edge, Brave, or Opera.
- Tauri mode: Rust, Cargo, and the platform-specific Tauri build dependencies.
- Node.js available inside the shell where you run npm. In WSL, install Linux Node rather than using Windows npm through a UNC path.

On Ubuntu/WSL, Tauri native checks/builds also need development packages:

```sh
sudo apt install libdbus-1-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

## Commands

```sh
npm install
npm run dev
npm test
npm run build
npm run tauri:dev
npm run tauri:build
```

The app never uploads file contents. It requests read/write permission only for the folder being checked, and only when deleting reviewed duplicate files.

Duplicate detection compares files exactly in chunks after filtering by byte size. Browser mode runs chunk comparison through a small Web Worker pool. Tauri mode uses native Rust filesystem traversal, chunk comparison, and parallel deletion. The delete step defaults to a faster metadata re-check; enable the verification checkbox before deletion to compare bytes again for extra safety.
