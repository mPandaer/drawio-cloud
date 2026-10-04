import { errorDefinitions, type HealthResponse, type ErrorCode, type AuthResponse, type BootstrapResponse, type CredentialsRequest, type UsersResponse, type User, type DrawingFile, type FilesResponse, type FileContentResponse, type LeaseResponse, type LeaseCredentials, type SaveFileRequest, type SaveFileResponse } from '@drawio-cloud/api-contract';

export class ClientError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function createApiClient(baseUrl = '') {
  let csrfToken = '';
  async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method, credentials: 'same-origin', signal,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-csrf-token': csrfToken }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((cause: unknown) => { throw new ClientError('NETWORK_ERROR', errorDefinitions.INTERNAL_ERROR.message); });
    if (response.status === 204) return undefined as T;
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof result?.error?.code === 'string' ? result.error.code : response.status === 413 ? 'REQUEST_TOO_LARGE' : 'INTERNAL_ERROR';
      const known = Object.hasOwn(errorDefinitions, code) ? errorDefinitions[code as ErrorCode] : undefined;
      throw new ClientError(code, known?.message ?? result?.error?.message ?? errorDefinitions.INTERNAL_ERROR.message);
    }
    if (result === null) throw new ClientError('INTERNAL_ERROR', errorDefinitions.INTERNAL_ERROR.message);
    return result as T;
  }
  const authenticate = async (path: string, body?: CredentialsRequest) => {
    const auth = await request<AuthResponse>(path, body ? 'POST' : 'GET', body);
    csrfToken = auth.csrfToken;
    return auth;
  };
  const filePath = (id: string) => `/files/${encodeURIComponent(id)}`;
  return {
    async health(signal?: AbortSignal): Promise<HealthResponse> {
      const body = await request<HealthResponse>('/health', 'GET', undefined, signal);
      if (body.status !== 'ok') throw new ClientError('INTERNAL_ERROR', errorDefinitions.INTERNAL_ERROR.message);
      return body;
    },
    bootstrap: () => request<BootstrapResponse>('/bootstrap'),
    initialize: (input: CredentialsRequest) => request<BootstrapResponse>('/bootstrap', 'POST', input),
    login: (input: CredentialsRequest) => authenticate('/auth/login', input),
    me: () => authenticate('/auth/me'),
    logout: () => request<void>('/auth/logout', 'POST'),
    changePassword: (currentPassword: string, newPassword: string) => request<void>('/auth/password', 'POST', { currentPassword, newPassword }),
    users: () => request<UsersResponse>('/admin/users'),
    createUser: (input: CredentialsRequest) => request<User>('/admin/users', 'POST', input),
    resetPassword: (id: string, newPassword: string) => request<void>(`/admin/users/${encodeURIComponent(id)}/password`, 'POST', { newPassword }),
    setDisabled: (id: string, disabled: boolean) => request<User>(`/admin/users/${encodeURIComponent(id)}`, 'PATCH', { disabled }),
    files: (search = '') => request<FilesResponse>(`/files?search=${encodeURIComponent(search)}`),
    createFile: (name: string) => request<DrawingFile>('/files', 'POST', { name }),
    importFile: (name: string, content: string) => request<DrawingFile>('/files/import', 'POST', { name, content }),
    renameFile: (id: string, name: string) => request<DrawingFile>(filePath(id), 'PATCH', { name }),
    deleteFile: (id: string) => request<void>(filePath(id), 'DELETE', { confirmed: true }),
    content: (id: string) => request<FileContentResponse>(`${filePath(id)}/content`),
    downloadUrl: (id: string) => `${baseUrl}/api${filePath(id)}/download`,
    acquire: (id: string, windowId: string, resumeLease?: LeaseCredentials) => request<LeaseResponse>(`${filePath(id)}/edit-session`, 'POST', { windowId, ...(resumeLease ? { resumeLease } : {}) }),
    renew: (id: string, lease: LeaseCredentials) => request<LeaseResponse>(`${filePath(id)}/edit-session`, 'PATCH', lease),
    release: (id: string, lease: LeaseCredentials) => request<void>(`${filePath(id)}/edit-session`, 'DELETE', lease),
    save: (id: string, body: SaveFileRequest, signal: AbortSignal) => request<SaveFileResponse>(`${filePath(id)}/content`, 'PUT', body, signal),
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
