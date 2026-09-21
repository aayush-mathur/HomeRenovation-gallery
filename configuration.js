"use strict";

// Pure selection logic is shared by the page and Node's regression tests.
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KitchenChoices = api;
})(globalThis, () => {
  function key(configuration, selections) {
    if (!selections || typeof selections !== "object" || Array.isArray(selections)) {
      throw new Error("Selection must be an object.");
    }
    const ids = configuration.options.map((option) => option.id).sort();
    if (Object.keys(selections).length !== ids.length
        || ids.some((id) => !Object.hasOwn(selections, id) || typeof selections[id] !== "boolean")) {
      throw new Error("Selection does not match this configurator's options.");
    }
    return ids.map((id) => `${id}=${selections[id] ? "on" : "off"}`).join("&");
  }

  function variant(configuration, selections) {
    const signature = key(configuration, selections);
    const match = configuration.variants.find((item) => key(configuration, item.selections) === signature);
    if (!match) throw new Error("This combination has not been built.");
    return match;
  }

  function save(configuration, collectionId, selections) {
    variant(configuration, selections);
    return JSON.stringify({
      version: 1, configurationId: configuration.id, collectionId,
      selections: { ...selections },
    });
  }

  function restore(configuration, collectionId, serialized) {
    const favorite = JSON.parse(serialized);
    if (!favorite || favorite.version !== 1 || favorite.configurationId !== configuration.id
        || favorite.collectionId !== collectionId) {
      throw new Error("This favourite belongs to a different set of options.");
    }
    variant(configuration, favorite.selections);
    return { ...favorite.selections };
  }

  return { key, variant, save, restore };
});
