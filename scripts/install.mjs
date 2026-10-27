// One-command installer for Agent-initiated SMS.
//
//   node scripts/install.mjs --org https://yourorg.crm.dynamics.com [--agents omnichannel | a@x.com,b@x.com]
//
// What it does (every step is safe to run twice):
//   1. checks that the environment has Contact Center / Omnichannel (table msdyn_ocliveworkitem)
//   2. imports the managed solution (downloads the latest release if dist/ has no zip)
//   3. adds the "Send SMS" tab to the Contact form(s) and the text history to the conversation form(s)
//   4. creates the SMS sending configuration for your SMS number (the same one-click setup the Send SMS tab offers)
//   5. gives the "Agent SMS Console User" role to the agents you name
//
// Options:
//   --org <url>                 required. Your environment URL.
//   --agents <list>             "omnichannel" = everyone who has the Omnichannel agent role, or a comma-separated list of e-mails.
//   --contact-forms <names>     Contact forms to extend. Default: "Contact,Customer Form" (the ones that exist).
//   --conversation-forms <n>    Conversation forms to extend. Default: "Active Conversation".
//   --sms-number <+1555...>     SMS number to send from. Only needed if the environment has more than one.
//   --skip-forms                do not touch any form.
//   --zip <path>                use this solution zip instead of dist/ or the latest release.
//   --force                     import even if the same or a newer version is installed.
//   --dry-run                   show what would happen and change nothing.
//
// Sign-in: Azure CLI (az login) or a bearer token in DATAVERSE_TOKEN. You sign in yourself.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i > -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const flag = (n) => args.includes("--" + n);
const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

const ORG = (opt("org") || "").replace(/\/$/, "");
const DRY = flag("dry-run");
if (!ORG) {
  console.error("Usage: node scripts/install.mjs --org https://yourorg.crm.dynamics.com [--agents omnichannel|a@x.com,b@x.com] [--dry-run]");
  process.exit(1);
}

const SOLUTION = "AgentSmsConsole";
const ROLE = "Agent SMS Console User";
const step = (n, t) => console.log(`\n[${n}] ${t}`);
const ok = (t) => console.log("  OK   " + t);
const warn = (t) => console.log("  WARN " + t);
const fail = (t) => { console.error("  FAIL " + t); process.exit(1); };

