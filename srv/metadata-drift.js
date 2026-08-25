'use strict';

/**
 * The app never reads $metadata at runtime: both remote services are compiled from a copy checked
 * into srv/external, because `as projection on` is resolved by the CDS compiler and `mbt build`
 * runs offline. That copy going stale is therefore silent — a property dropped from the live
 * service surfaces as "Resource not found for the segment" in front of a user, and a property
 * added there simply never arrives.
 *
 * This compares the two and says so in the log. It changes nothing else: it never edits the model,
 * never fails startup, and an unreachable S/4 is a debug line, not an error.
 */

const path = require('path');

// Only what the app actually reads. A full diff of API_BUSINESS_PARTNER is 65 entity sets of which
// it touches nine, and a report nobody finishes reading is the same as no report.
function watchedSets({ maintenanceEntities = {}, valueHelpEntities = [], cviConfigSets = [] } = {}) {
  return {
    API_BUSINESS_PARTNER: [
      'A_BusinessPartner',
      ...Object.values(maintenanceEntities).map((entry) => entry.remote)
    ].filter(Boolean),
    // The projection is renamed to avoid a clash; the remote set is the one to ask about.
    // CviConfigService projects on the same service; its sets are already remote names.
    ZSRVB_MDMLIGHT_VH: [
      ...valueHelpEntities.map(
        (name) => (name === 'BusinessPartnerRoleCodes' ? 'BusinessPartnerRoles' : name)
      ),
      ...cviConfigSets
    ]
  };
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(tag);
  return match ? match[1] : null;
}

/**
 * Deliberately a regex reader rather than an XML parser: the input is gateway-generated EDMX, the
 * question is only which sets and properties exist, and neither service is worth a dependency.
 */
function parseMetadata(xml = '') {
  const source = String(xml || '');
  const propertiesByType = new Map();
  const types = /<EntityType\b([^>]*)>([\s\S]*?)<\/EntityType>/gu;
  for (let type = types.exec(source); type; type = types.exec(source)) {
    const name = attribute(type[1], 'Name');
    if (!name) continue;
    const properties = new Set();
    const declarations = /<Property\b([^>]*)\/?>/gu;
    for (let property = declarations.exec(type[2]); property; property = declarations.exec(type[2])) {
      const propertyName = attribute(property[1], 'Name');
      if (propertyName) properties.add(propertyName);
    }
    propertiesByType.set(name, properties);
  }

  const entitySets = new Map();
  const sets = /<EntitySet\b([^>]*)\/?>/gu;
  for (let set = sets.exec(source); set; set = sets.exec(source)) {
    const name = attribute(set[1], 'Name');
    if (!name) continue;
    // EntityType carries the namespace; the type name is the last segment.
    const typeName = String(attribute(set[1], 'EntityType') || '').split('.').pop();
    entitySets.set(name, propertiesByType.get(typeName) || new Set());
  }
  return { entitySets };
}

const sorted = (values) => [...values].sort();

/**
 * Direction matters, so the two are kept apart rather than counted together. Something the local
 * copy has and the live service does not is a read that fails today. Something only the live
 * service has means the copy is behind, which costs nothing until someone wants the field.
 */
function compareMetadata(local, live, watched = []) {
  const scope = watched.length
    ? watched
    : sorted(new Set([...local.entitySets.keys(), ...live.entitySets.keys()]));

  const goneSets = [];
  const newSets = [];
  const goneProperties = [];
  const newProperties = [];

  for (const name of scope) {
    const here = local.entitySets.get(name);
    const there = live.entitySets.get(name);
    if (here && !there) { goneSets.push(name); continue; }
    if (!here && there) { newSets.push(name); continue; }
    if (!here && !there) continue;
    const gone = sorted([...here].filter((property) => !there.has(property)));
    const added = sorted([...there].filter((property) => !here.has(property)));
    if (gone.length) goneProperties.push({ entitySet: name, properties: gone });
    if (added.length) newProperties.push({ entitySet: name, properties: added });
  }

  return {
    goneSets: sorted(goneSets),
    newSets: sorted(newSets),
    goneProperties,
    newProperties,
    // Nothing watched exists on either side — usually a renamed set, and worth not reporting as "in
    // step", which is what an empty diff would otherwise say.
    unknown: scope.filter((name) => !local.entitySets.has(name) && !live.entitySets.has(name))
  };
}

