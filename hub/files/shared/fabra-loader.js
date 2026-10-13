// Shivo Labs animation kit: fabraLoader(kind, size) (also shivoLoader) returns the HTML for the animated mark.
// The mark leans 15deg and the tip (top-left tile) leads: tiles are listed tails first, tip last.
// Kinds: think, read, write, edit, search, run, web, plan, agent, look, wait, git.
const FABRA_KINDS = {
  think: "Thinking", read: "Reading", write: "Writing", edit: "Editing", search: "Searching", run: "Running a command",
  web: "Web search", plan: "Planning", agent: "Helper agent", look: "Checking in the browser", wait: "Waiting for you", git: "Git work",
};
function fabraLoader(kind = "think", size = 18, light = false) {
  const T = [[0, 46, 2, 0], [46, 0, 0, 2], [0, 23, 1, 0], [23, 0, 0, 1], [23, 23, 1, 1], [0, 0, 0, 0]];
  const PATH = [0, 2, 4, 3, 1, 5];
  const B = (x, y, cls = "", st = "") => `<div class="b ${cls}" style="left:${x}px;top:${y}px;${st}"></div>`;
  const all = (fn) => T.map(([x, y, r, c], i) => { const [cls, st] = fn(r, c, i); return B(x, y, cls, st); }).join("");
  const S = {
    think: () => all((r, c) => ["", `animation-delay:${(2 - r - c) * .16}s`]),
    read: () => all((r, c, i) => ["", `animation-delay:${i * .32}s`]),
    write: () => T.map(([x, y], i) => B(x, y) + B(x, y, "ink", `animation-delay:${-3 + i * .32}s`)).join(""),
    edit: () => all((r, c, i) => [i === 4 ? "x" : i === 5 ? "lit" : "", ""]),
    search: () => all(() => ["", ""]) + `<div class="lens"></div>`,
    run: () => all((r, c, i) => i === 5 ? ["cur", ""] : ["", `animation-delay:${i * .18}s`]),
    web: () => all((r, c) => ["", `animation-delay:${(2 - Math.max(r, c)) * .28}s`]),
    plan: () => all((r, c, i) => ["", `animation-delay:${i * .3}s`]),
    agent: () => all((r, c, i) => ["", `animation-delay:${PATH.indexOf(i) * .25}s`]),
    look: () => all((r, c) => ["", `animation-delay:${c * .22}s`]),
    wait: () => all((r, c, i) => [i === 5 ? "lit hop" : "", ""]),
    git: () => all((r, c, i) => ["", i === 5 ? "opacity:.35" : ""]) + B(46, 46, "gh") + B(0, 0, "lit m"),
  };
  if (!S[kind]) kind = "think";
  return `<div class="fk${light ? " light" : ""}" data-k="${kind}" style="width:${size}px;height:${size}px"><div class="st" style="transform:scale(${size / 64}) translate(32px,32px) rotate(15deg) translate(-32px,-32px)">${S[kind]()}</div></div>`;
}
if (typeof module !== "undefined") module.exports = { fabraLoader, shivoLoader: fabraLoader, FABRA_KINDS };