let token = process.env.DATAVERSE_TOKEN;
if (!token) {
  try {
    token = execSync(`az account get-access-token --resource ${ORG} --query accessToken -o tsv`, { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    fail("Not signed in. Run `az login` with an account that is System Administrator in this environment, then run this again.");
  }
}
const API = ORG + "/api/data/v9.2/";
async function call(method, path, body, extra = {}) {
  const r = await fetch(path.startsWith("http") ? path : API + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json", "OData-Version": "4.0", ...extra },
  });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 400)}`); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : null;
}
const versionGte = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return true;
};

// 1. Preflight
step(1, "Checking the environment");
let who;
try { who = await call("GET", "WhoAmI"); } catch (e) { fail("Cannot reach " + ORG + ". " + e.message); }
ok("Signed in to " + ORG);
try { await call("GET", "EntityDefinitions(LogicalName='msdyn_ocliveworkitem')?$select=LogicalName"); }
catch { fail("This environment has no Conversation table (msdyn_ocliveworkitem). Install Dynamics 365 Contact Center or Omnichannel for Customer Service first."); }
ok("Contact Center / Omnichannel is installed");
try {
  await call("GET", "msdyn_ocoutboundconfigurationes?$top=1&$select=msdyn_name");
  ok("Outbound messaging tables are available");
} catch { warn("Could not read outbound configurations. Outbound messaging may not be enabled yet."); }

// 2. Solution
step(2, "Installing the solution");
let zip = opt("zip");
if (!zip) {
  const dist = join(root, "dist");
  const found = existsSync(dist) ? readdirSync(dist).filter((f) => /_managed\.zip$/.test(f)).sort() : [];
  if (found.length) zip = join(dist, found[found.length - 1]);
}
if (!zip) {
  console.log("  No local zip. Downloading the latest release...");
  const rel = await (await fetch("https://api.github.com/repos/moliveirapinto/d365-agent-initiated-sms/releases/latest", { headers: { "User-Agent": "agent-sms-installer" } })).json();
  const asset = (rel.assets || []).find((a) => /_managed\.zip$/.test(a.name));
  if (!asset) fail("No managed zip found in the latest release. Download it manually and pass --zip <path>.");
  const dir = mkdtempSync(join(tmpdir(), "agentsms-"));
  zip = join(dir, asset.name);
  writeFileSync(zip, Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer()));
}
if (!existsSync(zip)) fail("Solution zip not found: " + zip);
const m = /_(\d+\.\d+\.\d+)_/.exec(zip);
const zipVersion = m ? m[1] + ".0" : "0.0.0.0";
const installed = (await call("GET", `solutions?$filter=uniquename eq '${SOLUTION}'&$select=version`)).value[0];
if (installed && versionGte(installed.version, zipVersion) && !flag("force")) {
  ok(`Already installed (version ${installed.version}). Skipping import (use --force to reinstall).`);
} else if (DRY) {
  ok(`Would import ${zip} (${zipVersion})`);
} else {
  console.log(`  Importing ${zip} ...`);
  try {
    await call("POST", "ImportSolution", {
      CustomizationFile: readFileSync(zip).toString("base64"),
      OverwriteUnmanagedCustomizations: true, PublishWorkflows: true, ImportJobId: randomUUID(),
    });
  } catch (e) { fail("Import failed. " + e.message); }
  ok("Solution imported (version " + zipVersion + ")");
}

// 3. Forms
step(3, "Adding the Send SMS tab and the text history to your forms");
if (flag("skip-forms")) {
  ok("Skipped (--skip-forms). Use the form 'Contact - Agent SMS' or run scripts/add-to-forms.mjs later.");
} else {
  const contactForms = list(opt("contact-forms", "Contact,Customer Form"));
  const convForms = list(opt("conversation-forms", "Active Conversation"));
  if (DRY) {
    ok(`Would add the tab to Contact forms: ${contactForms.join(", ")} and the history to: ${convForms.join(", ")}`);
  } else {
    const r = spawnSync(process.execPath, [
      join(here, "add-to-forms.mjs"), "--org", ORG,
      "--contact-form", contactForms.join(","),
      "--conversation-forms", convForms.join(","),
    ], { stdio: "inherit", env: { ...process.env, DATAVERSE_TOKEN: token } });
    if (r.status !== 0) warn("Adding to the forms failed. You can add the tab by hand, see the README.");
    else ok("Forms updated and published");
  }
}

// 4. Sending configuration (template + outbound configuration), same as the one-click setup in the Send SMS tab
step(4, "Setting up SMS sending");
const TEMPLATE = "Agent SMS - free text", CFG_PREFIX = "Agent SMS", SMS = 192340000;
const cfgs = (await call("GET", `msdyn_ocoutboundconfigurationes?$select=msdyn_name,msdyn_channelid&$filter=${encodeURIComponent(`msdyn_channel eq ${SMS} and statecode eq 0 and startswith(msdyn_name,'${CFG_PREFIX}')`)}`)).value;
if (cfgs.length) {
  ok(`Already set up for ${cfgs.map((c) => c.msdyn_channelid).join(", ")}`);
} else {
  const nums = (await call("GET", `msdyn_ocphonenumbers?$select=msdyn_phonenumber&$orderby=msdyn_phonenumber&$filter=${encodeURIComponent("msdyn_smsoutboundenabled eq true and statecode eq 0")}`)).value.map((n) => n.msdyn_phonenumber);
  let number = opt("sms-number");
  if (!nums.length) {
    warn("No SMS number with outbound enabled was found. Provision an SMS channel first (see the README), then run this again.");
  } else if (!number && nums.length > 1) {
    warn("Several SMS numbers found: " + nums.join(", ") + ". Run again with --sms-number <number> to choose one.");
  } else {
    number = number || nums[0];
    if (!nums.includes(number)) fail(`${number} is not an SMS number with outbound enabled. Available: ${nums.join(", ")}`);
    if (DRY) {
      ok(`Would set up sending from ${number}`);
    } else {
      const id = (r) => /\(([^)]+)\)\s*$/.exec(r.headers.get("OData-EntityId") || "")?.[1];
      const create = async (set, body) => {
        const r = await fetch(API + set, { method: "POST", body: JSON.stringify(body), headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json", "OData-Version": "4.0" } });
        if (!r.ok) throw new Error(`${set}: ${r.status} ${(await r.text()).slice(0, 300)}`);
        return id(r);
      };
      try {
        const langs = (await call("GET", "msdyn_oclanguages?$select=msdyn_oclanguageid,msdyn_localeid&$top=300")).value;
        const lang = langs.find((l) => l.msdyn_localeid === 1033) || langs[0];
        if (!lang) throw new Error("No languages are configured in this environment.");
        let tmpl = (await call("GET", `msdyn_ocsystemmessages?$select=msdyn_ocsystemmessageid&$top=1&$filter=${encodeURIComponent(`msdyn_name eq '${TEMPLATE}'`)}`)).value[0]?.msdyn_ocsystemmessageid;
        if (!tmpl) {
          tmpl = await create("msdyn_ocsystemmessages", {
            msdyn_name: TEMPLATE, msdyn_messagetype: 3, msdyn_streamsource: SMS, msdyn_messagetext: "{message}",
            msdyn_messagedescription: "Used by the Agent SMS panel to send text typed by an agent.",
            "msdyn_defaultlanguage@odata.bind": `/msdyn_oclanguages(${lang.msdyn_oclanguageid})`,
          });
          await create("msdyn_oclocalizationdatas", {
            msdyn_entityname: "msdyn_ocsystemmessage", msdyn_entitycolumnname: "msdyn_messagetext", msdyn_entityrecordid: tmpl,
            msdyn_localizedtext: "{message}", msdyn_defaultlocalizedtext: "{message}", msdyn_languagecode: lang.msdyn_localeid, msdyn_isdefault: true,
            "msdyn_customerlanguageid@odata.bind": `/msdyn_oclanguages(${lang.msdyn_oclanguageid})`,
            "msdyn_systemmessageid@odata.bind": `/msdyn_ocsystemmessages(${tmpl})`,
          });
        }
        const ws = (await call("GET", `msdyn_liveworkstreams?$select=msdyn_liveworkstreamid&$top=1&$filter=${encodeURIComponent(`msdyn_streamsource eq ${SMS} and statecode eq 0`)}`).catch(() => ({ value: [] }))).value[0];
        const body = {
          msdyn_name: `${CFG_PREFIX} - ${number}`, msdyn_channel: SMS, msdyn_channelid: number, msdyn_type: 100000001,
          msdyn_showinactivities: true, msdyn_enablemessagelogging: true,
          "msdyn_messagetemplate@odata.bind": `/msdyn_ocsystemmessages(${tmpl})`,
          "msdyn_defaultlocale@odata.bind": `/msdyn_oclanguages(${lang.msdyn_oclanguageid})`,
        };
        if (ws) body["msdyn_liveworkstreamid@odata.bind"] = `/msdyn_liveworkstreams(${ws.msdyn_liveworkstreamid})`;
        await create("msdyn_ocoutboundconfigurationes", body);
        ok(`Sending is set up from ${number}`);
      } catch (e) { warn("Could not set up sending automatically (" + e.message + "). Open a contact > Send SMS tab and use the one-click setup instead."); }
    }
  }
}
// 5. Roles
step(5, "Giving agents the " + ROLE + " role");
const agents = opt("agents");
if (!agents) {
  warn("No --agents given. Run again with --agents omnichannel (everyone with the Omnichannel agent role) or --agents a@x.com,b@x.com.");
} else {
  let users = [];
  if (agents.toLowerCase() === "omnichannel") {
    const roles = (await call("GET", "roles?$filter=name eq 'Omnichannel agent'&$select=roleid&$expand=systemuserroles_association($select=systemuserid,internalemailaddress,fullname,_businessunitid_value,isdisabled,applicationid)")).value;
    const seen = new Map();
    for (const r of roles) for (const u of r.systemuserroles_association || []) if (!u.isdisabled && !u.applicationid) seen.set(u.systemuserid, u);
    users = [...seen.values()];
    if (!users.length) warn("Nobody has the Omnichannel agent role yet.");
  } else {
    for (const email of list(agents)) {
      const f = (await call("GET", `systemusers?$filter=${encodeURIComponent(`internalemailaddress eq '${email.replace(/'/g, "''")}' or domainname eq '${email.replace(/'/g, "''")}'`)}&$select=systemuserid,internalemailaddress,fullname,_businessunitid_value`)).value;
      if (f.length) users.push(f[0]); else warn("User not found: " + email);
    }
  }
  const roleRows = (await call("GET", `roles?$filter=name eq '${ROLE}'&$select=roleid,_businessunitid_value`)).value;
  if (!roleRows.length) {
    warn(`Role "${ROLE}" not found. The solution may not be installed.`);
  } else {
    for (const u of users) {
      const label = u.fullname || u.internalemailaddress;
      const role = roleRows.find((r) => r._businessunitid_value === u._businessunitid_value) || roleRows[0];
      const has = (await call("GET", `systemusers(${u.systemuserid})/systemuserroles_association?$filter=roleid eq ${role.roleid}&$select=roleid`)).value.length;
      if (has) { ok(`${label} already has the role`); continue; }
      if (DRY) { ok(`Would assign the role to ${label}`); continue; }
      try {
        await call("POST", `systemusers(${u.systemuserid})/systemuserroles_association/$ref`, { "@odata.id": `${API}roles(${role.roleid})` });
        ok(`Role assigned to ${label}`);
      } catch (e) { warn(`Could not assign the role to ${label}: ${e.message}`); }
    }
  }
}

console.log(`
Done. One thing is left, in the browser (about 2 minutes, see the README):
  In Copilot Service admin center turn on Preferred representative routing, and make sure the SMS workstream has no bot.
`);
