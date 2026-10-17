/**
 * Minimal ComfyUI HTTP client used by the comfyui-assistant plugin.
 *
 * Only node built-ins are used (global fetch / FormData / Blob from Node >= 22),
 * so the module has no runtime dependencies and can also be exercised by a plain
 * `node test/smoke.mjs` outside the harness.
 */

/** An error carrying the ComfyUI HTTP status and JSON body (node_errors, etc.). */
export class ComfyUIError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ComfyUIError'
    this.status = details.status
    this.body = details.body
    this.code = details.code
  }
}

/** Cancellation requested by the caller (tool execution signal). */
export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

/** Deadline exceeded while waiting for a prompt to finish. */
export class TimeoutError extends Error {
  constructor(message = 'timeout') {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** Strip trailing slashes and default an empty value to the standard loopback URL. */
export function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'http://127.0.0.1:8188'
  return raw.replace(/\/+$/u, '')
}


/** Turn a fetch failure into a message a human (and the model) can act on. */
function describeFetchError(error, url) {
  // Node wraps connection failures in `cause` (sometimes an AggregateError).
  const codes = []
  const cause = error?.cause
  if (cause !== null && typeof cause === 'object') {
    if (typeof cause.code === 'string') codes.push(cause.code)
    if (Array.isArray(cause.errors)) {
      for (const inner of cause.errors) if (typeof inner?.code === 'string') codes.push(inner.code)
    }
  }
  if (typeof error?.code === 'string') codes.push(error.code)
  const rawMessage = String(cause?.message ?? error?.message ?? '')
  if (/ECONNREFUSED|actively refused/iu.test(`${rawMessage} ${error?.message ?? ''}`)) codes.push('ECONNREFUSED')
  if (/ENOTFOUND|EAI_AGAIN/iu.test(rawMessage)) codes.push('EAI_AGAIN')
  if (codes.includes('ECONNREFUSED')) {
    return `无法连接 ComfyUI（${url}）：连接被拒绝。请确认 ComfyUI 已启动，并检查插件配置里的 baseUrl。`
  }
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) {
    return `无法解析 ComfyUI 地址（${url}）：请检查主机名/网络。`
  }
  if (error?.name === 'AbortError') return `请求被中止（${url}）`
  return `请求 ComfyUI 失败（${url}）：${rawMessage === '' ? String(error) : rawMessage}`
}

/** Classify a failed fetch as caller cancellation, local timeout, or a real error. */
function failureFor(error, url, timeoutMs, timeoutSignal, userSignal) {
  if (userSignal?.aborted === true) return new ComfyUIError('已取消', { code: 'CANCELLED' })
  const timedOut = timeoutSignal?.aborted === true || error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError'
  if (timedOut) {
    const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? `，${timeoutMs}ms` : ''
    return new ComfyUIError(`请求超时（${url}${budget}）`, { code: 'TIMEOUT' })
  }
  return new ComfyUIError(describeFetchError(error, url), { code: error?.name })
}

/** Cache of the (large) /object_info response, keyed by base URL. */
const objectInfoCache = new Map()
const OBJECT_INFO_TTL_MS = 5 * 60 * 1000

export class ComfyUIClient {
  /**
   * @param {string} baseUrl - ComfyUI root URL, e.g. http://127.0.0.1:8188
   * @param {object} [options]
   * @param {number} [options.timeoutMs] - per-request timeout for ordinary calls.
   */
  constructor(baseUrl, options = {}) {
    /** Normalized base URL without a trailing slash. */
    this.baseUrl = normalizeBaseUrl(baseUrl)
    /** Default per-request timeout. */
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000
  }

