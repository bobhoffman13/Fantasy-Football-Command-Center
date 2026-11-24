// Tiny max-flow (Edmonds–Karp) for the playoff clinch/elimination checks.
// Graphs here are small (a few dozen nodes, capacities of 1–2), so simplicity wins.

export class FlowGraph {
  constructor(n) {
    this.n = n;
    this.adj = Array.from({ length: n }, () => []);
    this.to = [];
    this.cap = [];
  }

  addEdge(u, v, c) {
    if (c <= 0) return;
    this.adj[u].push(this.to.length); this.to.push(v); this.cap.push(c);
    this.adj[v].push(this.to.length); this.to.push(u); this.cap.push(0);
  }

  maxFlow(s, t) {
    let flow = 0;
    const prevEdge = new Int32Array(this.n);
    for (;;) {
      prevEdge.fill(-1);
      const queue = [s];
      let found = false;
      for (let qi = 0; qi < queue.length && !found; qi++) {
        const u = queue[qi];
        for (const e of this.adj[u]) {
          const v = this.to[e];
          if (this.cap[e] > 0 && v !== s && prevEdge[v] === -1) {
            prevEdge[v] = e;
            if (v === t) { found = true; break; }
            queue.push(v);
          }
        }
      }
      if (!found) return flow;
      let push = Infinity;
      for (let v = t; v !== s; v = this.to[prevEdge[v] ^ 1]) push = Math.min(push, this.cap[prevEdge[v]]);
      for (let v = t; v !== s; v = this.to[prevEdge[v] ^ 1]) {
        this.cap[prevEdge[v]] -= push;
        this.cap[prevEdge[v] ^ 1] += push;
      }
      flow += push;
    }
  }
}
