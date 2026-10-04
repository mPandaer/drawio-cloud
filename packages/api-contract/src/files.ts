import type { LeaseCredentials } from './editing.js';
export interface DrawingFile {
  id: string; ownerId: string; ownerUsername: string; name: string;
  revision: number; size: number; createdAt: number; updatedAt: number;
}
export interface FilesQuery { search?: string }
export interface FilesResponse { files: DrawingFile[] }
export interface CreateFileRequest { name: string }
export interface ImportFileRequest { name: string; content: string }
export interface RenameFileRequest { name: string }
export interface DeleteFileRequest { confirmed: boolean }
export interface FileContentResponse { file: DrawingFile; content: string }
export interface SaveFileRequest extends LeaseCredentials { expectedRevision: number; content: string }
export interface SaveFileResponse { revision: number; size: number; updatedAt: number }
