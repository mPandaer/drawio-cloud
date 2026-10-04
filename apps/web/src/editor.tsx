import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DrawingFile, FileContentResponse, LeaseResponse } from '@drawio-cloud/api-contract';
import { createEditorBridge, type EditorBridge, type SaveStatus } from '@drawio-cloud/editor-bridge';
import { ClientError, type ApiClient } from './api.js';
import { createEditingLease } from './editing-lease.js';

const windowId = globalThis.crypto.randomUUID?.() ?? `window-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const statusText: Record<SaveStatus, string> = { saved: '已保存', dirty: '未保存', saving: '保存中', failed: '保存失败', paused: '保存已暂停' };
const text = (e: unknown) => e instanceof Error ? e.message : '编辑锁已失效，请重新登录或联系管理员。当前内容仍可下载。';
const terminal = new Set(['UNAUTHENTICATED', 'ACCOUNT_DISABLED', 'FORBIDDEN', 'LEASE_LOST', 'NOT_FOUND']);
interface OpenDocument extends FileContentResponse { lease: LeaseResponse; generation: number }
export function downloadContent(content: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/xml;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = /\.drawio$/i.test(name) ? name : `${name}.drawio`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function EditorPage({ api, file, onLeave, onSwitch }: { api: ApiClient; file: DrawingFile; onLeave(): void; onSwitch(file: DrawingFile): void }) {
  const [opened, setOpened] = useState<OpenDocument>();
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [saveAs, setSaveAs] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const bridge = useRef<EditorBridge | undefined>(undefined);
  const lease = useRef<ReturnType<typeof createEditingLease> | undefined>(undefined);
  const renewTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const active = useRef(true);
  const leaving = useRef(false);
  const localContent = useRef('');
  const resumeKey = `drawio-edit-lease:${file.id}`;
  const rememberLease = (value?: LeaseResponse) => {
    try {
      if (value) sessionStorage.setItem(resumeKey, JSON.stringify(value));
      else sessionStorage.removeItem(resumeKey);
    } catch { /* Editing still works when browser storage is unavailable. */ }
  };
  const previousLease = (): LeaseResponse | undefined => {
    try {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (navigation?.type !== 'reload') { rememberLease(); return undefined; }
      const value = JSON.parse(sessionStorage.getItem(resumeKey) ?? 'null');
      return typeof value?.windowId === 'string' && typeof value?.leaseToken === 'string' ? value : undefined;
    } catch { return undefined; }
  };
  const stopRenewal = () => { clearInterval(renewTimer.current); renewTimer.current = undefined; };
  const fail = (e: unknown) => {
    if (!active.current) return;
    const c = e instanceof ClientError ? e.code : '';
    setCode(c); setError(terminal.has(c) ? `${text(e)} 请重新登录或联系管理员，当前内容仍可下载。` : text(e));
  };
  async function release() {
    stopRenewal();
    if (bridge.current) { localContent.current = bridge.current.currentContent(); bridge.current.dispose(); bridge.current = undefined; }
    const held = lease.current; lease.current = undefined;
    if (held) await held.release().catch(e => { if (!(e instanceof ClientError && terminal.has(e.code))) throw e; });
    rememberLease();
  }
  async function leave(discard = false) {
    if (leaving.current) return;
    leaving.current = true; setBusy(true);
    try {
      if (!discard && bridge.current) await bridge.current.flush();
      await release(); onLeave();
    } catch (e) { fail(e); setBlocked(true); } finally { leaving.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    setOpened(undefined); setError(''); setCode(''); setBusy(true);
    void (async () => {
      let acquired: LeaseResponse | undefined;
      try {
        try { acquired = await api.acquire(file.id, windowId, previousLease()); }
        catch (e) {
          if (!(e instanceof ClientError && e.code === 'LEASE_LOST')) throw e;
          rememberLease();
          acquired = await api.acquire(file.id, windowId);
        }
        if (cancelled) { await api.release(file.id, acquired); return; }
        rememberLease(acquired);
        lease.current = createEditingLease(api, file.id, acquired);
        const content = await api.content(file.id);
        if (cancelled) return;
        localContent.current = content.content;
        setOpened({ ...content, lease: acquired, generation: attempt });
      } catch (e) {
        if (!cancelled) { fail(e); if (acquired) await api.release(file.id, acquired).catch(() => {}); lease.current = undefined; }
      } finally { if (!cancelled) setBusy(false); }
    })();
    return () => {
      cancelled = true; active.current = false; stopRenewal();
      bridge.current?.dispose(); bridge.current = undefined;
      const held = lease.current; lease.current = undefined;
      if (held) void held.release().catch(() => {});
    };
  }, [file.id, attempt, api]);
  function attach(frame: HTMLIFrameElement | null) {
    if (!frame || !opened || bridge.current || !frame.contentWindow) return;
    const held = lease.current;
    if (!held) return;
    const current = createEditorBridge({
      clock: { now: Date.now, setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      session: { content: opened.content, revision: opened.file.revision, lease: opened.lease, expiresAt: opened.lease.expiresAt },
      editorWindow: frame.contentWindow, editorOrigin: window.location.origin,
      saveAdapter: { async save(request, signal) {
        try { const response = await held.save(request, signal); if (active.current) { setError(''); setCode(''); } return response; }
        catch (e) { fail(e); if (e instanceof ClientError && terminal.has(e.code)) { stopRenewal(); bridge.current?.updateLease(0); } throw e; }
      } },
      onStatus: value => { if (active.current) { setStatus(value); if (value === 'paused') setError(previous => previous || '编辑锁已失效，保存已暂停。请重新登录或联系管理员；可下载当前内容。'); } },
      onExit: () => { void leave(); }, onExitBlocked: e => { fail(e); setBlocked(true); },
    });
    bridge.current = current; setStatus('saved');
    let renewing = false;
    renewTimer.current = setInterval(() => {
      if (renewing || !lease.current) return;
      renewing = true;
      void held.renew().then(result => {
        if (bridge.current !== current) return;
        rememberLease(result);
        current.updateLease(result.expiresAt);
      }, e => {
        if (bridge.current !== current) return;
        fail(e);
        if (e instanceof ClientError && terminal.has(e.code)) { stopRenewal(); current.updateLease(0); }
      }).finally(() => { renewing = false; });
    }, 10000);
  }
  async function reload() {
    if (!window.confirm('重新加载将放弃当前未保存修改，是否继续？')) return;
    setBusy(true);
    try { await release(); setAttempt(value => value + 1); } catch (e) { fail(e); setBusy(false); }
  }
  async function copy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const name = String(new FormData(event.currentTarget).get('name'));
    setBusy(true);
    try {
      const content = bridge.current?.currentContent() ?? localContent.current;
      const created = await api.importFile(/\.drawio$/i.test(name) ? name : `${name}.drawio`, content);
      await release(); setSaveAs(false); setBlocked(false); onSwitch(created);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  const url = new URL('/editor/index.html', window.location.origin);
  url.search = 'embed=1&proto=json&keepmodified=1&lang=zh&ui=kennedy&pwa=0';
  return <div className="editor-shell"><header className="editor-header">
    <button className="editor-back" aria-label="返回文件列表" disabled={busy} onClick={() => void leave()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>文件列表
    </button>
    <div className="editor-document">
      <strong title={file.name}>{file.name}</strong>
      <span role="status" className={`save-status ${status}`}>{opened ? statusText[status] : '尚未进入编辑'}</span>
    </div>
    {opened && <div className="editor-actions">
      <button aria-label="立即保存" title="立即保存" disabled={busy} onClick={() => { setBusy(true); void bridge.current?.flush().catch(fail).finally(() => setBusy(false)); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></svg>保存
      </button>
      <button aria-label="下载当前内容" title="下载当前内容" onClick={() => downloadContent(bridge.current?.currentContent() ?? localContent.current, file.name)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" /></svg>下载
      </button>
    </div>}
  </header>
    {error && <div className="editor-alert" role="alert">{error}{code === 'REVISION_CONFLICT' && <div className="actions"><button disabled={busy} onClick={() => void reload()}>重新加载服务器版本</button><button disabled={busy} onClick={() => setSaveAs(true)}>另存为新文件</button></div>}{['DOCUMENT_TOO_LARGE', 'REQUEST_TOO_LARGE'].includes(code) && <><p>服务器未接受本次修改。请下载当前内容，或缩小文档后另存为新文件。</p><button disabled={busy} onClick={() => setSaveAs(true)}>另存为新文件</button></>}</div>}
    {opened ? <iframe key={`${file.id}-${attempt}`} ref={attach} title="draw.io 绘图编辑器" src={url.href} /> : <main className="editor-wait"><h1>{code === 'FILE_OCCUPIED' ? '文件正在使用中' : '正在准备编辑器'}</h1><p>{code === 'FILE_OCCUPIED' ? '该文件已在另一个窗口打开，目前只支持单窗口编辑。请先关闭原窗口，或等待编辑锁到期。' : '取得独占编辑权后加载文档。'}</p><button disabled={busy} onClick={() => setAttempt(value => value + 1)}>重试打开</button></main>}
    {blocked && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="退出前保护未保存内容"><h2>当前内容未能保存</h2><p>请先下载当前内容，或明确放弃修改后离开。浏览器关闭后无法恢复未保存草稿。</p><div className="actions"><button onClick={() => downloadContent(bridge.current?.currentContent() ?? localContent.current, file.name)}>下载当前内容</button><button onClick={() => setBlocked(false)}>继续编辑</button><button className="danger" disabled={busy} onClick={() => void leave(true)}>放弃修改并离开</button></div></section></div>}
    {saveAs && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="另存为新文件"><h2>另存为新文件</h2>{error && <p role="alert">{error}</p>}<p>当前内容归属于你的账号，原文件保持不变，新文件重新取得独立编辑锁。</p><form onSubmit={e => void copy(e)}><label>新文件名<input name="name" defaultValue={`副本-${file.name}`} required /></label><div className="actions"><button type="button" onClick={() => setSaveAs(false)}>取消</button><button className="primary" disabled={busy}>创建并打开</button></div></form></section></div>}
  </div>;
}
