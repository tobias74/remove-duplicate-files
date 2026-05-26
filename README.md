# Duplicate Remover

A frontend-only React/Vite app for finding files in one local folder that already exist by content in another local folder.

## Requirements

- A Chromium desktop browser with the File System Access API, such as Chrome, Edge, Brave, or Opera.
- A secure context. Vite's local development server qualifies.
- Node.js available inside the shell where you run npm. In WSL, install Linux Node rather than using Windows npm through a UNC path.

## Commands

```sh
npm install
npm run dev
npm test
npm run build
```

The app never uploads file contents. It requests read/write permission only for the folder being checked, and only when deleting reviewed duplicate files.