function describeDrift(service, diff, importCommand) {
  const warnings = [];
  const notes = [];

  for (const name of diff.goneSets) {
    warnings.push(`entity set ${name} is in the local copy but not in the live service`);
  }
  for (const { entitySet, properties } of diff.goneProperties) {
    warnings.push(`${entitySet} no longer exposes ${properties.join(', ')}`);
  }
  for (const name of diff.unknown) {
    warnings.push(`entity set ${name} is watched but exists in neither the local copy nor the live service`);
  }
  for (const name of diff.newSets) {
    notes.push(`the live service has entity set ${name}, the local copy does not`);
  }
  for (const { entitySet, properties } of diff.newProperties) {
    notes.push(`${entitySet} gained ${properties.join(', ')}`);
  }

  const lines = [];
  // The point of the whole check: the reader has to know what to run, not just that something is off.
  if (warnings.length) {
    lines.push({
      level: 'warn',
      message: `[metadata] ${service} has drifted and reads may already be failing — ${warnings.join('; ')}. `
        + `Re-import with \`${importCommand}\` and commit srv/external.`
    });
  }
  if (notes.length) {
    lines.push({
      level: 'info',
      message: `[metadata] The local copy of ${service} is behind: ${notes.join('; ')}. `
        + `Harmless until a field is needed — re-import with \`${importCommand}\` to pick it up.`
    });
  }
  return lines;
}

// Both the destination and the path already live in package.json; reading them back is what keeps
// this from becoming a second copy of the connection settings.
function serviceTargets(requires = {}, watched = {}) {
  return Object.entries(requires)
    .filter(([, config]) => String(config?.kind || '').startsWith('odata')
      && config?.credentials?.destination
      && typeof config?.model === 'string')
    .map(([service, config]) => ({
      service,
      destination: config.credentials.destination,
      // The trailing slash matters: gateway 404s on a doubled one.
      url: `${String(config.credentials.path || `/${service}`).replace(/\/$/u, '')}/$metadata`,
      edmx: `${path.resolve(config.model)}.edmx`,
      watched: watched[service] || []
    }));
}

async function checkService(target, { executeHttpRequest, readFile, log, timeout, importCommand }) {
  let localXml;
  try {
    localXml = await readFile(target.edmx, 'utf8');
  } catch (error) {
    // Nothing to compare against is a build problem, not a drift problem — say which.
    log.debug(`[metadata] No local copy of ${target.service} at ${target.edmx}: ${error.message}`);
    return null;
  }

  let liveXml;
  try {
    const response = await executeHttpRequest(
      { destinationName: target.destination },
      { method: 'GET', url: target.url, timeout }
    );
    liveXml = typeof response?.data === 'string' ? response.data : String(response?.data || '');
  } catch (error) {
    // Local dev has no destination and this must never read as a finding. Debug, and move on.
    log.debug(`[metadata] Could not read ${target.service} $metadata: ${error.message}`);
    return null;
  }

  const live = parseMetadata(liveXml);
  if (!live.entitySets.size) {
    log.debug(`[metadata] ${target.service} $metadata came back with no entity sets — not comparing`);
    return null;
  }

  const diff = compareMetadata(parseMetadata(localXml), live, target.watched);
  const lines = describeDrift(target.service, diff, importCommand(target.service));
  for (const line of lines) log[line.level](line.message);
  if (!lines.length) log.debug(`[metadata] ${target.service} matches the local copy`);
  return { service: target.service, diff, lines };
}

const IMPORT_COMMANDS = Object.freeze({
  API_BUSINESS_PARTNER: 'npm run import:bp',
  ZSRVB_MDMLIGHT_VH: 'npm run import:valuehelp'
});

/**
 * Best effort by construction: every failure path logs at debug and returns, because a check that
 * can delay or break startup is worse than the staleness it reports.
 */
async function checkMetadataDrift({
  requires = {},
  maintenanceEntities,
  valueHelpEntities,
  cviConfigSets,
  executeHttpRequest,
  readFile,
  log = console,
  timeout = 30000
} = {}) {
  const targets = serviceTargets(requires, watchedSets({ maintenanceEntities, valueHelpEntities, cviConfigSets }));
  const results = [];
  for (const target of targets) {
    try {
      const result = await checkService(target, {
        executeHttpRequest,
        readFile,
        log,
        timeout,
        importCommand: (service) => IMPORT_COMMANDS[service] || 'cds import'
      });
      if (result) results.push(result);
    } catch (error) {
      log.debug(`[metadata] The drift check for ${target.service} failed: ${error.message}`);
    }
  }
  return results;
}

module.exports = {
  watchedSets,
  parseMetadata,
  compareMetadata,
  describeDrift,
  serviceTargets,
  checkMetadataDrift,
  IMPORT_COMMANDS
};