  /** Absolute URL for one ComfyUI path. */
  url(path) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  /**
   * One JSON request.
   * @param {string} path - API path beginning with a slash.
   * @param {object} [options] - method, JSON/form body, timeout, caller signal.
   * @returns {Promise<any>} parsed JSON (or raw text when the body is not JSON).
   */
  async request(path, options = {}) {
    const { method = 'GET', body, timeoutMs, signal, headers = {} } = options
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData
    const budget = timeoutMs ?? this.timeoutMs
    const timeoutSignal = typeof budget === 'number' && budget > 0 ? AbortSignal.timeout(budget) : undefined
    const init = {
      method,
      headers: isForm ? headers : { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      signal: timeoutSignal === undefined ? signal : (signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal])),
    }
    if (body !== undefined) init.body = isForm ? body : JSON.stringify(body)
    let response
    try {
      response = await fetch(this.url(path), init)
    } catch (error) {
      throw failureFor(error, this.url(path), budget, timeoutSignal, signal)
    }
    const text = await response.text()
    let data
    try {
      data = text === '' ? undefined : JSON.parse(text)
    } catch {
      data = text
    }
    if (!response.ok) {
      const detail = typeof data === 'object' && data !== null
        ? data.error?.message ?? data.error ?? text
        : text
      throw new ComfyUIError(`ComfyUI 返回 HTTP ${response.status}：${String(detail).slice(0, 2000)}`, {
        status: response.status,
        body: data,
      })
    }
    return data
  }

  /** GET /system_stats (short timeout: this doubles as the reachability probe). */
  systemStats(signal) {
    return this.request('/system_stats', { timeoutMs: 8000, signal })
  }

  /** GET /queue */
  queue(signal) {
    return this.request('/queue', { timeoutMs: 10000, signal })
  }

  /** GET /models — the list of model folder names, as an array of strings. */
  async modelFolders(signal) {
    const data = await this.request('/models', { timeoutMs: 15000, signal })
    if (Array.isArray(data)) return data.filter((item) => typeof item === 'string')
    if (data !== null && typeof data === 'object') return Object.keys(data)
    return []
  }

  /** GET /models/{folder} — file names inside one model folder. */
  async modelFolder(folder, signal) {
    const data = await this.request(`/models/${encodeURIComponent(folder)}`, { timeoutMs: 15000, signal })
    return Array.isArray(data) ? data : []
  }

  /**
   * GET /object_info, cached for a few minutes per base URL.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @param {boolean} [force] - bypass the cache.
   */
  async objectInfo(signal, force = false) {
    const cached = objectInfoCache.get(this.baseUrl)
    if (!force && cached !== undefined && Date.now() - cached.at < OBJECT_INFO_TTL_MS) return cached.data
    if (!force && cached !== undefined && cached.inflight !== undefined) return cached.inflight
    const inflight = this.request('/object_info', { timeoutMs: 120000, signal })
      .then((data) => {
        objectInfoCache.set(this.baseUrl, { at: Date.now(), data })
        return data
      })
      .catch((error) => {
        if (cached === undefined) objectInfoCache.delete(this.baseUrl)
        throw error
      })
    objectInfoCache.set(this.baseUrl, { at: cached?.at ?? 0, data: cached?.data, inflight })
    return inflight
  }

  /**
   * GET /object_info/{node} — the schema of exactly one node class.
   * @param {string} node - class_type name.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object | undefined>} the node entry, or undefined when unknown.
   */
  async nodeInfo(node, signal) {
    try {
      const data = await this.request(`/object_info/${encodeURIComponent(node)}`, { timeoutMs: 20000, signal })
      if (data !== null && typeof data === 'object') return data[node]
      return undefined
    } catch (error) {
      if (error instanceof ComfyUIError && error.status === 404) return undefined
      throw error
    }
  }

  /** POST /prompt — enqueue an API-format workflow. */
  submit(workflow, options = {}) {
    const body = { prompt: workflow, client_id: options.clientId }
    if (options.extraData !== undefined) body.extra_data = options.extraData
    return this.request('/prompt', {
      method: 'POST',
      body,
      timeoutMs: options.timeoutMs ?? 30000,
      signal: options.signal,
    })
  }

  /** GET /history/{prompt_id} */
  async history(promptId, signal) {
    const data = await this.request(`/history/${encodeURIComponent(promptId)}`, { timeoutMs: 15000, signal })
    if (data === null || typeof data !== 'object') return undefined
    return data[promptId]
  }

  /** GET /history?max_items=N — the most recent entries (object keyed by id). */
  async recentHistory(maxItems = 5, signal) {
    const data = await this.request(`/history?max_items=${Math.max(1, Math.floor(maxItems))}`, {
      timeoutMs: 15000,
      signal,
    })
    return data !== null && typeof data === 'object' ? data : {}
  }

  /**
   * Poll /history until the prompt settles.
   * @param {string} promptId - id returned by submit().
   * @param {object} options - timeout, poll interval, caller signal, progress hook.
   * @returns {Promise<object>} the settled history entry (success or execution error).
   */
  async waitFor(promptId, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 600000
    const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : 1000
    const startedAt = Date.now()
    for (;;) {
      if (options.signal?.aborted === true) throw new CancelledError()
      const entry = await this.history(promptId, options.signal)
      if (entry !== undefined) {
        const status = entry.status
        if (status?.completed === true || status?.status_str === 'error' || status?.status_str === 'success') return entry
        if (entry.outputs !== undefined && Object.keys(entry.outputs).length > 0 && status === undefined) return entry
      }
      if (Date.now() - startedAt > timeoutMs) throw new TimeoutError(`等待 ComfyUI 生成超时（${Math.round(timeoutMs / 1000)}s）`)
      options.onTick?.(Date.now() - startedAt)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs))
    }
  }

  /** POST /interrupt — stop the currently executing prompt. */
  interrupt(signal) {
    return this.request('/interrupt', { method: 'POST', body: {}, timeoutMs: 10000, signal })
  }

  /** POST /queue { clear: true } — drop the pending queue. */
  clearQueue(signal) {
    return this.request('/queue', { method: 'POST', body: { clear: true }, timeoutMs: 10000, signal })
  }

  /** POST /queue { delete: [id...] } — drop specific pending prompts. */
  deleteQueue(promptIds, signal) {
    return this.request('/queue', { method: 'POST', body: { delete: promptIds }, timeoutMs: 10000, signal })
  }

  /** POST /free — unload models and/or free memory. */
  free({ unloadModels = true, freeMemory = true } = {}, signal) {
    return this.request('/free', {
      method: 'POST',
      body: { unload_models: unloadModels, free_memory: freeMemory },
      timeoutMs: 15000,
      signal,
    })
  }

  /** Absolute /view URL for one output file. */
  viewUrl({ filename, subfolder = '', type = 'output' }) {
    const params = new URLSearchParams({ filename, subfolder, type })
    return this.url(`/view?${params.toString()}`)
  }

  /** Download one output file through /view. */
  async fetchOutput({ filename, subfolder = '', type = 'output' }, signal) {
    const params = new URLSearchParams({ filename, subfolder, type })
    const budget = 120000
    const timeoutSignal = AbortSignal.timeout(budget)
    let response
    try {
      response = await fetch(this.url(`/view?${params.toString()}`), {
        signal: signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal]),
      })
    } catch (error) {
      throw failureFor(error, this.url('/view'), budget, timeoutSignal, signal)
    }
    if (!response.ok) {
      throw new ComfyUIError(`下载输出文件失败：HTTP ${response.status}（${filename}）`, { status: response.status })
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    return { data: buffer, mediaType: response.headers.get('content-type') ?? 'application/octet-stream' }
  }

  /**
   * POST /upload/image — copy a workspace image into ComfyUI's input directory.
   * @param {object} options - bytes, filename, optional subfolder, overwrite flag.
   * @returns {Promise<{name: string, subfolder: string, type: string}>} the LoadImage value.
   */
  async uploadImage({ data, filename, subfolder = '', overwrite = true, signal }) {
    const form = new FormData()
    form.append('image', new Blob([data]), filename)
    form.append('overwrite', overwrite ? 'true' : 'false')
    if (subfolder !== '') form.append('subfolder', subfolder)
    const result = await this.request('/upload/image', {
      method: 'POST',
      body: form,
      timeoutMs: 120000,
      signal,
    })
    return {
      name: result?.name ?? filename,
      subfolder: result?.subfolder ?? subfolder,
      type: result?.type ?? 'input',
    }
  }
}

/** Format a byte count as a human-readable string. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
