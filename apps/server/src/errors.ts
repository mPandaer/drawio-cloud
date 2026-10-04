import { errorDefinitions, type ErrorCode, type ApiErrorResponse } from '../../../packages/api-contract/src/index.js';

export class ApiError extends Error {
  constructor(readonly code: ErrorCode, options?: ErrorOptions) { super(errorDefinitions[code].message, options); }
}
export function errorResponse(code: ErrorCode): ApiErrorResponse {
  return { error: { code, message: errorDefinitions[code].message } };
}
