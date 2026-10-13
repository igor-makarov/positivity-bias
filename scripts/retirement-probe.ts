import type { Snapshot } from '../src/types.ts';
// Probe worker used only by scripts/retirement-check.ts. It exposes a seed route so
// the check can install a stale cached snapshot, then serve through the real Worker.
import worker, { NewsStore } from '../src/worker.ts';

export class SeedableStore extends NewsStore {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/seed' && request.method === 'POST') {
      this.writeSnapshot(await request.json<Snapshot>());
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}

export default worker;
