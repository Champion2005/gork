import { Page } from './page'
import { renderToReadableStream } from 'react-dom/server'
import { addFact, deleteFact, editFact, load } from '../bot/memory'
const { outputs } = await Bun.build({ entrypoints: ['./site/page.tsx'], target: 'browser' })
const js = await outputs[0].text()

const parseJsonBody = async (req: Request): Promise<Record<string, unknown> | null> => {
  try {
    const body = await req.json()
    if (typeof body === 'object' && body !== null) return body as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

const getString = (body: Record<string, unknown>, key: string) =>
  typeof body[key] === 'string' ? body[key].trim() : ''

console.log('server at :6767')
Bun.serve({
  port: 6767,
  hostname: '0.0.0.0',
  fetch: async (req) => {
    const path = new URL(req.url).pathname

    if (path == '/dist.js') return new Response(js, { headers: { 'Content-Type': 'text/javascript' } })
    if (path == '/load') return Response.json(load())

    if (path == '/add' || path == '/delete' || path == '/edit') {
      if (req.method != 'POST') return new Response('Method not allowed', { status: 405 })

      const body = await parseJsonBody(req)
      if (!body) return new Response('Invalid JSON payload', { status: 400 })

      if (path == '/add') {
        const user = getString(body, 'user')
        const fact = getString(body, 'fact')
        if (!user || !fact) return new Response('Both "user" and "fact" are required', { status: 400 })
        addFact({ user, fact })
      } else if (path == '/delete') {
        const user = getString(body, 'user')
        const fact = getString(body, 'fact')
        if (!user || !fact) return new Response('Both "user" and "fact" are required', { status: 400 })
        deleteFact({ user, fact })
      } else {
        const user = getString(body, 'user')
        const oldFact = getString(body, 'oldFact')
        const newFact = getString(body, 'newFact')
        if (!user || !oldFact || !newFact) {
          return new Response('"user", "oldFact", and "newFact" are required', { status: 400 })
        }
        editFact({ user, oldFact, newFact })
      }

      return Response.json({ ok: true })
    }

    return renderToReadableStream(<Page/>, { bootstrapModules: ['/dist.js'] }).then(s => new Response(s))
  }
})
