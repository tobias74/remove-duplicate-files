import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  RefreshCcw,
  ScanSearch,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useReducer, useRef, useState } from 'react';
import {
  describeUnsafeRelationship,
  getDirectoryRelationship,
  isAbortError,
  isFileSystemAccessSupported,
  pickDirectory,
  requestDirectoryPermission,
  toErrorMessage,
} from './lib/fileSystem';
import type { LocalDirectoryHandle } from './lib/fileSystemTypes';
import { deleteDuplicateFiles, type DeleteResult } from './lib/deleteDuplicates';
import { formatBytes, pluralize } from './lib/format';
import {
  scanForDuplicates,
  type DuplicateCandidate,
  type DuplicateScanProgress,
  type DuplicateScanResult,
  type ScanIssue,
} from './lib/scanner';

type FolderRole = 'authoritative' | 'check';
type AppStatus = 'idle' | 'scanning' | 'scan-complete' | 'deleting';

interface FolderChoice {
  name: string;
  handle: LocalDirectoryHandle;
}

interface AppState {
  authoritativeFolder?: FolderChoice;
  checkFolder?: FolderChoice;
  status: AppStatus;
  progress?: DuplicateScanProgress;
  scanResult?: DuplicateScanResult;
  duplicates: DuplicateCandidate[];
  selectedIds: Set<string>;
  issues: ScanIssue[];
  deletionResults: Record<string, DeleteResult>;
  confirmOpen: boolean;
  error?: string;
}

type AppAction =
  | { type: 'folder-selected'; role: FolderRole; folder: FolderChoice }
  | { type: 'operation-error'; message: string }
  | { type: 'scan-started' }
  | { type: 'scan-progress'; progress: DuplicateScanProgress }
  | { type: 'scan-succeeded'; result: DuplicateScanResult }
  | { type: 'scan-cancelled' }
  | { type: 'toggle-selected'; id: string }
  | { type: 'select-all'; ids: string[] }
  | { type: 'clear-selection' }
  | { type: 'open-confirm' }
  | { type: 'close-confirm' }
  | { type: 'delete-started' }
  | { type: 'delete-progress'; result: DeleteResult }
  | { type: 'delete-finished'; results: DeleteResult[] };

