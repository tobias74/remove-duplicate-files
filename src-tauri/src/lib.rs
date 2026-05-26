use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, BufReader, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use tauri::{Emitter, State, Window};

const COMPARE_CHUNK_SIZE: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct CancellationState {
    cancelled: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanIssue {
    scope: String,
    path: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateScanProgress {
    phase: String,
    authoritative_files: usize,
    check_files: usize,
    candidate_files: usize,
    skipped_files: usize,
    compared_check_files: usize,
    compared_pairs: usize,
    duplicates_found: usize,
    issues: usize,
    current_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthoritativeMatch {
    path: String,
    size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateCandidate {
    id: String,
    path: String,
    name: String,
    size: u64,
    last_modified: u64,
    authoritative_path: String,
    authoritative_absolute_path: String,
    authoritative_matches: Vec<AuthoritativeMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateScanResult {
    authoritative_file_count: usize,
    check_file_count: usize,
    candidate_file_count: usize,
    skipped_file_count: usize,
    duplicates: Vec<DuplicateCandidate>,
    issues: Vec<ScanIssue>,
}

#[derive(Clone)]
struct WalkedFile {
    name: String,
    relative_path: String,
    absolute_path: PathBuf,
    size: u64,
    last_modified: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRequest {
    id: String,
    path: String,
    size: u64,
    last_modified: u64,
    authoritative_absolute_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteResult {
    id: String,
    path: String,
    status: String,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteProgress {
    result: DeleteResult,
}

#[tauri::command]
fn cancel_operation(request_id: String, state: State<'_, CancellationState>) -> Result<(), String> {
    let mut cancelled = state
        .cancelled
        .lock()
        .map_err(|_| "Cancellation state is unavailable.".to_string())?;
    cancelled.insert(request_id);
    Ok(())
}

#[tauri::command]
async fn scan_duplicates(
    window: Window,
    state: State<'_, CancellationState>,
    request_id: String,
    authoritative_path: String,
    check_path: String,
) -> Result<DuplicateScanResult, String> {
    let cancellations = state.cancelled.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        scan_duplicates_blocking(
            window,
            cancellations.clone(),
            request_id.clone(),
            authoritative_path,
            check_path,
        )
    })
    .await
    .map_err(|error| error.to_string())?;

    result
}

#[tauri::command]
async fn delete_duplicates(
    window: Window,
    state: State<'_, CancellationState>,
    request_id: String,
    check_path: String,
    verify_before_delete: bool,
    candidates: Vec<DeleteRequest>,
) -> Result<Vec<DeleteResult>, String> {
    let cancellations = state.cancelled.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        delete_duplicates_blocking(
            window,
            cancellations.clone(),
            request_id.clone(),
            check_path,
            verify_before_delete,
            candidates,
        )
    })
    .await
    .map_err(|error| error.to_string())?;

    result
}

fn scan_duplicates_blocking(
    window: Window,
    cancellations: Arc<Mutex<HashSet<String>>>,
    request_id: String,
    authoritative_path: String,
    check_path: String,
) -> Result<DuplicateScanResult, String> {
    let authoritative_root = canonicalize_existing_dir(&authoritative_path)?;
    let check_root = canonicalize_existing_dir(&check_path)?;
    validate_folder_relationship(&authoritative_root, &check_root)?;

    let progress_event = format!("scan-progress-{request_id}");
    let mut issues = Vec::new();
    let mut progress = DuplicateScanProgress {
        phase: "idle".to_string(),
        authoritative_files: 0,
        check_files: 0,
        candidate_files: 0,
        skipped_files: 0,
        compared_check_files: 0,
        compared_pairs: 0,
        duplicates_found: 0,
        issues: 0,
        current_path: None,
    };

    emit_scan_progress(&window, &progress_event, &progress);
    check_cancelled(&cancellations, &request_id)?;

    progress.phase = "walking-authoritative".to_string();
    emit_scan_progress(&window, &progress_event, &progress);
    let authoritative_files = walk_files(
        &authoritative_root,
        "authoritative",
        &mut issues,
        &mut |path, count, issue_count| {
            progress.authoritative_files = count;
            progress.current_path = path;
            progress.issues = issue_count;
            emit_scan_progress(&window, &progress_event, &progress);
            check_cancelled(&cancellations, &request_id)
        },
    )?;

    progress.phase = "walking-check".to_string();
    progress.current_path = None;
    emit_scan_progress(&window, &progress_event, &progress);
    let check_files = walk_files(
        &check_root,
        "check",
        &mut issues,
        &mut |path, count, issue_count| {
            progress.check_files = count;
            progress.current_path = path;
            progress.issues = issue_count;
            emit_scan_progress(&window, &progress_event, &progress);
            check_cancelled(&cancellations, &request_id)
        },
    )?;

    let mut authoritative_by_size: HashMap<u64, Vec<WalkedFile>> = HashMap::new();
    for file in &authoritative_files {
        authoritative_by_size
            .entry(file.size)
            .or_default()
            .push(file.clone());
    }

    let candidate_files: Vec<_> = check_files
        .iter()
        .filter(|file| authoritative_by_size.contains_key(&file.size))
        .cloned()
        .collect();
    let skipped_file_count = check_files.len().saturating_sub(candidate_files.len());
    let mut duplicates = Vec::new();

    progress.phase = "comparing".to_string();
    progress.candidate_files = candidate_files.len();
    progress.skipped_files = skipped_file_count;
    progress.current_path = None;
    emit_scan_progress(&window, &progress_event, &progress);

    for check_file in &candidate_files {
        check_cancelled(&cancellations, &request_id)?;
        let current_check_metadata =
            fs::metadata(&check_file.absolute_path).map_err(|error| error.to_string())?;

        if current_check_metadata.len() != check_file.size {
            issues.push(ScanIssue {
                scope: "check".to_string(),
                path: check_file.relative_path.clone(),
                message: "File changed during scan and was skipped.".to_string(),
            });
            progress.issues = issues.len();
            continue;
        }

        let same_size_authoritative_files = authoritative_by_size
            .get(&check_file.size)
            .cloned()
            .unwrap_or_default();

        for authoritative_file in same_size_authoritative_files {
            check_cancelled(&cancellations, &request_id)?;
            progress.compared_pairs += 1;
            progress.current_path = Some(format!(
                "{} vs {}",
                check_file.relative_path, authoritative_file.relative_path
            ));
            emit_scan_progress(&window, &progress_event, &progress);

            match files_equal(&check_file.absolute_path, &authoritative_file.absolute_path) {
                Ok(true) => {
                    duplicates.push(DuplicateCandidate {
                        id: check_file.relative_path.clone(),
                        path: check_file.relative_path.clone(),
                        name: check_file.name.clone(),
                        size: check_file.size,
                        last_modified: check_file.last_modified,
                        authoritative_path: authoritative_file.relative_path.clone(),
                        authoritative_absolute_path: authoritative_file
                            .absolute_path
                            .to_string_lossy()
                            .to_string(),
                        authoritative_matches: vec![AuthoritativeMatch {
                            path: authoritative_file.relative_path.clone(),
                            size: authoritative_file.size,
                        }],
                    });
                    break;
                }
                Ok(false) => {}
                Err(error) => issues.push(ScanIssue {
                    scope: "authoritative".to_string(),
                    path: authoritative_file.relative_path.clone(),
                    message: error.to_string(),
                }),
            }
        }

        progress.compared_check_files += 1;
        progress.duplicates_found = duplicates.len();
        progress.issues = issues.len();
        progress.current_path = Some(check_file.relative_path.clone());
        emit_scan_progress(&window, &progress_event, &progress);
    }

    progress.phase = "complete".to_string();
    progress.current_path = None;
    progress.duplicates_found = duplicates.len();
    progress.issues = issues.len();
    emit_scan_progress(&window, &progress_event, &progress);
    clear_cancelled(&cancellations, &request_id);

    Ok(DuplicateScanResult {
        authoritative_file_count: authoritative_files.len(),
        check_file_count: check_files.len(),
        candidate_file_count: candidate_files.len(),
        skipped_file_count,
        duplicates,
        issues,
    })
}

fn delete_duplicates_blocking(
    window: Window,
    cancellations: Arc<Mutex<HashSet<String>>>,
    request_id: String,
    check_path: String,
    verify_before_delete: bool,
    candidates: Vec<DeleteRequest>,
) -> Result<Vec<DeleteResult>, String> {
    let check_root = canonicalize_existing_dir(&check_path)?;
    let progress_event = format!("delete-progress-{request_id}");

    let results: Vec<DeleteResult> = candidates
        .par_iter()
        .map(|candidate| {
            let result = if is_cancelled(&cancellations, &request_id) {
                DeleteResult {
                    id: candidate.id.clone(),
                    path: candidate.path.clone(),
                    status: "skipped".to_string(),
                    message: Some("Operation cancelled.".to_string()),
                }
            } else {
                delete_one(&check_root, candidate, verify_before_delete)
            };
            result
        })
        .collect();

    for result in &results {
        let _ = window.emit(
            &progress_event,
            DeleteProgress {
                result: result.clone(),
            },
        );
    }

    clear_cancelled(&cancellations, &request_id);
    Ok(results)
}

fn delete_one(
    check_root: &Path,
    candidate: &DeleteRequest,
    verify_before_delete: bool,
) -> DeleteResult {
    let result = || -> Result<(), String> {
        let candidate_path = safe_join(check_root, &candidate.path)?;
        let metadata = fs::metadata(&candidate_path).map_err(|error| error.to_string())?;

        if metadata.len() != candidate.size {
            return Err("File size changed since scan.".to_string());
        }

        if !verify_before_delete && modified_ms(&metadata) != candidate.last_modified {
            return Err("File metadata changed since scan.".to_string());
        }

        if verify_before_delete {
            let Some(authoritative_absolute_path) = &candidate.authoritative_absolute_path else {
                return Err("Authoritative file path is unavailable.".to_string());
            };
            let authoritative_path = PathBuf::from(authoritative_absolute_path);

            if !files_equal(&candidate_path, &authoritative_path)
                .map_err(|error| error.to_string())?
            {
                return Err("File contents changed since scan.".to_string());
            }
        }

        fs::remove_file(candidate_path).map_err(|error| error.to_string())?;
        Ok(())
    };

    match result() {
        Ok(()) => DeleteResult {
            id: candidate.id.clone(),
            path: candidate.path.clone(),
            status: "deleted".to_string(),
            message: None,
        },
        Err(message) if message.contains("changed") || message.contains("unavailable") => {
            DeleteResult {
                id: candidate.id.clone(),
                path: candidate.path.clone(),
                status: "skipped".to_string(),
                message: Some(message),
            }
        }
        Err(message) => DeleteResult {
            id: candidate.id.clone(),
            path: candidate.path.clone(),
            status: "failed".to_string(),
            message: Some(message),
        },
    }
}

fn walk_files<F>(
    root: &Path,
    scope: &str,
    issues: &mut Vec<ScanIssue>,
    on_progress: &mut F,
) -> Result<Vec<WalkedFile>, String>
where
    F: FnMut(Option<String>, usize, usize) -> Result<(), String>,
{
    let mut files = Vec::new();
    let mut directories = vec![root.to_path_buf()];

    while let Some(directory) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                issues.push(ScanIssue {
                    scope: scope.to_string(),
                    path: relative_display(root, &directory),
                    message: error.to_string(),
                });
                continue;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    issues.push(ScanIssue {
                        scope: scope.to_string(),
                        path: relative_display(root, &directory),
                        message: error.to_string(),
                    });
                    continue;
                }
            };

            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    issues.push(ScanIssue {
                        scope: scope.to_string(),
                        path: relative_display(root, &path),
                        message: error.to_string(),
                    });
                    continue;
                }
            };

            if metadata.is_dir() {
                directories.push(path);
            } else if metadata.is_file() {
                let relative_path = relative_display(root, &path);
                files.push(WalkedFile {
                    name: entry.file_name().to_string_lossy().to_string(),
                    relative_path: relative_path.clone(),
                    absolute_path: path,
                    size: metadata.len(),
                    last_modified: modified_ms(&metadata),
                });
                on_progress(Some(relative_path), files.len(), issues.len())?;
            }
        }
    }

    Ok(files)
}

