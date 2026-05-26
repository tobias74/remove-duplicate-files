# Remove Duplicate Files

Remove Duplicate Files is a local-first duplicate cleanup app. It lets you choose one folder as the protected authoritative source and a second folder as the folder to check. The app scans both folder trees recursively, finds files in the check folder whose bytes already exist somewhere in the authoritative folder, and lets you review and delete only those selected duplicates.

The same React/Vite interface can run in two modes:

- Browser mode: runs in Chromium desktop browsers using the File System Access API.
- Tauri native mode: wraps the React app in a desktop shell and uses a native Rust filesystem backend for faster scanning and deletion.

No file contents are uploaded. There is no backend service. All scanning and deletion happens on the local machine.

## Safety Model

- The authoritative folder is treated as protected source material.
- The app never deletes from the authoritative folder.
- Deletion is only available for files found in the folder to check.
- You must review duplicate candidates and explicitly confirm before deletion.
- Browser and Tauri filesystem deletion is permanent for this app. Do not assume files will go to the OS trash or recycle bin.
- The app blocks same-folder selection and overlapping authoritative/check folders when it can detect that relationship.
- Before deletion, the app re-checks file metadata. You can enable the verification checkbox to compare bytes again before each selected file is removed.

## How Duplicate Detection Works

Duplicate identity is based on file content, not filename or path.

The scanner works in this order:

1. Walk the authoritative folder recursively and collect file metadata.
2. Walk the folder to check recursively and collect file metadata.
3. Group authoritative files by byte size.
4. Skip check-folder files whose size does not exist in the authoritative folder.
5. For same-size candidates, compare bytes in chunks.
6. Mark a check-folder file as removable when its bytes match any authoritative file.

This means a file named `photo-copy.jpg` in the check folder can match `archive/2022/original.jpg` in the authoritative folder if the contents are identical.

The authoritative folder may contain duplicates within itself. This app intentionally ignores that case; it only answers whether files in the check folder already exist in the authoritative folder.

## Features

- Two-folder workflow: authoritative folder plus folder to check.
- Recursive scanning of nested folders.
- Exact byte comparison after fast size filtering.
- Browser worker pool for byte comparisons in browser mode.
- Native Rust scanner and parallel native deletion in Tauri mode.
- Scan progress, issue reporting, and cancellation.
- Review table with paths, sizes, matching authoritative paths, status, and selection checkboxes.
- Summary counts for scanned files, candidates, skipped files, duplicates, selected bytes, deleted files, skipped deletes, and failures.
- Optional byte verification immediately before deletion.
- Local-only operation with no upload path.

## Requirements

### Browser Mode

- A Chromium desktop browser with the File System Access API, such as Chrome, Edge, Brave, or Opera.
- Firefox and Safari do not currently provide the same folder read/write APIs needed for this browser workflow.

### Tauri Native Mode

- Node.js and npm.
- Rust and Cargo.
- Platform-specific native build tools for Tauri.

Windows requirements:

- Node.js LTS or newer.
- Rust installed through `rustup`.
- Microsoft Visual Studio Build Tools or Visual Studio with the `Desktop development with C++` workload.
- Microsoft Edge WebView2 Runtime. It is usually already present on modern Windows 10/11 systems.

Ubuntu/WSL requirements:

```sh
sudo apt install libdbus-1-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

WSL note: use Linux Node.js inside WSL for WSL/Linux builds. Avoid using Windows npm through a UNC path for Linux builds.

## Repository Layout

```text
.
|-- src/                         React app, browser implementation, tests, workers
|   |-- lib/                     Scanner, byte comparison, deletion, filesystem helpers
|   |-- services/                Runtime switch between browser and Tauri services
|   `-- workers/                 Browser byte-comparison worker
|-- src-tauri/                   Tauri app and native Rust backend
|   |-- src/lib.rs               Native scan/delete commands
|   |-- icons/                   App icons
|   `-- tauri.conf.json          Tauri app config
|-- package.json                 npm scripts and frontend dependencies
|-- README.md
`-- LICENSE
```

## Fresh Setup

Clone the repository:

```sh
git clone https://github.com/tobias74/remove-duplicate-files.git
cd remove-duplicate-files
```

Install JavaScript dependencies:

```sh
npm install
```

Run tests:

```sh
npm test
```

Build the browser frontend:

```sh
npm run build
```

## Development Commands

Run the browser app with Vite:

```sh
npm run dev
```

Open the printed local URL in a Chromium desktop browser.

Run the Tauri app in development mode:

```sh
npm run tauri:dev
```

Build the Tauri app:

```sh
npm run tauri:build
```

The Tauri build runs the frontend build first, then compiles the native app.

## Building on Windows

Use a Windows checkout for Windows builds. This keeps Windows `node_modules` and Windows Rust build output separate from WSL/Linux builds.

Example Windows checkout:

```powershell
cd $env:USERPROFILE\projects
git clone https://github.com/tobias74/remove-duplicate-files.git remove-duplicate-files
cd remove-duplicate-files
npm.cmd ci
```

