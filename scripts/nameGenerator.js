/**
 * fate-on-the-table — trigram name generator (adapted from Token Mold).
 * Pure module, no Foundry globals.
 */

/**
 * Weighted random choice — roulette by sum of weights.
 * Exact port of Token Mold's #chooseWeighted (1:1).
 * @param {Record<string, number>} weights  key -> weight
 * @returns {string|undefined} chosen key or undefined if empty
 */
export function chooseWeighted(weights) {
  if (!weights || typeof weights !== "object") return undefined;
  const keys = Object.keys(weights);
  if (keys.length === 0) return undefined;
  const vals = Object.values(weights);
  // sum — original used reduce without init; we guard empty above and use init 0 for safety (same result for non-empty)
  let sum = 0;
  try {
    sum = vals.reduce((accum, elem) => accum + elem, 0);
  } catch {
    return undefined;
  }
  if (!Number.isFinite(sum) || sum <= 0) return undefined;
  let accum = 0;
  // cumulative array
  const cum = vals.map((elem) => (accum = elem + accum));
  const rand = Math.random() * sum;
  // original: keys[ vals.filter(elem => elem <= rand).length ]
  const idx = cum.filter((elem) => elem <= rand).length;
  // clamp: if idx >= keys.length due to floating edge, pick last
  if (idx >= keys.length) return keys[keys.length - 1];
  return keys[idx];
}

/**
 * Change case per mapping strings (1:1 with Token Mold #changeCase).
 * @param {string} txt
 * @param {string} fromCase
 * @param {string} toCase
 * @returns {string}
 */
export function changeCase(txt, fromCase, toCase) {
  let res = "";
  for (const c of txt) {
    const loc = fromCase.indexOf(c);
    if (loc < 0) {
      res = res + c;
    } else {
      res = res + toCase[loc];
    }
  }
  return res;
}

/**
 * Generate a random name from a trigram dict.
 * Port of Token Mold pickNewName (1:1) — trigram model.
 * @param {object} dict  { upper, lower, beg, mid, end, all }
 * @param {{min?:number, max?:number}} [opts]
 * @returns {string}
 */
export function pickNewName(dict, { min = 6, max = 9 } = {}) {
  if (!dict || typeof dict !== "object") throw new Error("dict required");
  const upper = dict.upper ?? "";
  const lower = dict.lower ?? "";
  const beg = dict.beg ?? {};
  const mid = dict.mid ?? {};
  const end = dict.end ?? {};
  const all = dict.all ?? {};

  let minLen = Math.floor(Number(min));
  let maxLen = Math.floor(Number(max));
  if (!Number.isFinite(minLen)) minLen = 6;
  if (!Number.isFinite(maxLen)) maxLen = 9;
  // clamp to reasonable bounds (task says 3..15 but keep flexible)
  if (minLen < 1) minLen = 1;
  if (maxLen < 1) maxLen = 1;
  if (minLen > maxLen) {
    const tmp = minLen;
    minLen = maxLen;
    maxLen = tmp;
  }

  const nameLength = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;

  let newName = chooseWeighted(beg);
  // fallback if beg empty — try all flat? mimic original: it would return undefined and loop would fail.
  // We keep original behaviour: if no start, return empty string.
  if (!newName) {
    // Attempt fallback: pick from 'all' keys? But original would just have undefined newName and crash on slice.
    // For safety, return empty.
    return "";
  }

  const ltrs = (x, y, b) =>
    x in b && y in b[x] && Object.keys(b[x][y]).length > 0 ? b[x][y] : false;

  for (let i = 4; i <= nameLength; i++) {
    const c1 = newName.slice(-2, -1);
    const c2 = newName.slice(-1);
    const br = i === nameLength ? end : mid;
    // use original fallback chain: br -> all
    const candidate = ltrs(c1, c2, br) || ltrs(c1, c2, all) || null;
    if (!candidate) {
      break;
    }
    // shallow copy to avoid mutating original dict (original deletes in-place)
    const c3 = { ...candidate };
    if (c1 === c2 && c1 in c3) {
      delete c3[c1];
    }
    if (Object.keys(c3).length === 0) {
      break;
    }
    const next = chooseWeighted(c3);
    if (!next) break;
    newName = newName + next;
  }

  if (!newName) return "";
  // original: newName[0] + changeCase(newName.slice(1), upper, lower)
  // upper contains capital letters, lower the same in lower case
  const first = newName[0] ?? "";
  const rest = newName.slice(1);
  return first + changeCase(rest, upper, lower);
}
