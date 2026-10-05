import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthResponse, DrawingFile, User } from '@drawio-cloud/api-contract';
import { createApiClient, ClientError } from './api.js';
import { EditorPage } from './editor.js';
import './style.css';

const api = createApiClient();
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
const values = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); return new FormData(event.currentTarget); };
function Icon({ name }: { name: 'file' | 'search' | 'users' | 'lock' | 'logout' | 'chevron' }) {
  const paths = { file: 'M14 2H6v20h12V6zM14 2v4h4M9 12h6M9 16h6', search: 'm21 21-5-5', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87', lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5zM12 15v2', logout: 'M9 21H4V3h5M10 12h11M17 8l4 4-4 4', chevron: 'm6 9 6 6 6-6' };
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d={paths[name]} />{name === 'search' && <circle cx="10.5" cy="10.5" r="6.5" />}{name === 'users' && <circle cx="9" cy="7" r="4" />}</svg>;
}

function PasswordField({ label, name, autoComplete, minLength, maxLength }: { label: string; name: string; autoComplete: string; minLength?: number; maxLength?: number }) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return <div className="password-field">
    <label htmlFor={id}>{label}</label>
    <div className="password-input">
      <input id={id} name={name} type={visible ? 'text' : 'password'} autoComplete={autoComplete} minLength={minLength} maxLength={maxLength} required />
      <button type="button" className="password-toggle" aria-label={`${visible ? '隐藏' : '显示'}${label}`} aria-controls={id} aria-pressed={visible} title={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(value => !value)}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{visible && <path d="m3 3 18 18" />}</svg>
      </button>
    </div>
  </div>;
}

