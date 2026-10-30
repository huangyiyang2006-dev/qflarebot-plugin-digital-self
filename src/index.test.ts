import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import type { ScopedDB } from '@qqbot/sdk'
import plugin, { DEFAULT_MODEL, handle } from './index.js'

/** 内存版 ctx.db：够让锁、历史和「重置」都真的读写，而不是一律返回同一个值 */
function makeDb() {
  const history = new Map<string, string>()
  const locks = new Map<string, number>()
  const db = {
    table: (name: string) => name,
    exec: vi.fn(async () => {}),
    all: vi.fn(async () => []),
    batch: vi.fn(async () => []),
    first: vi.fn(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('FROM {history}')) {
        const stored = history.get(String(params[0]))
        return stored === undefined ? null : { messages: stored }
      }
      return null
    }),
    run: vi.fn(async (sql: string, ...params: unknown[]) => {
      const key = String(params[0])
      if (sql.startsWith('INSERT INTO {locks}')) {
        const now = params[1] as number
        const staleBefore = params[2] as number
        const current = locks.get(key)
        if (current !== undefined && current >= staleBefore) return { changes: 0 }
        locks.set(key, now)
        return { changes: 1 }
      }
      if (sql.startsWith('DELETE FROM {locks}')) { locks.delete(key); return { changes: 1 } }
      if (sql.startsWith('DELETE FROM {history}')) { history.delete(key); return { changes: 1 } }
      if (sql.startsWith('INSERT INTO {history}') || sql.includes('UPDATE SET messages')) {
        history.set(key, String(params[1]))
        return { changes: 1 }
      }
      return { changes: 0 }
    }),
    history,
    locks,
  }
  return db
}

const config = { apiKey: 'test-key', persona: '说话直接', memory: '喜欢阅读', model: 'deepseek-flash' }
let db = makeDb()
const ctx = (overrides: Partial<typeof config> = {}) =>
  createMockContext(plugin, { config: { ...config, ...overrides }, db: db as unknown as ScopedDB })

const ok = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 })

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); db = makeDb() })

describe('数字分身', () => {
  it('仅允许管理员私聊', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await handle({ session: createMockSession({ scene: 'c2c', content: '你好' }), ctx: ctx() })).toBeUndefined()
    expect(await handle({ session: createMockSession({ scene: 'group', isBotAdmin: true, content: '你好' }), ctx: ctx() })).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('默认模型是 deepseek-flash，并关闭思考模式', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => ok('你好呀'))
    vi.stubGlobal('fetch', fetcher)
    const result = await handle({
      session: createMockSession({ scene: 'c2c', isBotAdmin: true, content: '你好' }),
      ctx: ctx({ model: '' }),
    })
    expect(result).toBe('你好呀')
    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string)
    expect(body.model).toBe(DEFAULT_MODEL)
    expect(body.model).toBe('deepseek-flash')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.messages[0].content).toContain('喜欢阅读')
    expect(body.messages.at(-1).content).toBe('你好')
  })

  it('回复后写入历史并释放锁', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok('记住了')))
    await handle({ session: createMockSession({ scene: 'c2c', isBotAdmin: true, content: '我叫小明' }), ctx: ctx() })
    expect(db.history.size).toBe(1)
    expect(JSON.parse([...db.history.values()][0]!)).toEqual([
      { role: 'user', content: '我叫小明' },
      { role: 'assistant', content: '记住了' },
    ])
    // 锁必须清掉，否则下一条消息要等 60 秒 TTL
    expect(db.locks.size).toBe(0)
  })

  it('上一条还在处理时拒绝并发调用，不重复请求模型', async () => {
    let release: (value: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const fetcher = vi.fn(async () => pending)
    vi.stubGlobal('fetch', fetcher)

    const first = handle({ session: createMockSession({ scene: 'c2c', isBotAdmin: true, content: '第一条' }), ctx: ctx() })
    // 让第一条走到占锁之后
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce() })
    const second = await handle({ session: createMockSession({ scene: 'c2c', isBotAdmin: true, content: '第二条' }), ctx: ctx() })

    expect(second).toContain('还在处理中')
    expect(fetcher).toHaveBeenCalledOnce()
    release(ok('第一条的回复'))
    expect(await first).toBe('第一条的回复')
  })

  it('处理接口报错而不泄露密钥，400 时提示模型名', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const gone = await handle({ session: createMockSession({ scene: 'c2c', isBotAdmin: true, content: '你好' }), ctx: ctx() })
    expect(gone).toContain('401')
    expect(gone).not.toContain('test-key')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })))
    const bad = await handle({ session: createMockSession({ scene: 'c2c', isBotAdmin: true, content: '你好' }), ctx: ctx() })
    expect(bad).toContain('模型名称')
    // 失败也要把锁放掉
    expect(db.locks.size).toBe(0)
  })

  it('超时给出明确提示，而不是笼统的失败', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout }))
    const result = await handle({ session: createMockSession({ scene: 'c2c', isBotAdmin: true, content: '你好' }), ctx: ctx() })
    expect(result).toContain('超时')
    expect(db.locks.size).toBe(0)
  })

  it('重置近期对话', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok('好的')))
    await handle({ session: createMockSession({ scene: 'c2c', isBotAdmin: true, content: '你好' }), ctx: ctx() })
    expect(db.history.size).toBe(1)

    const result = await handle({ session: createMockSession({ scene: 'c2c', isBotAdmin: true, content: '/分身重置' }), ctx: ctx() })
    expect(result).toContain('已清除')
    expect(db.history.size).toBe(0)
  })
})
