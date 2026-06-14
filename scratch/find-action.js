// Find the LAST $ACTION_ID_xxx hash that appears within the N chars
// preceding a given marker string. Used to extract Next.js server
// action ids from rendered HTML by their associated form's
// distinctive hidden-input value.
const fs = require("fs");
const [, , htmlFile, marker] = process.argv;
const html = fs.readFileSync(htmlFile, "utf8");
const idx = html.indexOf(marker);
if (idx < 0) {
  console.log("MARKER_NOT_FOUND");
  process.exit(1);
}
const before = html.substring(Math.max(0, idx - 2000), idx);
const matches = [...before.matchAll(/\$ACTION_ID_([a-f0-9]+)/g)];
console.log(matches.length ? matches[matches.length - 1][1] : "NO_ACTION_ID_FOUND");
