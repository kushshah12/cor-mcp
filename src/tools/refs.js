// Node-side ref bookkeeping. The page cannot tell a stale ref from a valid
// one — after a re-render the same ref could name a different element — so
// validity is decided here, from what the session saw happen.

export const REF = /^e[1-9]\d*$/;

/** Throws an actionable error unless `ref` is live in the last snapshot. */
export function checkRef(session, ref) {
  const refs = session.refs;
  if (!refs) throw new Error(`No snapshot is current — call cor_snapshot, then use one of its refs.`);
  if (refs.staleBecause) {
    throw new Error(`Ref ${ref} is stale: ${refs.staleBecause} since the last cor_snapshot. Call cor_snapshot again and use the new refs.`);
  }
  const n = REF.test(ref) ? Number(ref.slice(1)) : 0;
  if (n < 1 || n > refs.count) {
    const range = refs.count ? `e1–e${refs.count}` : 'no refs (the page had no interactive elements)';
    throw new Error(`Ref ${ref} does not exist — the last cor_snapshot issued ${range}.`);
  }
}

/** For a page-side 'unknown-ref' / 'detached' result on a ref Node thought was live. */
export function goneError(ref) {
  return new Error(`Ref ${ref} no longer points at an element on the page — it changed since the snapshot. Call cor_snapshot again.`);
}