function Popover({ label, trigger, children, className = '' }: { label: string; trigger: ReactNode; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div ref={root} className={`popover ${className}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={button} className="popover-trigger" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>{trigger}</button>
    {open && <div className="popover-panel" aria-label={label} onClick={event => { if ((event.target as HTMLElement).closest('button, a')) { setOpen(false); button.current?.focus(); } }}>{children}</div>}
  </div>;
}

function AccountDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, []);
  return <dialog ref={dialog} className="account-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="account-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" disabled={busy} aria-label="关闭弹窗" onClick={onClose}>关闭</button></div>
    {children}
  </dialog>;
}

function App() {
  const [initialized, setInitialized] = useState<boolean>();
  const [auth, setAuth] = useState<AuthResponse>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<'files' | 'users' | 'password'>('files');
  const [files, setFiles] = useState<DrawingFile[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<DrawingFile>();
  const [editingId, setEditingId] = useState(() => new URL(window.location.href).searchParams.get('file') ?? undefined);
  const [deleting, setDeleting] = useState<DrawingFile>();
  const [renaming, setRenaming] = useState<DrawingFile>();
  const [resetting, setResetting] = useState<User>();
  const [creating, setCreating] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [changingUser, setChangingUser] = useState<User>();
  const [userSearch, setUserSearch] = useState('');
  const [userFilter, setUserFilter] = useState<'all' | 'active' | 'disabled'>('all');
  const [userNotice, setUserNotice] = useState('');
  const [usersLoaded, setUsersLoaded] = useState(false);
  const accountDialogOpen = creatingUser || !!resetting || !!changingUser;
  const visibleUsers = users.filter(user => user.username.toLocaleLowerCase().includes(userSearch.trim().toLocaleLowerCase()) && (userFilter === 'all' || (userFilter === 'disabled' ? user.disabled : !user.disabled)));
  useEffect(() => { if (!auth) { setCreatingUser(false); setResetting(undefined); setChangingUser(undefined); setUserNotice(''); } }, [auth]);
  function openFile(file?: DrawingFile) {
    const url = new URL(window.location.href);
    if (file) url.searchParams.set('file', file.id);
    else url.searchParams.delete('file');
    window.history.replaceState(null, '', url);
    setEditingId(file?.id);
    setEditing(file);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (e) {
      if (e instanceof ClientError && e.code === 'UNAUTHENTICATED') { setAuth(undefined); setError('登录已失效，账号可能已停用或密码已变更。请重新登录或联系管理员。'); }
      else setError(message(e));
    } finally { setBusy(false); }
  }
  const refresh = async () => setFiles((await api.files(search)).files);
  useEffect(() => { void run(async () => { setInitialized((await api.bootstrap()).initialized); try { setAuth(await api.me()); } catch (e) { if (!(e instanceof ClientError) || e.code !== 'UNAUTHENTICATED') throw e; } }); }, []);
  useEffect(() => {
    if (!auth || !editingId || editing?.id === editingId) return;
    let active = true;
    void api.content(editingId).then(result => {
      if (active) setEditing(result.file);
    }, e => {
      if (!active) return;
      openFile();
      void run(async () => { throw e; });
    });
    return () => { active = false; };
  }, [auth, editingId, editing?.id]);
  useEffect(() => { if (!auth || editingId) return; let active = true; void api.files(search).then(result => { if (active) setFiles(result.files); }, e => { if (active) void run(async () => { throw e; }); }); return () => { active = false; }; }, [auth, search, editingId]);
  useEffect(() => { if (auth && page === 'users') { setUsersLoaded(false); setUserNotice(''); void run(async () => { setUsers((await api.users()).users); setUsersLoaded(true); }); } }, [auth, page]);
  useEffect(() => { if (!auth || editing) return; const timer = setInterval(() => { void api.me().catch(e => { void run(async () => { throw e; }); }); }, 10000); return () => clearInterval(timer); }, [auth, editing]);
  if (editing && auth) return <EditorPage key={editing.id} api={api} file={editing} onLeave={() => openFile()} onSwitch={openFile} />;
  if (editingId && auth) return <div className="editor-shell"><main className="editor-wait"><h1>正在打开绘图</h1><p>正在加载服务器保存的文件。</p><button onClick={() => openFile()}>返回文件列表</button></main></div>;
  return <div className="shell"><header className="workspace-header"><a className="brand" href="/">DRAWIO <span>CLOUD</span></a>{auth && <nav aria-label="工作台导航"><button className={`nav-link ${page === 'files' ? 'active' : ''}`} onClick={() => setPage('files')}>我的绘图</button><Popover label="账号选项" className="account-menu" trigger={<><span className="avatar">{auth.user.username.slice(0, 1).toUpperCase()}</span><span className="account-name">{auth.user.username}</span><Icon name="chevron" /></>}><div className="account-summary"><span className="avatar">{auth.user.username.slice(0, 1).toUpperCase()}</span><div><strong>{auth.user.username}</strong><small>{auth.user.role === 'admin' ? '管理员账号' : '普通账号'}</small></div></div><div className="menu-group">{auth.user.role === 'admin' && <button onClick={() => setPage('users')}><Icon name="users" /><span>账号管理<small>创建与管理用户</small></span></button>}<button onClick={() => setPage('password')}><Icon name="lock" /><span>修改密码<small>更新账号登录密码</small></span></button></div><div className="menu-group"><button disabled={busy} onClick={() => void run(async () => { await api.logout(); setAuth(undefined); })}><Icon name="logout" /><span>退出登录</span></button></div></Popover></nav>}</header>
    <main className={auth ? `workspace ${page === 'files' ? 'files-workspace' : page === 'users' ? 'users-workspace' : ''}` : 'auth-card'}>{error && !accountDialogOpen && <div className="alert" role="alert">{error}</div>}
      {initialized === undefined ? <><h1>正在连接绘图工作台</h1><button onClick={() => void run(async () => setInitialized((await api.bootstrap()).initialized))}>重试连接</button></> : !auth ? <><p className="eyebrow">让想法清晰可见</p><h1>{initialized ? '欢迎回来' : '初始化绘图工作台'}</h1><p>{initialized ? '请使用管理员为你创建的账号登录。' : '创建首个管理员。完成后注册入口将永久关闭。'}</p><form onSubmit={e => { const data = values(e); void run(async () => { const input = { username: String(data.get('username')), password: String(data.get('password')) }; if (!initialized) { try { await api.initialize(input); } catch (e) { if (e instanceof ClientError && e.code === 'ALREADY_INITIALIZED') setInitialized(true); throw e; } setInitialized(true); } setAuth(await api.login(input)); setPage('files'); }); }}><label>用户名<input name="username" autoComplete="username" required maxLength={100} /></label><label>密码<input name="password" type="password" autoComplete={initialized ? 'current-password' : 'new-password'} required minLength={8} maxLength={1024} /></label><button className="primary" disabled={busy}>{busy ? '请稍候…' : initialized ? '登录' : '创建管理员并登录'}</button></form><p className="hint">密码至少 8 个字符。会话最长 7 天；修改或重置密码会使旧会话失效。</p></> : page === 'password' ? <><h1>修改密码</h1><p>修改后所有旧会话失效，请使用新密码重新登录。</p><form onSubmit={e => { const data = values(e); void run(async () => { await api.changePassword(String(data.get('current')), String(data.get('next'))); setAuth(undefined); setError('密码已修改，请使用新密码登录。'); }); }}><PasswordField label="当前密码" name="current" autoComplete="current-password" /><PasswordField label="新密码" name="next" autoComplete="new-password" minLength={8} maxLength={1024} /><button className="primary" disabled={busy}>修改密码</button></form></> : page === 'users' && auth.user.role === 'admin' ? <>
        <div className="files-heading"><div><p className="eyebrow">管理员工作台</p><h1>账号管理</h1><p className="workspace-description">管理工作台的登录账号与使用权限。</p></div><button className="primary" disabled={busy || !usersLoaded} onClick={() => { setError(''); setUserNotice(''); setCreatingUser(true); }}>＋ 创建账号</button></div>
        {userNotice && <div className="account-notice" role="status">{userNotice}</div>}
        <div className="account-overview"><strong>全部账号 <span>{usersLoaded ? users.length : '—'}</span></strong><span>使用中 {usersLoaded ? users.filter(user => !user.disabled).length : '—'}</span><span>已停用 {usersLoaded ? users.filter(user => user.disabled).length : '—'}</span></div>
        <div className="account-controls"><label className="file-search"><Icon name="search" /><input aria-label="搜索用户名" value={userSearch} onChange={event => setUserSearch(event.target.value)} placeholder="搜索用户名…" /></label><div className="account-filters" role="group" aria-label="筛选账号状态">{([{ value: 'all', label: '全部' }, { value: 'active', label: '使用中' }, { value: 'disabled', label: '已停用' }] as const).map(filter => <button key={filter.value} aria-pressed={userFilter === filter.value} onClick={() => setUserFilter(filter.value)}>{filter.label}</button>)}</div></div>
        <div className="account-table-wrap" aria-busy={busy}><table className="account-table"><caption className="visually-hidden">工作台账号列表</caption><thead><tr><th scope="col">账号</th><th scope="col">角色</th><th scope="col">状态</th><th scope="col">管理操作</th></tr></thead><tbody>{!usersLoaded ? <tr><td colSpan={4}><div className="empty"><strong>{error ? '账号列表加载失败' : '正在加载账号…'}</strong>{error && <button disabled={busy} onClick={() => void run(async () => { setUsers((await api.users()).users); setUsersLoaded(true); })}>重新加载</button>}</div></td></tr> : visibleUsers.length === 0 ? <tr><td colSpan={4}><div className="empty"><span className="empty-icon"><Icon name="users" /></span><strong>没有找到匹配的账号</strong><p>试试其他用户名或调整状态筛选。</p><button onClick={() => { setUserSearch(''); setUserFilter('all'); }}>清除筛选</button></div></td></tr> : visibleUsers.map(user => <tr key={user.id}><td><div className="account-identity"><span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span><strong>{user.username}</strong>{user.id === auth.user.id && <span className="account-self">你</span>}</div></td><td><span className="account-role">{user.role === 'admin' ? '管理员' : '普通用户'}</span></td><td><span className={`account-status ${user.disabled ? 'disabled' : ''}`}>{user.disabled ? '已停用' : '使用中'}</span></td><td><div className="actions"><button disabled={busy} onClick={() => { setError(''); setUserNotice(''); setResetting(user); }} aria-label={`重置 ${user.username} 的密码`}>重置密码</button>{user.id === auth.user.id ? <span className="account-current" title="当前登录账号不可停用">当前账号</span> : <button className={user.disabled ? '' : 'account-disable'} disabled={busy} onClick={() => { setError(''); setUserNotice(''); setChangingUser(user); }} aria-label={`${user.disabled ? '恢复' : '停用'} ${user.username}`}>{user.disabled ? '恢复使用' : '停用账号'}</button>}</div></td></tr>)}</tbody></table></div>
        <div className="account-footer"><span>新建账号默认是普通用户，当前登录账号不可停用。</span>{usersLoaded && <span>显示 {visibleUsers.length} / {users.length} 个账号</span>}</div>
      </> : <>
        <div className="files-heading"><div><p className="eyebrow">你的创作空间</p><h1>{auth.user.role === 'admin' ? '全部绘图' : '我的绘图'}</h1><p className="workspace-description">让想法清晰可见，从一张图开始。</p></div><div className="actions"><label className={`import ${busy ? 'disabled' : ''}`}>导入文件<input type="file" aria-label="导入 .drawio 文件" accept=".drawio" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(async () => { if (!/\.drawio$/i.test(file.name)) throw new Error('仅支持导入 .drawio 文件。'); await api.importFile(file.name, await file.text()); await refresh(); }); }} /></label><button className="primary" disabled={busy} onClick={() => { setError(''); setCreating(true); }}>＋ 新建绘图</button></div></div>
        <div className="files-controls"><label className="file-search"><Icon name="search" /><input aria-label="搜索文件名" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索绘图名称…" /></label><span>{search ? '搜索结果' : '绘图文件'} · {files.length} 个文件</span></div>
        <div className="file-list drawing-list">{files.length === 0 ? <div className="empty"><span className="empty-icon"><Icon name="file" /></span><strong>{search ? '没有找到匹配的绘图' : '从第一张绘图开始'}</strong><p>{search ? '试试其他文件名或清空搜索。' : '新建一张图，或导入已有的 .drawio 文件。'}</p>{!search && <button className="primary" disabled={busy} onClick={() => { setError(''); setCreating(true); }}>新建绘图</button>}</div> : files.map(file => <article key={file.id}><span className="drawing-icon"><Icon name="file" /></span><div className="drawing-info"><button className="file-name" onClick={() => openFile(file)}>{file.name}</button><p>{auth.user.role === 'admin' && `${file.ownerUsername} · `}{new Date(file.updatedAt).toLocaleString('zh-CN')} · {(file.size / 1024).toFixed(1)} KiB</p></div><div className="actions"><button className="open-drawing" onClick={() => openFile(file)}>打开绘图 <span aria-hidden="true">↗</span></button><Popover label={`${file.name}的更多操作`} className="file-menu" trigger="···"><button onClick={() => { setError(''); setRenaming(file); }}>重命名</button><a href={api.downloadUrl(file.id)} download>下载文件</a><button className="danger" onClick={() => { setError(''); setDeleting(file); }}>删除文件</button></Popover></div></article>)}</div>
        <div className="workspace-footer"><span className="storage-status">文档保存在当前服务器</span><details><summary>文件使用说明</summary><p>支持导入 .drawio，导入会创建新文件，同一账号下名称唯一。默认单文件上限 20 MiB，以服务端配置为准。永久删除无法恢复；没有历史版本、回收站或跨关闭草稿恢复。外网素材和引用图片需网络及提供方服务可用。</p></details></div>
      </>}
    </main>
    {creating && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="create-title"><p className="eyebrow">新的想法</p><h2 id="create-title">新建绘图</h2><p>为绘图起个名字，接下来进入编辑器。</p>{error && <p className="alert" role="alert">{error}</p>}<form onSubmit={e => { const data = values(e); void run(async () => { const file = await api.createFile(String(data.get('name'))); setCreating(false); openFile(file); }); }}><label>文件名称<input name="name" autoFocus placeholder="例如：系统架构.drawio" required /></label><div className="actions"><button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button><button className="primary" disabled={busy}>{busy ? '正在创建…' : '创建并开始绘图'}</button></div></form></section></div>}
    {deleting && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">永久删除，无法恢复</h2><p>确定删除“{deleting.name}”？正文将永久删除，没有回收站。</p>{error && <p role="alert">{error}</p>}<div className="actions"><button onClick={() => setDeleting(undefined)}>取消</button><button className="danger" disabled={busy} onClick={() => void run(async () => { await api.deleteFile(deleting.id); setDeleting(undefined); await refresh(); })}>确认永久删除</button></div></section></div>}
    {renaming && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="重命名文件"><h2>重命名文件</h2>{error && <p role="alert">{error}</p>}<form onSubmit={e => { const data = values(e); void run(async () => { await api.renameFile(renaming.id, String(data.get('name'))); setRenaming(undefined); await refresh(); }); }}><label>文件名<input name="name" defaultValue={renaming.name} required /></label><div className="actions"><button type="button" onClick={() => setRenaming(undefined)}>取消</button><button className="primary" disabled={busy}>保存名称</button></div></form></section></div>}
    {creatingUser && auth && <AccountDialog title="创建普通账号" busy={busy} onClose={() => { setCreatingUser(false); setError(''); }}><p>为成员开通账号，他们可以登录并管理自己的绘图。</p>{error && <p className="alert" role="alert">{error}</p>}<form onSubmit={event => { const data = values(event); void run(async () => { const username = String(data.get('username')).trim(); const result = await api.createUser({ username, password: String(data.get('password')) }); setUsers(current => [...current, result]); setCreatingUser(false); setUserSearch(''); setUserFilter('all'); setUserNotice(`已创建账号“${username}”。`); }); }}><label>用户名<input name="username" autoFocus placeholder="例如：lin.design" required maxLength={100} autoComplete="off" /></label><PasswordField label="初始密码" name="password" autoComplete="new-password" minLength={8} maxLength={1024} /><p className="account-form-hint">密码至少 8 个字符。新建账号默认是普通用户。</p><div className="actions"><button type="button" disabled={busy} onClick={() => { setCreatingUser(false); setError(''); }}>取消</button><button className="primary" disabled={busy}>{busy ? '正在创建…' : '创建普通账号'}</button></div></form></AccountDialog>}
    {resetting && auth && <AccountDialog title={`重置 ${resetting.username} 的密码`} busy={busy} onClose={() => { setResetting(undefined); setError(''); }}><p>该账号的所有旧会话将失效，用户需要使用新密码重新登录。</p>{error && <p className="alert" role="alert">{error}</p>}<form onSubmit={event => { const data = values(event); void run(async () => { await api.resetPassword(resetting.id, String(data.get('password'))); setUserNotice(`已重置“${resetting.username}”的密码，请使用新密码重新登录。`); setResetting(undefined); }); }}><PasswordField label="新密码" name="password" autoComplete="new-password" minLength={8} maxLength={1024} /><p className="account-form-hint">密码至少 8 个字符。</p><div className="actions"><button type="button" disabled={busy} onClick={() => { setResetting(undefined); setError(''); }}>取消</button><button className="primary" disabled={busy}>{busy ? '正在重置…' : '确认重置'}</button></div></form></AccountDialog>}
    {changingUser && auth && <AccountDialog title={`${changingUser.disabled ? '恢复' : '停用'}账号“${changingUser.username}”`} busy={busy} onClose={() => { setChangingUser(undefined); setError(''); }}><p>{changingUser.disabled ? '恢复后，该用户可以重新登录并继续使用原有绘图文件。' : '该用户将立即退出登录，当前编辑锁会被释放。原有绘图文件将保留。'}</p>{error && <p className="alert" role="alert">{error}</p>}<div className="actions"><button disabled={busy} onClick={() => { setChangingUser(undefined); setError(''); }}>取消</button><button className={changingUser.disabled ? 'primary' : 'danger'} disabled={busy} onClick={() => void run(async () => { const result = await api.setDisabled(changingUser.id, !changingUser.disabled); setUsers(current => current.map(user => user.id === result.id ? result : user)); setUserNotice(`已${changingUser.disabled ? '恢复' : '停用'}账号“${changingUser.username}”。`); setChangingUser(undefined); })}>{busy ? '正在处理…' : changingUser.disabled ? '确认恢复使用' : '确认停用账号'}</button></div></AccountDialog>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
