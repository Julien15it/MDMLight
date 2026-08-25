'use strict';

// The segment the managed approuter needs in front of an HTML5 app path before it will resolve a
// `destination`-backed route: the destination service instance GUID. See CLAUDE.md, "The task app".

// Lets a hybrid run name one without a real binding, and lets a landscape override a bad lookup.
const OVERRIDE = process.env.UI_PATH_PREFIX || '';

let cached;

function readDestinationInstanceGuid() {
  let services;
  try {
    services = JSON.parse(process.env.VCAP_SERVICES || '{}');
  } catch (error) {
    console.warn('[prefix] VCAP_SERVICES could not be parsed:', error.message);
    return '';
  }
  for (const [group, bindings] of Object.entries(services)) {
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      if (!binding || !binding.instance_guid) continue;
      // The group key is the service label in CF, but a bound instance carries it too.
      if (group === 'destination' || binding.label === 'destination') return binding.instance_guid;
    }
  }
  return '';
}

/**
 * Empty is a legitimate answer - no binding here, which is every local run. The task app treats
 * an empty prefix as "resolve relative to the document root", which is correct standalone.
 */
function uiPathPrefix() {
  if (OVERRIDE) return OVERRIDE;
  if (cached === undefined) cached = readDestinationInstanceGuid();
  return cached;
}

// Tests drive the lookup directly rather than through the module-level cache.
module.exports = { uiPathPrefix, _internals: { readDestinationInstanceGuid } };
