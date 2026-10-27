// Optional helper: adds the Send SMS tab / text history section to forms you already use.
//
//   node scripts/add-to-forms.mjs --org https://yourorg.crm.dynamics.com \
//        --contact-form all [--conversation-forms all] [--remove]
//
// "all" = every main form of that table that agents can open, except portal / web / mobile / customer-card / embedded
// forms and the "Contact - Agent SMS" form that ships with the solution. You can also give form names, comma separated.
//
// Authentication: Azure CLI (az login) by default, or set DATAVERSE_TOKEN to a bearer token for the org.
// The script is idempotent. It changes the forms you name (unmanaged customization layer) and publishes them.
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i > -1 ? args[i + 1] : d; };
const ORG = (opt("org") || "").replace(/\/$/, "");
const CONTACT_FORMS = (opt("contact-form") || "").split(",").map((s) => s.trim()).filter(Boolean);
const CONVERSATION_FORMS = (opt("conversation-forms") || "").split(",").map((s) => s.trim()).filter(Boolean);
const REMOVE = args.includes("--remove");
if (!ORG || (!CONTACT_FORMS.length && !CONVERSATION_FORMS.length)) {
  console.error('Usage: node scripts/add-to-forms.mjs --org <url> [--contact-form "<form name>[,<form name>]"] [--conversation-forms "<name>,<name>"] [--remove]');
  process.exit(1);
}

const token = process.env.DATAVERSE_TOKEN || execSync(`az account get-access-token --resource ${ORG} --query accessToken -o tsv`, { encoding: "utf8", shell: true }).trim();
const API = ORG + "/api/data/v9.2/";
async function call(method, path, body) {
  const r = await fetch(API + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json", "OData-Version": "4.0" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

const TAB = "tab_asms";
const SECTION = "asms_history_section";
const control = (id, url) => `<control id="${id}" classid="{9FDF5F91-88B1-47f4-AD53-C11EFC01A01D}"><parameters><Url>${url}</Url><PassParameters>false</PassParameters><Security>false</Security><Scrolling>auto</Scrolling><Border>false</Border></parameters></control>`;
const rows = (n) => "<row />".repeat(n);

const contactTab = () => `<tab name="${TAB}" id="{a5a50001-0000-4000-8000-0000000000a1}" IsUserDefined="1" expanded="true" showlabel="true"><labels><label description="Send SMS" languagecode="1033" /></labels><columns><column width="100%"><sections><section name="${TAB}_section" id="{a5a50001-0000-4000-8000-0000000000a2}" IsUserDefined="1" showlabel="false" showbar="false" columns="1"><labels><label description="Send SMS" languagecode="1033" /></labels><rows><row><cell id="{a5a50001-0000-4000-8000-0000000000a3}" showlabel="false" colspan="1" rowspan="20"><labels><label description="Send SMS" languagecode="1033" /></labels>${control("WebResource_asms_contact", "asms_/contact.html")}</cell></row>${rows(19)}</rows></section></sections></column></columns></tab>`;

const historySection = () => `<section name="${SECTION}" id="{a5a50001-0000-4000-8000-0000000000b1}" IsUserDefined="1" showlabel="true" showbar="false" columns="1"><labels><label description="Text message history" languagecode="1033" /></labels><rows><row><cell id="{a5a50001-0000-4000-8000-0000000000b2}" showlabel="false" colspan="1" rowspan="22"><labels><label description="Text message history" languagecode="1033" /></labels>${control("WebResource_asms_history", "asms_/history.html")}</cell></row>${rows(21)}</rows></section>`;

const strip = (xml) => xml
  .replace(new RegExp(`<tab name="${TAB}"[\\s\\S]*?</tab>`), "")
  .replace(new RegExp(`<section name="${SECTION}"[\\s\\S]*?</section>`), "");

const SKIP = /portal|web form|mobile|card|in context|agent sms|profile cases|timelinewall|interactive experience/i;
async function patchForm(entity, name, edit) {
  const all = name.toLowerCase() === "all";
  const filter = `objecttypecode eq '${entity}' and type eq 2` + (all ? "" : ` and name eq '${name.replace(/'/g, "''")}'`);
  let found = (await call("GET", `systemforms?$filter=${encodeURIComponent(filter)}&$select=formid,name,formxml`)).value;
  if (all) found = found.filter((f) => !SKIP.test(f.name));
  if (!found.length) { console.log(`! form not found: ${entity} / ${name}`); return false; }
  for (const f of found) {
    const xml = edit(strip(f.formxml));
    await call("PATCH", `systemforms(${f.formid})`, { formxml: xml });
    console.log(`${REMOVE ? "removed from" : "updated"}: ${entity} / ${f.name}`);
  }
  return true;
}

const publish = [];
if (CONTACT_FORMS.length) {
  let any = false;
  for (const name of CONTACT_FORMS) {
    any = (await patchForm("contact", name, (xml) => {
      if (REMOVE) return xml;
      const i = xml.lastIndexOf("</tabs>");
      if (i < 0) throw new Error("unexpected form XML (no </tabs>)");
      return xml.slice(0, i) + contactTab() + xml.slice(i);
    })) || any;
  }
  if (any) publish.push("contact");
}
if (CONVERSATION_FORMS.length) {
  let any = false;
  for (const name of CONVERSATION_FORMS) {
    any = (await patchForm("msdyn_ocliveworkitem", name, (xml) => {
      if (REMOVE) return xml;
      const m = /<column\b[^>]*>\s*<sections>/.exec(xml);
      if (!m) throw new Error("unexpected form XML (no sections)");
      const at = m.index + m[0].length;
      return xml.slice(0, at) + historySection() + xml.slice(at);
    })) || any;
  }
  if (any) publish.push("msdyn_ocliveworkitem");
}
if (publish.length) {
  await call("POST", "PublishXml", { ParameterXml: `<importexportxml><entities>${publish.map((e) => `<entity>${e}</entity>`).join("")}</entities></importexportxml>` });
  console.log("published");
}
