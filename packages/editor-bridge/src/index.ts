import { errorDefinitions } from '@drawio-cloud/api-contract';
import type { ErrorCode, SaveFileRequest, SaveFileResponse, LeaseCredentials } from '@drawio-cloud/api-contract';

export interface BridgeClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
// The host binds file identity and HTTP credentials; the bridge submits snapshots only.
// REQUEST_TOO_LARGE and DOCUMENT_TOO_LARGE must pause automatic saving and preserve local download.
export interface SaveAdapter {
  save(request: SaveFileRequest, signal: AbortSignal): Promise<SaveFileResponse>;
}
export interface EditorSession {
  content: string;
  revision: number;
  lease: LeaseCredentials;
  expiresAt: number;
}
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'failed' | 'paused';
export interface EditorBridgeOptions {
  clock: BridgeClock;
  saveAdapter: SaveAdapter;
  session: EditorSession;
  editorWindow: Window;
  editorOrigin: string;
  onStatus(status: SaveStatus): void;
  onExit?(): void;
  onExitBlocked?(error: unknown): void;
}
export interface EditorBridge {
  flush(): Promise<void>;
  currentContent(): string;
  updateLease(expiresAt: number): void;
  dispose(): void;
}
export type CreateEditorBridge = (options: EditorBridgeOptions) => EditorBridge;

function getErrorCode(value: unknown): ErrorCode | undefined {
  if (!value || typeof value !== 'object') return;
  const detail = 'error' in value ? value.error : value;
  if (!detail || typeof detail !== 'object' || !('code' in detail)) return;
  const code = detail.code;
  return typeof code === 'string' && Object.hasOwn(errorDefinitions, code) ? code as ErrorCode : undefined;
}