Build the Windows executable:

```powershell
$env:CARGO_TARGET_DIR = "$PWD\src-tauri\target-windows"
npm.cmd run tauri:build
```

The raw executable is created at:

```text
src-tauri\target-windows\release\remove-duplicate-files.exe
```

From WSL, you can drive the Windows checkout like this:

```sh
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '
  $repo = "$env:USERPROFILE\projects\remove-duplicate-files"
  Set-Location -LiteralPath $repo
  git pull --ff-only origin master
  $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
  $env:CARGO_TARGET_DIR = "$repo\src-tauri\target-windows"
  npm.cmd run tauri:build
'
```

The project currently has Tauri bundling disabled, so the build produces a raw `.exe` rather than an installer. To create MSI or NSIS installers later, enable `bundle.active` in `src-tauri/tauri.conf.json` and configure the desired bundle target.

## Building on WSL or Linux

Install the Ubuntu/WSL native dependencies listed above, then run:

```sh
npm install
npm test
npm run build
npm run tauri:build
```

The Linux executable is created at:

```text
src-tauri/target/release/remove-duplicate-files
```

Run it:

```sh
src-tauri/target/release/remove-duplicate-files
```

If a WSLg/WebKitGTK window appears blank, try forcing X11:

```sh
GDK_BACKEND=x11 src-tauri/target/release/remove-duplicate-files
```

The app also applies WSL WebKit rendering workarounds automatically when it detects WSL.

## Using the App

1. Choose the authoritative folder. This is the protected source folder.
2. Choose the folder to check. This is the only folder where selected files can be removed.
3. Click `Scan`.
4. Review duplicate candidates in the table.
5. Select the files you want to remove.
6. Optionally enable `Verify bytes again before deletion` for the most cautious delete path.
7. Click `Delete selected`.
8. Confirm the deletion dialog.

After deletion, the table records which files were deleted, skipped, or failed.

## Browser vs Tauri Mode

Browser mode is convenient because it can be served as a normal website and still work locally in Chromium. It uses the File System Access API and browser workers for comparisons.

Tauri mode is better for larger folders and repeated use. The UI stays React/Vite, but scanning and deletion run through native Rust commands. This avoids some browser filesystem overhead and allows faster native deletion.

## Testing

Run the unit test suite:

```sh
npm test
```

Run a production frontend build:

```sh
npm run build
```

Run a native build:

```sh
npm run tauri:build
```

The tests cover recursive walking, byte comparison, scanner behavior, safety guards, duplicate deletion, and changed-file handling. Native folder picker dialogs are not reliably automatable, so final end-to-end validation should be done manually with small fixture folders.

Manual smoke test:

1. Create an authoritative folder with a few files.
2. Create a check folder containing one identical copy, one same-name different-content file, and one unique file.
3. Scan.
4. Confirm only the identical copy is listed as a duplicate.
5. Delete the selected duplicate.
6. Confirm the authoritative folder is unchanged.

## Keeping the WSL and Windows Checkouts in Sync

This project may be built from both:

- WSL/Linux checkout: `/home/tobias/projects/remove-duplicates`
- Windows checkout: `C:\Users\tobia\projects\remove-duplicate-files`

Recommended workflow:

```sh
git pull --ff-only origin master
# make changes
npm test
npm run build
git add .
git commit -m "Describe the change"
git push origin master
```

Then update the Windows checkout:

```sh
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '
  $repo = "$env:USERPROFILE\projects\remove-duplicate-files"
  Set-Location -LiteralPath $repo
  git pull --ff-only origin master
'
```

Keep each checkout's generated folders local:

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- `src-tauri/target-windows/`

## Troubleshooting

### The Browser Says Local Folder Access Is Unsupported

Use a Chromium desktop browser. Browser mode depends on `showDirectoryPicker` and related File System Access APIs.

### Windows `npm` Is Blocked by PowerShell Policy

Use `npm.cmd` instead of `npm`:

```powershell
npm.cmd install
npm.cmd run tauri:build
```

### Windows Build Cannot Find Rust

Install Rust with `rustup`, then make sure Cargo is on PATH:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo --version
```

### Windows Build Cannot Find C++ Tools

Install Visual Studio Build Tools or Visual Studio Community and include the `Desktop development with C++` workload.

### Tauri Builds a Console-Looking Executable

The current config creates a raw executable and has installer bundling disabled. That is expected for now.

### Scanning Large Folders Takes Time

The scanner skips files with unique sizes quickly, but exact duplicate candidates require reading bytes. Tauri native mode should be preferred for large folders.

### Deletion Feels Slow in Browser Mode

Browser deletion goes through browser-mediated filesystem APIs. Tauri native mode is expected to perform better for bulk deletion.

## Privacy

The app does not upload files or metadata. Browser mode and Tauri mode both operate locally. The only network access used during development/build is normal dependency installation through npm, Cargo, and system package managers.

## License

MIT. See [LICENSE](LICENSE).
