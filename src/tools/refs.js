// Node-side ref bookkeeping. The page cannot tell a stale ref from a valid
// one — after a re-render the same ref could name a different element — so
// validity is decided here, from what the session saw happen.

export const REF = /^e[1-9]\d*$/;

const num = (ref) => Number(ref.slice(1));

/** Throws an actionable error unless `ref` is live in the current snapshot. */
export function checkRef(session, ref) {
  const refs = session.refs;
  if (!refs) throw new Error(`No snapshot is current — call cor_snapshot, then use one of its refs.`);
  if (refs.staleBecause) {
    throw new Error(`Ref ${ref} is stale: ${refs.staleBecause} since the last cor_snapshot. Call cor_snapshot again and use the new refs.`);
  }
  if (refs.issued.has(ref)) return;
  const issued = [...refs.issued].map(num).sort((a, b) => a - b);
  if (!issued.length) throw new Error(`Ref ${ref} does not exist — the last cor_snapshot issued no refs (the page had no interactive elements).`);
  const range = `e${issued[0]}–e${issued.at(-1)}`;
  // Refs are numbered once per page load and never reused, so a lower number
  // is an old ref, not a different element.
  if (REF.test(ref) && num(ref) < issued[0]) {
    throw new Error(`Ref ${ref} is from an earlier cor_snapshot of this page; the current one issued ${range}.`);
  }
  throw new Error(`Ref ${ref} does not exist — the last cor_snapshot issued ${range}.`);
}

/** For a page-side 'unknown-ref' / 'detached' result on a ref Node thought was live. */
export function goneError(ref) {
  return new Error(`Ref ${ref} no longer points at an element on the page — it changed since the snapshot. Call cor_snapshot again.`);
}
