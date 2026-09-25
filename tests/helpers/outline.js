// Expands the snapshot's grouped lines back into one line per element, so a
// test can find `item "X" › button "Buy" [ref=e5]` whichever form was rendered.
//
//   - 3 items, each: button "delete", clickable "Add to cart"
//     - "iPhone 12": e14, e15 [disabled]
// becomes
//   - item "iPhone 12" › button "delete" [ref=e14]
//   - item "iPhone 12" › clickable "Add to cart" [ref=e15] [disabled]
const HEADER = /^(\s*)- \d+ (\w+?)s?, each: (.*)$/;
const ITEM = /^\s*- "(.*)": (e\d+.*)$/;

const controlsOf = (list) => [...list.matchAll(/(\w+)(?: "(.*?)")?(?:, |$)/g)].map((m) => (m[2] !== undefined ? `${m[1]} "${m[2]}"` : m[1]));

export function expandGroups(text) {
  const out = [];
  let group = null;
  for (const line of text.split('\n')) {
    const header = HEADER.exec(line);
    if (header) {
      group = { pad: header[1], type: header[2], controls: controlsOf(header[3]) };
      continue;
    }
    const item = group && ITEM.exec(line);
    if (item && line.startsWith(`${group.pad}  - `)) {
      const refs = item[2].split(/, (?=e\d+)/);
      refs.forEach((r, i) => {
        const [ref, ...marks] = r.split(' ');
        out.push(`${group.pad}- ${group.type} "${item[1]}" › ${group.controls[i]} [ref=${ref}]${marks.length ? ` ${marks.join(' ')}` : ''}`);
      });
      continue;
    }
    group = null;
    out.push(line);
  }
  return out.join('\n');
}
