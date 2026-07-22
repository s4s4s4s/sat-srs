/** Минимальный клиент GitHub Git Data API. Только api.github.com (raw.githubusercontent из РФ нестабилен). */

export interface TreeEntry { path: string; mode: string; type: 'blob' | 'tree' | 'commit'; sha: string }

export class GhError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** Срок жизни PAT из заголовка последнего ответа GitHub (ISO-строка или null) */
export let tokenExpiration: string | null = null

const REQ_TIMEOUT_MS = 20000
const MAX_RETRIES = 3

/** Экспоненциальный бэкофф с джиттером; уважает Retry-After (сек), потолок 15 с */
function backoff(attempt: number, retryAfterSec = 0): Promise<void> {
  const base = retryAfterSec > 0 ? retryAfterSec * 1000 : 500 * 2 ** attempt
  const ms = Math.min(base + Math.random() * 400, 15000)
  return new Promise(r => setTimeout(r, ms))
}

export class GitHubClient {
  constructor(private token: string, private owner: string, private repo: string) {}

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}${path}`
    let lastErr: GhError | null = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal
        })
      } catch (e: any) {
        clearTimeout(timer)
        // abort (наш таймаут) или сетевой отказ fetch — оба ретраибельны
        lastErr = new GhError(0, ctrl.signal.aborted ? `таймаут ${REQ_TIMEOUT_MS} мс` : `сеть: ${e?.message ?? e}`)
        if (attempt < MAX_RETRIES) { await backoff(attempt); continue }
        throw lastErr
      }
      clearTimeout(timer)

      const exp = res.headers.get('github-authentication-token-expiration')
      if (exp) tokenExpiration = exp

      if (res.ok) return res.json()

      // Ретраибельны только 5xx и secondary-rate-limit (429 / 403 с Retry-After или исчерпанным лимитом).
      // 401/404/409/422 — детерминированы (протухший токен, нет ветки, гонка ref) → сразу наверх:
      // 422/409 ловит doSync и перечитывает — их ретраить внутри req НЕЛЬЗЯ.
      const retryAfter = Number(res.headers.get('retry-after'))
      const isRateLimit = res.status === 429 ||
        (res.status === 403 && (retryAfter > 0 || res.headers.get('x-ratelimit-remaining') === '0'))
      const retryable = res.status >= 500 || isRateLimit
      let msg = res.statusText
      try { msg = (await res.json()).message ?? msg } catch { /* ignore */ }
      lastErr = new GhError(res.status, `GitHub ${res.status}: ${msg}`)
      if (retryable && attempt < MAX_RETRIES) {
        await backoff(attempt, Number.isFinite(retryAfter) ? retryAfter : 0)
        continue
      }
      throw lastErr
    }
    throw lastErr ?? new GhError(0, 'req: неизвестная ошибка')
  }

  async checkRepo(): Promise<{ default_branch: string }> {
    return this.req('GET', '')
  }

  /** sha головного коммита ветки */
  async getHead(branch: string): Promise<string> {
    const r = await this.req('GET', `/git/ref/${encodeURIComponent(`heads/${branch}`)}`)
    return r.object.sha as string
  }

  async getCommit(sha: string): Promise<{ sha: string; treeSha: string }> {
    const c = await this.req('GET', `/git/commits/${sha}`)
    return { sha: c.sha, treeSha: c.tree.sha }
  }

  async getTreeRecursive(treeSha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const t = await this.req('GET', `/git/trees/${treeSha}?recursive=1`)
    return { entries: t.tree as TreeEntry[], truncated: !!t.truncated }
  }

  async getBlobText(sha: string): Promise<string> {
    const b = await this.req('GET', `/git/blobs/${sha}`)
    const bin = atob((b.content as string).replace(/\n/g, ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  }

  async createBlob(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    const r = await this.req('POST', '/git/blobs', { content: btoa(bin), encoding: 'base64' })
    return r.sha as string
  }

  async createTree(baseTreeSha: string, entries: { path: string; sha: string }[]): Promise<string> {
    const r = await this.req('POST', '/git/trees', {
      base_tree: baseTreeSha,
      tree: entries.map(e => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha }))
    })
    return r.sha as string
  }

  async createCommit(message: string, treeSha: string, parentSha: string): Promise<string> {
    const r = await this.req('POST', '/git/commits', { message, tree: treeSha, parents: [parentSha] })
    return r.sha as string
  }

  /** fast-forward only; при гонке GitHub вернёт 422 — ловим и перечитываем */
  async updateRef(branch: string, commitSha: string): Promise<void> {
    await this.req('PATCH', `/git/refs/${encodeURIComponent(`heads/${branch}`)}`, { sha: commitSha, force: false })
  }
}