fn files_equal(left_path: &Path, right_path: &Path) -> io::Result<bool> {
    let left_metadata = fs::metadata(left_path)?;
    let right_metadata = fs::metadata(right_path)?;

    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }

    let mut left_reader = BufReader::with_capacity(COMPARE_CHUNK_SIZE, File::open(left_path)?);
    let mut right_reader = BufReader::with_capacity(COMPARE_CHUNK_SIZE, File::open(right_path)?);
    let mut left_buffer = vec![0_u8; COMPARE_CHUNK_SIZE];
    let mut right_buffer = vec![0_u8; COMPARE_CHUNK_SIZE];

    loop {
        let left_read = left_reader.read(&mut left_buffer)?;
        let right_read = right_reader.read(&mut right_buffer)?;

        if left_read != right_read {
            return Ok(false);
        }

        if left_read == 0 {
            return Ok(true);
        }

        if left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
    }
}

fn canonicalize_existing_dir(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;

    if !canonical.is_dir() {
        return Err("Selected path is not a directory.".to_string());
    }

    Ok(canonical)
}

fn validate_folder_relationship(authoritative: &Path, check: &Path) -> Result<(), String> {
    if authoritative == check {
        return Err("Choose two different folders before scanning.".to_string());
    }

    if check.starts_with(authoritative) {
        return Err("The folder to check is inside the authoritative folder. Choose separate folders to avoid deleting protected content.".to_string());
    }

    if authoritative.starts_with(check) {
        return Err("The authoritative folder is inside the folder to check. Choose separate folders to keep authoritative files protected.".to_string());
    }

    Ok(())
}

