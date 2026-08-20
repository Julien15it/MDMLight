/**
 * The library entry point. Nothing loads it today: both consumers take the sources at BUILD time
 * (tools/sync-reuse.js) and resolve them through `resourceRoots`, because a library served from the
 * HTML5 repository would have to be addressed by its version-stamped URL - which is exactly the
 * drift that made the task UI 404 on 2026-08-20. It is kept so the folder is a real UI5 library
 * project: if the runtime story improves, this becomes loadable without moving a file.
 */
sap.ui.define(["sap/ui/core/Lib"], function (Lib) {
  "use strict";

  return Lib.init({
    name: "mdm.md.businesspartner.reuse",
    version: "1.0.0",
    dependencies: ["sap.ui.core", "sap.m", "sap.uxap", "sap.ui.layout"],
    types: [],
    interfaces: [],
    controls: [],
    elements: [],
    noLibraryCSS: true
  });
});
