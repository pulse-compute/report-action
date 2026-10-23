import { Pulse } from '@pulse-compute/pulse'
const app = new Pulse({ auto: true })
app.get('/health', async ctx => ctx.json({ ok: true }))
export default app

// RA-02 hosted retained-baseline validation candidate.
