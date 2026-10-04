export type UserRole = 'admin' | 'user';
export interface User { id: string; username: string; role: UserRole; disabled: boolean }
export interface CredentialsRequest { username: string; password: string }
export interface BootstrapResponse { initialized: boolean }
export interface AuthResponse { user: User; csrfToken: string; expiresAt: number }
export interface ChangePasswordRequest { currentPassword: string; newPassword: string }
export interface ResetPasswordRequest { newPassword: string }
export interface SetUserStatusRequest { disabled: boolean }
export interface UsersResponse { users: User[] }
