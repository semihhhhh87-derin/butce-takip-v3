/* eslint-disable @typescript-eslint/no-explicit-any */
export function mergeChanged(base: any, next: any, latest: any): any {
  if (JSON.stringify(base) === JSON.stringify(next))
    return structuredClone(latest);
  if (Array.isArray(next)) {
    if (
      next.every((x) => x && typeof x === "object" && "id" in x) &&
      (base || []).every((x: any) => x && typeof x === "object" && "id" in x)
    ) {
      const baseMap = new Map((base || []).map((x: any) => [String(x.id), x])),
        nextMap = new Map(next.map((x: any) => [String(x.id), x])),
        out = new Map((latest || []).map((x: any) => [String(x.id), x]));
      for (const id of baseMap.keys() as IterableIterator<string>) if (!nextMap.has(id)) out.delete(id);
      for (const [id, value] of nextMap)
        if (
          !baseMap.has(id) ||
          JSON.stringify(baseMap.get(id)) !== JSON.stringify(value)
        )
          out.set(id, structuredClone(value));
      return [...out.values()];
    }
    return structuredClone(next);
  }
  if (next && typeof next === "object") {
    const out = structuredClone(
      latest && typeof latest === "object" ? latest : {},
    );
    for (const k of new Set([
      ...Object.keys(base || {}),
      ...Object.keys(next),
    ])) {
      if (!(k in next)) delete out[k];
      else out[k] = mergeChanged(base?.[k], next[k], latest?.[k]);
    }
    return out;
  }
  return structuredClone(next);
}
