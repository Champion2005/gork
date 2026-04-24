import { Page } from './page'
import { renderToReadableStream } from 'react-dom/server'
import { addFact, deleteFact, editFact, load } from '../bot/memory'
const { outputs } = await Bun.build({ entrypoints: ['./site/page.tsx'], target: 'browser' })
const js = await outputs[0].text()

console.log('server at :6767')
Bun.serve({
  port: 6767,
  hostname: '0.0.0.0',
  fetch: async ({json, url}) => {
    const path  = new URL(url).pathname

    if (path == '/dist.js') return new Response(js, { headers: { 'Content-Type': 'text/javascript' } })
    if (path == '/load') return Response.json(load())
    if (path == '/add') return json().then(addFact).then(() => Response.json(200))
    if (path == '/delete') return json().then(deleteFact).then(() => Response.json(200))
    if (path == '/edit') return json().then(editFact).then(() => Response.json(200))

    return renderToReadableStream(<Page/>, { bootstrapModules: ['/dist.js'] }).then(s => new Response(s))
  }
})