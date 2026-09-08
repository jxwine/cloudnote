import type { Folder, Note, Revision, User } from './types'

const LS = {
  server: 'cloudnote.server',
  token: 'cloudnote.token',
  user: 'cloudnote.user',
  clientId: 'cloudnote.clientId',
}

/**
 * 默认同步服务地址。打包时可以注入自己的服务器，用户装上就能直接登录：
 *   VITE_CLOUDNOTE_SERVER=https://note.example.com npm run dist
 * 没注入就用本地，方便开发和自建。登录页始终可以手动改。
 */
export const DEFAULT_SERVER = import.meta.env.VITE_CLOUDNOTE_SERVER || 'http://localhost:4471'

/** 设备标识：用于让服务端跳过变更发起方，避免自己收到自己的广播 */
export const clientId = (() => {
  let id = localStorage.getItem(LS.clientId)
  if (!id) {
    id = 'c-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    localStorage.setItem(LS.clientId, id)
  }
  return id
})()

export const session = {
  get server() {
    return localStorage.getItem(LS.server) || DEFAULT_SERVER
  },
  set server(v: string) {
    localStorage.setItem(LS.server, v.replace(/\/+$/, ''))
  },
  get token() {
    return localStorage.getItem(LS.token)
  },
  get user(): User | null {
    const raw = localStorage.getItem(LS.user)
    return raw ? (JSON.parse(raw) as User) : null
  },
  save(token: string, user: User) {
    localStorage.setItem(LS.token, token)
    localStorage.setItem(LS.user, JSON.stringify(user))
  },
  clear() {
    localStorage.removeItem(LS.token)
    localStorage.removeItem(LS.user)
  },
}

/** 版本冲突：服务端已有更新的版本，body 里带着服务端最新内容 */
export class ConflictError extends Error {
  constructor(public note: Note) {
    super('版本冲突')
    this.name = 'ConflictError'
  }
}

/** 网络不可达（区别于服务端返回的业务错误，用于切换到离线模式） */
export class OfflineError extends Error {
  constructor() {
    super('无法连接到同步服务')
    this.name = 'OfflineError'
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-client-id': clientId }
  const token = session.token
  if (token) headers.authorization = 'Bearer ' + token
  if (body !== undefined) headers['content-type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(session.server + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new OfflineError()
  }

  const data = await res.json().catch(() => null)
  if (res.status === 409 && data?.conflict) throw new ConflictError(data.note)
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`)
  return data as T
}

export const api = {
  register: (email: string, password: string, displayName?: string) =>
    request<{ token: string; user: User }>('POST', '/api/auth/register', {
      email,
      password,
      displayName,
    }),

  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/api/auth/login', { email, password }),

  me: () => request<{ user: User; peers: number }>('GET', '/api/me'),

  pull: (since: number) =>
    request<{ seq: number; folders: Folder[]; notes: Note[] }>('GET', `/api/sync/pull?since=${since}`),

  createFolder: (input: { id?: string; name: string; parentId?: string | null; sortOrder?: number }) =>
    request<Folder>('POST', '/api/folders', input),

  updateFolder: (
    id: string,
    input: { name?: string; parentId?: string | null; sortOrder?: number; baseVersion?: number }
  ) => request<Folder>('PATCH', `/api/folders/${id}`, input),

  deleteFolder: (id: string) =>
    request<{ folders: Folder[]; notes: Note[] }>('DELETE', `/api/folders/${id}`),

  createNote: (input: {
    id?: string
    folderId?: string | null
    title?: string
    content?: string
    excerpt?: string
    sortOrder?: number
    conflictOf?: string | null
    tags?: string[]
  }) => request<Note>('POST', '/api/notes', input),

  updateNote: (
    id: string,
    input: {
      folderId?: string | null
      title?: string
      content?: string
      excerpt?: string
      sortOrder?: number
      deleted?: boolean
      tags?: string[]
      baseVersion?: number
    }
  ) => request<Note>('PATCH', `/api/notes/${id}`, input),

  deleteNote: (id: string) => request<Note>('DELETE', `/api/notes/${id}`),

  /** 彻底删除，回收站里「不再保留」用 */
  purgeNote: (id: string) => request<{ id: string }>('DELETE', `/api/notes/${id}/purge`),

  revisions: (noteId: string) =>
    request<{ revisions: Revision[] }>('GET', `/api/notes/${noteId}/revisions`),
  revision: (revId: string) =>
    request<{ id: string; noteId: string; title: string; content: string; createdAt: number }>(
      'GET', `/api/revisions/${revId}`
    ),
  restoreRevision: (revId: string) => request<Note>('POST', `/api/revisions/${revId}/restore`),

  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/auth/password', { oldPassword, newPassword }),

  /** 图片以 data URL 提交，返回的是服务端相对路径 */
  upload: (dataUrl: string) => request<{ url: string; bytes: number }>('POST', '/api/upload', { dataUrl }),
}

/** 把服务端返回的相对路径拼成能直接放进 <img src> 的绝对地址 */
export const fileUrl = (path: string) =>
  path.startsWith('http') ? path : session.server + path

export const newLocalId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
