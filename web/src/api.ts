import type { RawInfo, UploadResult } from './types';

const TOKEN_KEY = 'recode.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Reads the access token from the start URL (?token=…), keeps it for the tab and removes it from the address bar. */
export function initToken(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** URL for endpoints used by EventSource and plain links, which cannot send headers. */
export function urlWithToken(path: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(getToken())}`;
}

interface ErrorBody {
  error?: { code?: string; message?: string; hint?: string };
}

async function toError(response: Response): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // non-JSON error body
  }
  const info = body.error;
  return new ApiError(
    response.status,
    info?.code ?? 'ERROR',
    info?.message ?? `Request failed (${response.status})`,
    info?.hint,
  );
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${getToken()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK',
      'Cannot reach the ReCode server. Is "recode ui" still running?',
    );
  }
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
};

export const projectPath = (name: string): string => `/api/projects/${encodeURIComponent(name)}`;

/** Uploads a file with progress reporting (fetch cannot report upload progress). */
export function uploadFile(
  project: string,
  file: File,
  raw: RawInfo | null,
  onProgress: (fraction: number) => void,
): Promise<UploadResult> {
  const query = new URLSearchParams({ name: file.name });
  if (raw) {
    query.set('raw', '1');
    query.set('arch', raw.arch);
    query.set('endian', raw.endian);
    query.set('bits', raw.bits);
    query.set('base', raw.base);
    if (raw.entry) query.set('entry', raw.entry);
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${projectPath(project)}/files?${query}`);
    xhr.setRequestHeader('authorization', `Bearer ${getToken()}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Upload failed: server not reachable.'));
    xhr.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as UploadResult);
        return;
      }
      const info = (parsed as ErrorBody).error;
      reject(
        new ApiError(
          xhr.status,
          info?.code ?? 'ERROR',
          info?.message ?? `Upload failed (${xhr.status})`,
          info?.hint,
        ),
      );
    };
    xhr.send(file);
  });
}