export const createEditorBridge: CreateEditorBridge = options => {
  try {
    const origin = new URL(options.editorOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.editorOrigin) throw new Error();
  } catch {
    throw new Error('editorOrigin 必须是明确的 HTTP(S) origin');
  }
  const host = window;
  let disposed = false;
  let initialized = false;
  let controller: AbortController | undefined;
  let content = options.session.content;
  let revision = options.session.revision;
  let timer: unknown;
  let pendingSince: number | undefined;
  const status = (value: SaveStatus) => {
    options.onStatus(value);
    options.editorWindow.postMessage(JSON.stringify({ action: 'status', message: { saved: '已保存', dirty: '未保存', saving: '保存中', failed: '保存失败', paused: '保存已暂停，请下载当前内容' }[value], modified: value !== 'saved' }), options.editorOrigin);
  };
  let generation = 0;
  let confirmed = 0;
  let running = false;
  let due = false;
  let paused = false;
  let failure: unknown;
  let expiresAt = options.session.expiresAt;
  let leaseExpired = false;
  let leaseTimer: unknown;
  const scheduleExpiration = () => {
    options.clock.clearTimeout(leaseTimer);
    leaseTimer = options.clock.setTimeout(checkLease, Math.max(0, expiresAt - options.clock.now()));
  };
  const checkLease = () => {
    if (disposed || paused || options.clock.now() < expiresAt) return;
    leaseExpired = true;
    failure = { code: 'LEASE_LOST', message: errorDefinitions.LEASE_LOST.message };
    status('paused');
    waiters.splice(0).forEach(waiter => waiter.reject(failure));
  };
  const waiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  const save = async () => {
    if (disposed) return;
    due = true;
    checkLease();
    if (leaseExpired || paused || running || generation === confirmed) return;
    running = true;
    due = false;
    pendingSince = undefined;
    const submitted = generation;
    status('saving');
    let response;
    controller = new AbortController();
    try {
      response = await options.saveAdapter.save({ ...options.session.lease, content, expectedRevision: revision }, controller.signal);
    } catch (error) {
      if (disposed) return;
      running = false;
      failure = error;
      pendingSince = undefined;
      const code = getErrorCode(error);
      paused = code !== undefined && !['STORAGE_FAILURE', 'INTERNAL_ERROR', 'RATE_LIMITED'].includes(code);
      checkLease();
      status(paused || leaseExpired ? 'paused' : 'failed');
      if (code) options.editorWindow.postMessage(JSON.stringify({ action: 'status', message: errorDefinitions[code].message, modified: true }), options.editorOrigin);
      waiters.splice(0).forEach(waiter => waiter.reject(error));
      options.clock.clearTimeout(timer);
      if (!paused && !leaseExpired) timer = options.clock.setTimeout(() => { void save(); }, 2000);
      return;
    }
    if (disposed) return;
    revision = response.revision;
    confirmed = submitted;
    running = false;
    checkLease();
    if (leaseExpired || paused) return;
    status(confirmed === generation ? 'saved' : 'dirty');
    if (confirmed === generation) waiters.splice(0).forEach(waiter => waiter.resolve());
    else if (due || waiters.length) void save();
  };
  const receive = (event: MessageEvent) => {
    if (disposed) return;
    if (event.origin !== options.editorOrigin || event.source !== options.editorWindow || typeof event.data !== 'string') return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.event !== 'string') return;
    if (data.event === 'init') {
      if (initialized) return;
      initialized = true;
      options.editorWindow.postMessage(JSON.stringify({
        action: 'load', xml: content, autosave: 1, saveAndExit: '0',
        noSaveBtn: 1, noExitBtn: 1,
      }), options.editorOrigin);
      return;
    }
    if (!initialized) return;
    if (data.event === 'save' || data.event === 'autosave') {
      if (typeof data.xml !== 'string' || !data.xml.trim() || (data.exit !== undefined && typeof data.exit !== 'boolean')) return;
    } else if (data.event === 'exit') {
      if (data.xml !== undefined && typeof data.xml !== 'string') return;
    } else return;
    if ((data.event === 'autosave' || data.event === 'save') && typeof data.xml === 'string' && data.xml !== content) {
      content = data.xml;
      generation++;
      checkLease();
      if (paused || leaseExpired) return;
      status('dirty');
      options.clock.clearTimeout(timer);
      pendingSince ??= options.clock.now();
      timer = options.clock.setTimeout(() => { void save(); }, Math.min(2000, Math.max(0, pendingSince + 10000 - options.clock.now())));
    }
    if ((data.event === 'save' && typeof data.xml === 'string') || data.event === 'exit') {
      void bridge.flush().then(() => {
        if (!disposed && (data.event === 'exit' || data.exit === true)) options.onExit?.();
      }, error => {
        if (!disposed && (data.event === 'exit' || data.exit === true)) options.onExitBlocked?.(error);
      });
    }
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (generation === confirmed || disposed) return;
    event.preventDefault();
    event.returnValue = '';
  };
  host.addEventListener('message', receive);
  host.addEventListener('beforeunload', beforeUnload);
  const bridge: EditorBridge = {
    flush: () => {
      if (disposed) return Promise.reject(new Error('编辑会话已关闭'));
      checkLease();
      if (paused || leaseExpired) return Promise.reject(failure);
      if (generation === confirmed) return Promise.resolve();
      options.clock.clearTimeout(timer);
      return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
        void save();
      });
    },
    currentContent: () => content,
    updateLease: value => {
      if (disposed || !Number.isFinite(value)) return;
      const recovering = leaseExpired;
      expiresAt = value;
      scheduleExpiration();
      checkLease();
      if (!paused && value > options.clock.now()) {
        leaseExpired = false;
        if (recovering && generation !== confirmed) {
          options.clock.clearTimeout(timer);
          timer = options.clock.setTimeout(() => { void save(); }, 2000);
        }
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      host.removeEventListener('message', receive);
      host.removeEventListener('beforeunload', beforeUnload);
      options.clock.clearTimeout(timer);
      options.clock.clearTimeout(leaseTimer);
      controller?.abort();
      waiters.splice(0).forEach(waiter => waiter.reject(new Error('编辑会话已关闭')));
    },
  };
  scheduleExpiration();
  return bridge;
};