const initialState: AppState = {
  status: 'idle',
  duplicates: [],
  selectedIds: new Set(),
  issues: [],
  deletionResults: {},
  confirmOpen: false,
};

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [confirmAcknowledged, setConfirmAcknowledged] = useState(false);
  const scanAbortRef = useRef<AbortController | null>(null);
  const supported = isFileSystemAccessSupported();

  const selectableDuplicateIds = useMemo(
    () =>
      state.duplicates
        .filter((candidate) => state.deletionResults[candidate.id]?.status !== 'deleted')
        .map((candidate) => candidate.id),
    [state.deletionResults, state.duplicates],
  );

  const selectedCandidates = useMemo(
    () =>
      state.duplicates.filter(
        (candidate) =>
          state.selectedIds.has(candidate.id) &&
          state.deletionResults[candidate.id]?.status !== 'deleted',
      ),
    [state.deletionResults, state.duplicates, state.selectedIds],
  );

  const selectedBytes = selectedCandidates.reduce(
    (total, candidate) => total + candidate.size,
    0,
  );

  const deletionSummary = useMemo(() => {
    const results = Object.values(state.deletionResults);

    return {
      deleted: results.filter((result) => result.status === 'deleted').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      failed: results.filter((result) => result.status === 'failed').length,
    };
  }, [state.deletionResults]);

  const allSelectableSelected =
    selectableDuplicateIds.length > 0 &&
    selectableDuplicateIds.every((id) => state.selectedIds.has(id));

  const canScan =
    supported &&
    state.authoritativeFolder &&
    state.checkFolder &&
    state.status !== 'scanning' &&
    state.status !== 'deleting';

  const handlePickFolder = async (role: FolderRole) => {
    try {
      const handle = await pickDirectory(
        role === 'authoritative' ? 'authoritative-folder' : 'check-folder',
        'read',
      );

      dispatch({
        type: 'folder-selected',
        role,
        folder: {
          name: handle.name,
          handle,
        },
      });
    } catch (error) {
      if (!isAbortError(error)) {
        dispatch({ type: 'operation-error', message: toErrorMessage(error) });
      }
    }
  };

  const handleScan = async () => {
    if (!state.authoritativeFolder || !state.checkFolder) {
      return;
    }

    const abortController = new AbortController();
    scanAbortRef.current = abortController;
    dispatch({ type: 'scan-started' });

    try {
      const relationship = await getDirectoryRelationship(
        state.authoritativeFolder.handle,
        state.checkFolder.handle,
      );
      const unsafeMessage = describeUnsafeRelationship(relationship);

      if (unsafeMessage) {
        dispatch({ type: 'operation-error', message: unsafeMessage });
        return;
      }

      const result = await scanForDuplicates(
        state.authoritativeFolder.handle,
        state.checkFolder.handle,
        {
          signal: abortController.signal,
          hashConcurrency: 2,
          onProgress: (progress) =>
            dispatch({ type: 'scan-progress', progress }),
        },
      );

      dispatch({ type: 'scan-succeeded', result });
    } catch (error) {
      if (isAbortError(error)) {
        dispatch({ type: 'scan-cancelled' });
      } else {
        dispatch({ type: 'operation-error', message: toErrorMessage(error) });
      }
    } finally {
      scanAbortRef.current = null;
    }
  };

  const handleCancelScan = () => {
    scanAbortRef.current?.abort();
  };

  const handleConfirmDelete = async () => {
    if (!state.checkFolder || selectedCandidates.length === 0) {
      return;
    }

    const candidatesToDelete = selectedCandidates;
    dispatch({ type: 'close-confirm' });
    dispatch({ type: 'delete-started' });

    try {
      const permission = await requestDirectoryPermission(
        state.checkFolder.handle,
        'readwrite',
      );

      if (permission !== 'granted') {
        throw new Error('Read/write permission was not granted for the folder to check.');
      }

      const results = await deleteDuplicateFiles(candidatesToDelete, {
        onProgress: ({ result }) =>
          dispatch({ type: 'delete-progress', result }),
      });

      dispatch({ type: 'delete-finished', results });
    } catch (error) {
      dispatch({ type: 'operation-error', message: toErrorMessage(error) });
    } finally {
      setConfirmAcknowledged(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local only</p>
          <h1>Duplicate Remover</h1>
        </div>
        <div className="trust-chip">
          <ShieldCheck aria-hidden="true" size={18} />
          <span>No uploads</span>
        </div>
      </header>

      <main className="workspace">
        {!supported && (
          <section className="notice notice-danger" role="alert">
            <AlertTriangle aria-hidden="true" size={18} />
            <span>
              This app requires a Chromium desktop browser with local folder access.
            </span>
          </section>
        )}

        <section className="picker-grid" aria-label="Folder selection">
          <FolderPicker
            title="Authoritative folder"
            description="Protected source"
            folder={state.authoritativeFolder}
            disabled={!supported || state.status === 'scanning' || state.status === 'deleting'}
            onPick={() => handlePickFolder('authoritative')}
          />
          <FolderPicker
            title="Folder to check"
            description="Duplicates can be removed here"
            folder={state.checkFolder}
            disabled={!supported || state.status === 'scanning' || state.status === 'deleting'}
            onPick={() => handlePickFolder('check')}
          />
        </section>

        <section className="command-row" aria-label="Scan controls">
          <button
            className="button button-primary"
            type="button"
            disabled={!canScan}
            onClick={handleScan}
          >
            <ScanSearch aria-hidden="true" size={18} />
            <span>Scan</span>
          </button>
          {state.status === 'scanning' && (
            <button className="button" type="button" onClick={handleCancelScan}>
              <X aria-hidden="true" size={18} />
              <span>Cancel</span>
            </button>
          )}
          <button
            className="button button-danger"
            type="button"
            disabled={
              selectedCandidates.length === 0 ||
              state.status === 'scanning' ||
              state.status === 'deleting'
            }
            onClick={() => dispatch({ type: 'open-confirm' })}
          >
            <Trash2 aria-hidden="true" size={18} />
            <span>Delete selected</span>
          </button>
        </section>

        {state.error && (
          <section className="notice notice-danger" role="alert">
            <AlertTriangle aria-hidden="true" size={18} />
            <span>{state.error}</span>
          </section>
        )}

        <SummaryPanel
          scanResult={state.scanResult}
          progress={state.progress}
          duplicateCount={state.duplicates.length}
          selectedCount={selectedCandidates.length}
          selectedBytes={selectedBytes}
          deletionSummary={deletionSummary}
          status={state.status}
        />

        {state.status === 'scanning' && state.progress && (
          <ProgressPanel progress={state.progress} />
        )}

        <section className="results-panel" aria-label="Duplicate results">
          <div className="results-heading">
            <div>
              <h2>Duplicate candidates</h2>
              <p>{pluralize(state.duplicates.length, 'match')} found</p>
            </div>
            <div className="table-actions">
              <button
                className="button button-quiet"
                type="button"
                disabled={selectableDuplicateIds.length === 0}
                onClick={() =>
                  allSelectableSelected
                    ? dispatch({ type: 'clear-selection' })
                    : dispatch({ type: 'select-all', ids: selectableDuplicateIds })
                }
              >
                <CheckCircle2 aria-hidden="true" size={17} />
                <span>{allSelectableSelected ? 'Clear' : 'Select all'}</span>
              </button>
            </div>
          </div>

          {state.duplicates.length > 0 ? (
            <DuplicateTable
              duplicates={state.duplicates}
              selectedIds={state.selectedIds}
              deletionResults={state.deletionResults}
              allSelected={allSelectableSelected}
              onToggle={(id) => dispatch({ type: 'toggle-selected', id })}
              onToggleAll={() =>
                allSelectableSelected
                  ? dispatch({ type: 'clear-selection' })
                  : dispatch({ type: 'select-all', ids: selectableDuplicateIds })
              }
            />
          ) : (
            <div className="empty-state">
              {state.status === 'scan-complete'
                ? 'No duplicates were found.'
                : 'Scan results will appear here.'}
            </div>
          )}
        </section>

        {state.issues.length > 0 && (
          <details className="issues-panel">
            <summary>{pluralize(state.issues.length, 'scan issue')}</summary>
            <ul>
              {state.issues.map((issue, index) => (
                <li key={`${issue.scope}-${issue.path}-${index}`}>
                  <strong>{issue.scope}</strong>
                  <span>{issue.path}</span>
                  <em>{issue.message}</em>
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>

      {state.confirmOpen && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <div className="confirm-icon">
              <Trash2 aria-hidden="true" size={24} />
            </div>
            <h2 id="confirm-title">Delete selected files</h2>
            <p>
              {pluralize(selectedCandidates.length, 'file')} totaling{' '}
              {formatBytes(selectedBytes)} will be permanently removed from the
              folder to check.
            </p>
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={confirmAcknowledged}
                onChange={(event) =>
                  setConfirmAcknowledged(event.currentTarget.checked)
                }
              />
              <span>I understand this deletion is permanent.</span>
            </label>
            <div className="confirm-actions">
              <button
                className="button"
                type="button"
                onClick={() => dispatch({ type: 'close-confirm' })}
              >
                <X aria-hidden="true" size={18} />
                <span>Cancel</span>
              </button>
              <button
                className="button button-danger"
                type="button"
                disabled={!confirmAcknowledged}
                onClick={handleConfirmDelete}
              >
                <Trash2 aria-hidden="true" size={18} />
                <span>Delete files</span>
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'folder-selected': {
      return {
        ...state,
        [action.role === 'authoritative'
          ? 'authoritativeFolder'
          : 'checkFolder']: action.folder,
        status: 'idle',
        progress: undefined,
        scanResult: undefined,
        duplicates: [],
        selectedIds: new Set(),
        issues: [],
        deletionResults: {},
        error: undefined,
      };
    }
    case 'operation-error':
      return {
        ...state,
        status: state.status === 'deleting' ? 'scan-complete' : 'idle',
        error: action.message,
      };
    case 'scan-started':
      return {
        ...state,
        status: 'scanning',
        progress: undefined,
        scanResult: undefined,
        duplicates: [],
        selectedIds: new Set(),
        issues: [],
        deletionResults: {},
        error: undefined,
      };
    case 'scan-progress':
      return {
        ...state,
        progress: action.progress,
      };
    case 'scan-succeeded':
      return {
        ...state,
        status: 'scan-complete',
        progress: undefined,
        scanResult: action.result,
        duplicates: action.result.duplicates,
        selectedIds: new Set(action.result.duplicates.map((duplicate) => duplicate.id)),
        issues: action.result.issues,
        error: undefined,
      };
    case 'scan-cancelled':
      return {
        ...state,
        status: 'idle',
        progress: undefined,
        error: 'Scan cancelled.',
      };
    case 'toggle-selected': {
      const selectedIds = new Set(state.selectedIds);

      if (selectedIds.has(action.id)) {
        selectedIds.delete(action.id);
      } else {
        selectedIds.add(action.id);
      }

      return { ...state, selectedIds };
    }
    case 'select-all':
      return {
        ...state,
        selectedIds: new Set(action.ids),
      };
    case 'clear-selection':
      return {
        ...state,
        selectedIds: new Set(),
      };
    case 'open-confirm':
      return {
        ...state,
        confirmOpen: true,
      };
    case 'close-confirm':
      return {
        ...state,
        confirmOpen: false,
      };
    case 'delete-started':
      return {
        ...state,
        status: 'deleting',
        confirmOpen: false,
        error: undefined,
      };
    case 'delete-progress': {
      const selectedIds = new Set(state.selectedIds);
      selectedIds.delete(action.result.id);

      return {
        ...state,
        selectedIds,
        deletionResults: {
          ...state.deletionResults,
          [action.result.id]: action.result,
        },
      };
    }
    case 'delete-finished': {
      const deletionResults = { ...state.deletionResults };

      for (const result of action.results) {
        deletionResults[result.id] = result;
      }

      return {
        ...state,
        status: 'scan-complete',
        deletionResults,
      };
    }
    default:
      return state;
  }
}

function FolderPicker({
  title,
  description,
  folder,
  disabled,
  onPick,
}: {
  title: string;
  description: string;
  folder?: FolderChoice;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <article className="folder-picker">
      <div className="folder-meta">
        <p>{description}</p>
        <h2>{title}</h2>
        <strong title={folder?.name}>{folder?.name ?? 'No folder selected'}</strong>
      </div>
      <button className="button" type="button" disabled={disabled} onClick={onPick}>
        <FolderOpen aria-hidden="true" size={18} />
        <span>Choose</span>
      </button>
    </article>
  );
}

function SummaryPanel({
  scanResult,
  progress,
  duplicateCount,
  selectedCount,
  selectedBytes,
  deletionSummary,
  status,
}: {
  scanResult?: DuplicateScanResult;
  progress?: DuplicateScanProgress;
  duplicateCount: number;
  selectedCount: number;
  selectedBytes: number;
  deletionSummary: {
    deleted: number;
    skipped: number;
    failed: number;
  };
  status: AppStatus;
}) {
  const authoritativeFiles =
    scanResult?.authoritativeFileCount ?? progress?.authoritativeFiles ?? 0;
  const checkFiles = scanResult?.checkFileCount ?? progress?.checkFiles ?? 0;
  const candidateFiles =
    scanResult?.candidateFileCount ?? progress?.candidateFiles ?? 0;
  const skippedFiles =
    scanResult?.skippedFileCount ?? progress?.skippedFiles ?? 0;

  return (
    <section className="summary-grid" aria-label="Scan summary">
      <SummaryItem label="Authoritative" value={authoritativeFiles} />
      <SummaryItem label="Checked" value={checkFiles} />
      <SummaryItem label="Candidates" value={candidateFiles} />
      <SummaryItem label="Size skipped" value={skippedFiles} />
      <SummaryItem label="Duplicates" value={duplicateCount} />
      <SummaryItem
        label="Selected"
        value={selectedCount}
        detail={formatBytes(selectedBytes)}
      />
      <SummaryItem label="Deleted" value={deletionSummary.deleted} />
      <SummaryItem
        label="Skipped / failed"
        value={deletionSummary.skipped + deletionSummary.failed}
        tone={deletionSummary.failed > 0 ? 'danger' : 'neutral'}
      />
      {status === 'deleting' && (
        <div className="summary-live">
          <Loader2 aria-hidden="true" size={18} />
          <span>Deleting</span>
        </div>
      )}
    </section>
  );
}

function SummaryItem({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  detail?: string;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div className={`summary-item summary-${tone}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
      {detail && <em>{detail}</em>}
    </div>
  );
}

function ProgressPanel({ progress }: { progress: DuplicateScanProgress }) {
  const phaseLabels: Record<DuplicateScanProgress['phase'], string> = {
    idle: 'Ready',
    'walking-authoritative': 'Reading authoritative folder',
    'walking-check': 'Reading folder to check',
    'hashing-authoritative': 'Hashing authoritative files',
    'hashing-check': 'Hashing files to check',
    complete: 'Complete',
  };

  return (
    <section className="progress-panel" aria-live="polite">
      <div>
        <Loader2 className="spin" aria-hidden="true" size={18} />
        <strong>{phaseLabels[progress.phase]}</strong>
      </div>
      {progress.currentPath && <span title={progress.currentPath}>{progress.currentPath}</span>}
      <div className="progress-track">
        <div className="progress-bar" />
      </div>
    </section>
  );
}

function DuplicateTable({
  duplicates,
  selectedIds,
  deletionResults,
  allSelected,
  onToggle,
  onToggleAll,
}: {
  duplicates: DuplicateCandidate[];
  selectedIds: Set<string>;
  deletionResults: Record<string, DeleteResult>;
  allSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="check-cell">
              <input
                type="checkbox"
                aria-label="Select all duplicate candidates"
                checked={allSelected}
                onChange={onToggleAll}
              />
            </th>
            <th>File to remove</th>
            <th>Size</th>
            <th>Authoritative match</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {duplicates.map((duplicate) => {
            const result = deletionResults[duplicate.id];
            const rowDisabled = result?.status === 'deleted';

            return (
              <tr key={duplicate.id} className={rowDisabled ? 'row-muted' : undefined}>
                <td className="check-cell">
                  <input
                    type="checkbox"
                    aria-label={`Select ${duplicate.path}`}
                    checked={selectedIds.has(duplicate.id)}
                    disabled={rowDisabled}
                    onChange={() => onToggle(duplicate.id)}
                  />
                </td>
                <td>
                  <span className="path-text" title={duplicate.path}>
                    {duplicate.path}
                  </span>
                </td>
                <td>{formatBytes(duplicate.size)}</td>
                <td>
                  <span className="path-text" title={duplicate.authoritativePath}>
                    {duplicate.authoritativePath}
                  </span>
                  {duplicate.authoritativeMatches.length > 1 && (
                    <em className="match-count">
                      +{duplicate.authoritativeMatches.length - 1}
                    </em>
                  )}
                </td>
                <td>
                  <StatusPill result={result} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ result }: { result?: DeleteResult }) {
  if (!result) {
    return <span className="status-pill status-ready">Ready</span>;
  }

  if (result.status === 'deleted') {
    return <span className="status-pill status-deleted">Deleted</span>;
  }

  if (result.status === 'skipped') {
    return (
      <span className="status-pill status-skipped" title={result.message}>
        Skipped
      </span>
    );
  }

  return (
    <span className="status-pill status-failed" title={result.message}>
      Failed
    </span>
  );
}

