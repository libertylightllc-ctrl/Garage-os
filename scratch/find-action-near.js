// Find the FIRST $ACTION_ID_xxx that appears AFTER a marker string in
// the HTML — useful when a hidden input name="jobId" value="..." or
// similar marker sits just BEFORE the action ID in the form.
const fs = require("fs");
const [, , htmlFile, marker] = process.argv;
const html = fs.readFileSync(htmlFile, "utf8");
const idx = html.indexOf(marker);
if (idx < 0) {
  console.log("MARKER_NOT_FOUND");
  process.exit(1);
}
const after = html.substring(idx, idx + 2000);
const m = after.match(/\$ACTION_ID_([a-f0-9]+)/);
console.log(m ? m[1] : "NO_ACTION_ID_AFTER_MARKER");
