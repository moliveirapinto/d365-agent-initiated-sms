// Builds the importable Dataverse solution (managed + unmanaged zips) from ./src with no dependencies.
// Usage: node build/build.mjs [--version 1.0.0.0]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const VERSION = arg("version", JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version + ".0");
const SOLUTION = "AgentSmsConsole";

// Fixed ids so that upgrades replace the same components in every environment.
const WEB_RESOURCES = [
  { id: "11a7bf46-3312-44a5-910e-d7f80505df0d", name: "asms_/composer.html", display: "Agent SMS composer", file: "composer.html" },
  { id: "8ac85fce-f4d3-4066-9c57-ef663766a133", name: "asms_/history.html", display: "Agent SMS history", file: "history.html" },
  { id: "9a16c394-dac9-4156-adf9-8588f7e5529e", name: "asms_/contact.html", display: "Agent SMS contact panel", file: "contact.html" },
];
const FORM_ID = "5b9b6d2a-c37d-4674-9231-fe0fe000134f";
const ROLE_ID = "ae5b683a-122d-41ad-9775-c0559ac95397";
const ROLE_NAME = "Agent SMS Console User";
// Lets agents record themselves as the contact's preferred agent so replies are routed back to them.
const ROLE_PRIVILEGES = ["Create", "Read", "Write", "Delete", "Append", "AppendTo"].map((p) => `prv${p}msdyn_preferredagent`);

const read = (...p) => readFileSync(join(root, ...p), "utf8").replace(/\r\n/g, "\n");
const br = (id) => "{" + id.toLowerCase() + "}";
const partName = (w) => w.name.replace(/[/.]/g, "") + w.id.toUpperCase();

function solutionXml(managed) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${SOLUTION}</UniqueName>
    <LocalizedNames><LocalizedName description="Agent SMS Console" languagecode="1033" /></LocalizedNames>
    <Descriptions><Description description="Lets a human agent start an SMS conversation from the contact record and see the full text history." languagecode="1033" /></Descriptions>
    <Version>${VERSION}</Version>
    <Managed>${managed ? 1 : 0}</Managed>
    <Publisher>
      <UniqueName>agentsms</UniqueName>
      <LocalizedNames><LocalizedName description="Agent SMS" languagecode="1033" /></LocalizedNames>
      <Descriptions />
      <EMailAddress xsi:nil="true"></EMailAddress>
      <SupportingWebsiteUrl xsi:nil="true"></SupportingWebsiteUrl>
      <CustomizationPrefix>asms</CustomizationPrefix>
      <CustomizationOptionValuePrefix>41530</CustomizationOptionValuePrefix>
      <Addresses />
    </Publisher>
    <RootComponents>
      <RootComponent type="1" schemaName="contact" behavior="1" />
      <RootComponent type="20" id="${br(ROLE_ID)}" behavior="0" />
${WEB_RESOURCES.map((w) => `      <RootComponent type="61" schemaName="${w.name}" behavior="0" />`).join("\n")}
    </RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>`;
}

function customizationsXml() {
  const form = read("src", "contact-form.xml").replace(/^\uFEFF/, "").replace(/<\?xml[^>]*\?>\s*/, "").trim();
  const entities = read("build", "entities.template.xml").replace(/^\uFEFF/, "")
    .replace("{{FORMID}}", br(FORM_ID)).replace("{{FORM}}", form);
  const wr = WEB_RESOURCES.map((w) => `    <WebResource>
      <WebResourceId>${br(w.id)}</WebResourceId>
      <Name>${w.name}</Name>
      <DisplayName>${w.display}</DisplayName>
      <WebResourceType>1</WebResourceType>
      <IntroducedVersion>${VERSION}</IntroducedVersion>
      <IsEnabledForMobileClient>0</IsEnabledForMobileClient>
      <IsAvailableForMobileOffline>0</IsAvailableForMobileOffline>
      <IsCustomizable>1</IsCustomizable>
      <CanBeDeleted>1</CanBeDeleted>
      <IsHidden>0</IsHidden>
      <FileName>/WebResources/${partName(w)}</FileName>
    </WebResource>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  ${entities}
  <Roles>
    <Role id="${br(ROLE_ID)}" name="${ROLE_NAME}">
      <IsCustomizable>1</IsCustomizable>
      <IsAutoAssigned>0</IsAutoAssigned>
      <RolePrivileges>
${ROLE_PRIVILEGES.map((p) => `        <RolePrivilege name="${p}" level="Global" />`).join("\n")}
      </RolePrivileges>
    </Role>
  </Roles>
  <Workflows></Workflows>
  <FieldSecurityProfiles></FieldSecurityProfiles>
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <WebResources>
${wr}
  </WebResources>
  <CustomControls />
  <EntityDataProviders />
  <Languages><Language>1033</Language></Languages>
</ImportExportXml>`;
}

function contentTypes() {
  const o = WEB_RESOURCES.map((w) => `<Override PartName="/WebResources/${partName(w)}" ContentType="application/octet-stream" />`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/octet-stream" />${o}</Types>`;
}

// Minimal zip writer (deflate, fixed timestamp so builds are reproducible).
function zip(entries) {
  const local = [], central = []; let offset = 0;
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8"), raw = Buffer.from(data), comp = deflateRawSync(raw), crc = crc32(raw) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

mkdirSync(join(root, "dist"), { recursive: true });
for (const managed of [false, true]) {
  const entries = [
    ["[Content_Types].xml", contentTypes()],
    ["solution.xml", solutionXml(managed)],
    ["customizations.xml", customizationsXml()],
    ...WEB_RESOURCES.map((w) => ["WebResources/" + partName(w), read("src", w.file)]),
  ];
  const out = join(root, "dist", `${SOLUTION}_${VERSION.replace(/\.0$/, "")}_${managed ? "managed" : "unmanaged"}.zip`);
  writeFileSync(out, zip(entries));
  console.log("built", out);
}