fn safe_join(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative_path);
    let parent = candidate
        .parent()
        .ok_or_else(|| "Invalid file path.".to_string())?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| "Invalid file path.".to_string())?;
    let absolute = parent.join(file_name);

    if !absolute.starts_with(root) {
        return Err("Refusing to delete outside the selected folder.".to_string());
    }

    Ok(absolute)
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_scan_progress(window: &Window, event: &str, progress: &DuplicateScanProgress) {
    let _ = window.emit(event, progress.clone());
}

fn check_cancelled(
    cancellations: &Arc<Mutex<HashSet<String>>>,
    request_id: &str,
) -> Result<(), String> {
    if is_cancelled(cancellations, request_id) {
        return Err("Operation cancelled.".to_string());
    }

    Ok(())
}

fn is_cancelled(cancellations: &Arc<Mutex<HashSet<String>>>, request_id: &str) -> bool {
    cancellations
        .lock()
        .map(|cancelled| cancelled.contains(request_id))
        .unwrap_or(false)
}

fn clear_cancelled(cancellations: &Arc<Mutex<HashSet<String>>>, request_id: &str) {
    if let Ok(mut cancelled) = cancellations.lock() {
        cancelled.remove(request_id);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    apply_linux_webkit_workarounds();

    tauri::Builder::default()
        .manage(CancellationState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            cancel_operation,
            scan_duplicates,
            delete_duplicates
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(target_os = "linux")]
fn apply_linux_webkit_workarounds() {
    if std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSL_INTEROP").is_some() {
        set_default_env("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        set_default_env("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_linux_webkit_workarounds() {}

#[cfg(target_os = "linux")]
fn set_default_env(key: &str, value: &str) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}
