// Microsoft Store variant of electron-builder.yml.
//
// The Store package must carry the Partner Center-assigned identity and be
// UNSIGNED: Microsoft re-signs it at ingestion, and the Store publisher CN is
// not a certificate we hold, so signing it locally is neither possible nor
// wanted. electron-builder produces an unsigned "Windows Store only build" when
// no signing cert resolves, which requires `win.signtoolOptions` to be a real
// null. That cannot be expressed via a CLI `-c` override (which yields the
// string "null" and fails schema validation), hence this small JS config.
//
// It loads electron-builder.yml as the single source of truth and applies only
// the Store deltas, so the sideload and Store builds can never drift.
//
// js-yaml is safe to require here without declaring it as a direct dependency:
// electron-builder itself uses js-yaml to parse electron-builder.yml, so it is
// always present in node_modules whenever this config is loaded.
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const config = yaml.load(fs.readFileSync(path.join(__dirname, "electron-builder.yml"), "utf8"));

// Store-assigned product identity (Partner Center → Product identity). These are
// public identifiers, not secrets. For reference: Package Family Name
// Silverdaw.Silverdaw_zd9z44xesv7a2, Package SID
// S-1-15-2-464190330-823634313-3472132431-2922889406-4230211236-3977782664-913685759,
// Store ID 9N8T25L0462F.
config.appx.identityName = "Silverdaw.Silverdaw";
config.appx.publisher = "CN=E964BA15-3E84-409B-A15B-C19944DB8168";
config.appx.publisherDisplayName = "Silverdaw";

// Unsigned — Microsoft signs at ingestion. Real null, not the CLI string "null".
config.win.signtoolOptions = null;

// Store submission needs only the .appx (no portable zip), under a distinct
// name so it sits alongside the signed sideload package without overwriting it.
config.win.target = [{ target: "appx", arch: ["x64"] }];
config.win.artifactName = "${productName}-${version}-store.${ext}";

module.exports = config;
