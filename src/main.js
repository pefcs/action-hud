const MODULE_ID = "action-hud";
const INDY_DICE_MODULE_ID = "indy-dice-chronicle";
const SLOT_COUNT = 12;
const DEFAULT_WEAPON_SET_COUNT = 3;
const MAX_WEAPON_SET_COUNT = 9;
const ITEM_DRAG_MIME = "application/x-action-hud-item";
const SLOT_DRAG_MIME = "application/x-action-hud-slot";
const DEFAULT_POSITION = { left: 50, bottom: 12 };

let hudRoot = null;
let activeActor = null;
let activeToken = null;
let hudResizeObserver = null;
let gmMode = false;
let collapsed = false;
let locked = false;
let dragOffset = null;
let refreshQueued = false;
const pendingRefreshSections = new Set();
let lastContextKey = null;
const hudDialogs = new Set();
// One transient hover card can coexist with any number of pinned, draggable cards.
let hoverTooltipState = null;
const pinnedTooltipCards = new Set();
let tooltipHideTimer = null;
let tooltipRequestSequence = 0;
let settingsDialog = null;
let quickDiceFormula = "";
let quickDiceMode = "normal";
let quickDiceRolling = false;
let gmTokenSearchQuery = "";
let gmTokenFilter = "all";
const gmEncounterSelectedTokenIds = new Set();
const npcAutoFillInProgress = new Set();
const pendingShoveDefenseRequests = new Set();
const promptedShoveDefenseRequests = new Set();
// Transient Shove coordination data lives in memory and SocketLib/module-socket payloads, not chat.
const pendingShoveRequests = new Map();
const pendingShoveSkillChoiceRequests = new Map();
const pendingShoveOutcomeApplicationRequests = new Map();
const shoveRollContexts = new Map();
const processedShoveOutcomeApplications = new Set();
const activeShoveContestRequests = new Set();
const pendingGrappleRequests = new Map();
const pendingGrappleChoiceRequests = new Map();
const activeGrappleRequests = new Set();
const activeGrappleCleanupIds = new Set();
let actionHudSocket = null;

Hooks.once("init", () => {
  registerSettings();
  // Register the scene-control hook during init, before Foundry builds the controls.
  // Registering it from ready can be too late on player clients, leaving the toggle absent.
  registerCanvasControl();
  game.keybindings.register(MODULE_ID, "toggleHud", {
    name: "ACTION_HUD.toggle",
    editable: [{ key: "KeyH", modifiers: ["Control", "Shift"] }],
    onDown: () => { toggleHud(); return true; }
  });
});

window.addEventListener("resize", () => {
  const state = hoverTooltipState;
  if (state && !state.pinned && state.card?.isConnected) positionSpellTooltip(state.card, state.anchor, state);
  if (state?.anchorPin) positionAnchorTooltipPin(state);
  requestAnimationFrame(() => clampHudPosition());
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    ui.notifications.warn("Action HUD is designed for the D&D 5e system.");
    return;
  }
  gmMode = Boolean(game.user.isGM && !getControlledOwnedToken());
  registerRefreshHooks();
  registerShoveDefenseSocket();
  registerShoveRollFastForwardWrapper();
  game.modules.get(MODULE_ID).api = { ...(game.modules.get(MODULE_ID).api ?? {}), refreshExternalReadouts: () => queueRefresh("readouts") };
  createHud();
  refreshContext();
  restorePosition();
});

function registerSettings() {
  game.settings.register(MODULE_ID, "enabled", {
    name: "ACTION_HUD.name", hint: "ACTION_HUD.toggle", scope: "client", config: true,
    type: Boolean, default: true, onChange: value => { if (hudRoot) hudRoot.hidden = !value; }
  });
  game.settings.register(MODULE_ID, "scale", {
    name: "ACTION_HUD.scale", hint: "ACTION_HUD.scaleHint", scope: "client", config: true,
    type: Number, range: { min: 0.7, max: 1.2, step: 0.05 }, default: 1,
    onChange: value => {
      if (hudRoot) hudRoot.style.setProperty("--ahud-scale", String(value));
      applyTooltipScale(value);
      requestAnimationFrame(() => clampHudPosition());
    }
  });
}

function registerCanvasControl() {
  Hooks.on("getSceneControlButtons", controls => {
    // Foundry V14 provides a keyed Record of scene controls. Keep a fallback for
    // alternate control collections, and place the toggle in a control group that
    // exists for this user rather than silently omitting it on player clients.
    const list = Array.isArray(controls) ? controls : Object.values(controls ?? {});
    const tokenControls = (!Array.isArray(controls) ? (controls?.tokens ?? controls?.token) : null)
      ?? list.find(c => c.name === "tokens" || c.name === "token");
    const targetControls = tokenControls
      ?? list.find(c => c.name === "select" && c.tools)
      ?? list.find(c => c.tools)
      ?? list[0];
    if (!targetControls) return;

    if (!targetControls.tools) targetControls.tools = Array.isArray(controls) ? [] : {};
    const tools = targetControls.tools;
    const existingTools = Array.isArray(tools) ? tools : Object.values(tools ?? {});
    if (existingTools.some(tool => tool?.name === "action-hud-toggle")) return;
    const order = existingTools.reduce((max, tool) => Math.max(max, Number(tool?.order ?? -1)), -1) + 1;
    const tool = {
      name: "action-hud-toggle",
      title: game.i18n.localize("ACTION_HUD.toggle"),
      icon: "fas fa-grip",
      order,
      button: true,
      visible: true,
      // SceneControlTool in Foundry V14 uses onChange for button tools.
      onChange: () => toggleHud()
    };
    if (Array.isArray(tools)) tools.push(tool);
    else tools[tool.name] = tool;
  });
}

function registerRefreshHooks() {
  // Token control drives GM mode: selecting a token immediately opens its actor HUD;
  // clearing the selection restores the GM control bar. The GM toggle can still pin GM mode
  // until the next canvas selection change.
  Hooks.on("controlToken", (_token, controlled) => {
    if (game.user.isGM) {
      if (controlled) {
        gmMode = false;
        queueRefresh("all");
      } else {
        // On deselection, re-check after Foundry has updated the controlled-token collection.
        requestAnimationFrame(() => {
          gmMode = !getControlledOwnedToken();
          queueRefresh("all");
        });
      }
    } else queueRefresh("all");
  });
  Hooks.on("updateActor", actor => {
    if (!activeActor || actor?.uuid === activeActor.uuid) queueRefresh("actor");
  });
  Hooks.on("updateToken", (token, changes) => {
    const activeTokenId = activeToken?.document?.id ?? activeToken?.id;
    const changedTokenId = token?.id ?? token?.document?.id;
    if (activeTokenId == null || String(activeTokenId) !== String(changedTokenId)) return;
    const changedFields = changes ?? {};
    if (Object.prototype.hasOwnProperty.call(changedFields, "actorId") || Object.prototype.hasOwnProperty.call(changedFields, "actorLink")) {
      queueRefresh("all");
    } else if (Object.prototype.hasOwnProperty.call(changedFields, "movementAction")) queueRefresh("movement");
    else queueRefresh("context");
  });
  Hooks.on("updateItem", item => {
    if (!activeActor || item?.parent?.uuid === activeActor.uuid) queueRefresh("items");
  });
  for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(hook, effect => {
      if (!activeActor || effect?.parent?.uuid === activeActor.uuid) queueRefresh("effects");
    });
  }
  for (const hook of ["updateCombat", "deleteCombat", "createCombat"]) Hooks.on(hook, () => queueRefresh("combat"));
  Hooks.on("canvasReady", () => queueRefresh("all"));
  // Midi-QoL emits these when it records a used reaction/bonus action. Actor/effect updates
  // remain the primary source; these hooks make the HUD react immediately when available.
  for (const hook of ["midi-qol.setReactionUsed", "midi-qol.setBonusReactionUsed", "midi-qol.setBonusActionUsed"]) {
    Hooks.on(hook, () => queueRefresh("favorites"));
  }
  // Optional Indy Dice Chronicle integration; only a no-payload invalidation event
  // is listened for, and roll values are pulled through Chronicle's visibility-aware API.
  for (const hook of ["indy-dice-chronicle.latestRollChanged", "indy-dice-chronicle.sessionStateChanged", "indy-dice-chronicle.integrationReady"]) {
    Hooks.on(hook, () => queueRefresh("mana"));
  }
  Hooks.on("stealth-observer.readoutsChanged", () => queueRefresh("readouts"));
  Hooks.on("renderActorSheet", (app, html) => attachSheetDragSource(html, app?.actor ?? app?.object ?? null));
  // Help's attack benefit is consumed after the first non-helper attack roll against the
  // marked target. Midi-QoL still owns the attack workflow and reads the grant flag normally.
  Hooks.on("midi-qol.postAttackRoll", workflow => { void consumeHelpAttackBenefit(workflow); });
  // D&D 5e roll hooks let Help (Skill) expire after the first matching check.
  // Its DAE source-turn expiry remains the fallback if the benefit is never used.
  Hooks.on("dnd5e.rollSkill", (...args) => { void consumeHelpSkillBenefitFromHook(args); });
  Hooks.on("updateActor", actor => { void removeInvalidDodgeEffects(actor); void checkGrapplesOnIncapacitation(actor); });
  Hooks.on("createActiveEffect", effect => { if (effect?.parent?.documentName === "Actor") { void removeInvalidDodgeEffects(effect.parent); void checkGrapplesOnIncapacitation(effect.parent); } });
  Hooks.on("updateActiveEffect", effect => { if (effect?.parent?.documentName === "Actor") { void removeInvalidDodgeEffects(effect.parent); void checkGrapplesOnIncapacitation(effect.parent); } });
  Hooks.on("deleteActiveEffect", effect => { void onGrappleEffectDeleted(effect); });
  Hooks.on("updateCombat", (combat, changed) => {
    if (changed?.started === false && combat?.started === false) void expireGrapplerEffectsForCombat(combat);
  });
  Hooks.on("deleteCombat", combat => { void expireGrapplerEffectsForCombat(combat); });
}

function createHud() {
  if (hudRoot) hudRoot.remove();
  hudRoot = document.createElement("section");
  hudRoot.id = "action-hud-root";
  hudRoot.className = "ahud";
  hudRoot.innerHTML = `
    <div class="ahud-collapsed" hidden>
      <button class="ahud-emblem" type="button" data-action="expand" aria-label="Expand Action HUD"><i class="fas fa-compass"></i></button>
    </div>
    <div class="ahud-expanded">
      <button type="button" class="ahud-collapse-corner" data-action="collapse" title="Collapse HUD" aria-label="Collapse HUD"><i class="fas fa-minimize" aria-hidden="true"></i></button>
      <section class="ahud-hp-section" data-hp-section aria-label="Hit points" hidden>
        <button class="ahud-hp-globe" type="button" data-action="hp-globe" title="Hit points">
          <span class="ahud-hp-liquid" data-hp-liquid></span>
          <span class="ahud-hp-normal"><span class="ahud-hp-value" data-hp-value>—</span><span class="ahud-hp-max" data-hp-max>/ —</span></span>
          <span class="ahud-hp-temp" data-hp-temp hidden></span>
          <span class="ahud-death-saves" data-death-saves hidden></span>
        </button>
      </section>
      <div class="ahud-character">
        <button class="ahud-portrait" type="button" data-action="open-sheet" title="Open actor sheet"><img alt="" /></button>
        <div class="ahud-identity">
          <div class="ahud-name">No actor selected</div><div class="ahud-subline"></div>
          <div class="ahud-statline">
            <span class="ahud-stat-badge" title="Armor Class"><i class="fas fa-shield-alt"></i><b data-stat="ac">—</b></span>
            <button class="ahud-movement" type="button" data-action="movement-menu" title="Select movement type" aria-haspopup="true" aria-expanded="false">
              <i data-movement-icon class="fas fa-person-walking"></i><b data-stat="speed">—</b><i class="fas fa-caret-down ahud-movement-caret"></i>
            </button>
          </div>
          <div class="ahud-hit-dice" data-hit-dice aria-label="Hit dice"></div>
          <div class="ahud-external-readouts" data-external-readouts aria-label="Additional readouts" hidden></div>
        </div>
        <div class="ahud-movement-menu" data-movement-menu hidden></div>
      </div>
      <div class="ahud-actions">
        <div class="ahud-favorites" aria-label="Favorites"><div class="ahud-slots" data-slots></div></div>
        <div class="ahud-tools">
          <button type="button" data-action="drawer" data-drawer="spells" title="Spellbook"><i class="fas fa-book"></i></button>
          <button type="button" data-action="drawer" data-drawer="inventory" title="Inventory"><img src="systems/dnd5e/icons/svg/backpack.svg" alt="" aria-hidden="true"></button>
          <button type="button" data-action="drawer" data-drawer="features" title="Features"><i class="fas fa-list"></i></button>
          <button type="button" data-action="drawer" data-drawer="checks" title="Skills, ability checks and saves"><i class="fas fa-briefcase"></i></button>
          <button type="button" data-action="drawer" data-drawer="combat-actions" title="Core Combat Actions" aria-label="Core Combat Actions"><i class="fas fa-hand-fist"></i></button>
          <button type="button" data-action="settings" title="HUD settings"><i class="fas fa-sliders"></i></button>
          <button type="button" data-action="lock" title="Lock HUD position"><i class="fas fa-lock-open"></i></button>
          <button type="button" data-action="drawer" data-drawer="quick-dice" title="Quick Dice" aria-label="Quick Dice"><i class="fas fa-dice"></i></button>
          <button type="button" data-action="drawer" data-drawer="conditions" data-gm-only hidden title="Conditions"><i class="fas fa-shield-heart"></i><span>Conditions</span></button>
          <button type="button" data-action="drawer" data-drawer="gm-tools" data-gm-only hidden title="Encounter Controls" aria-label="Encounter Controls"><i class="fas fa-chess-board"></i><span>Encounter</span></button>
          <button type="button" data-action="gm-mode" title="Switch GM / token bar" hidden><i class="fas fa-user-shield"></i></button>
        </div>
      </div>
      <section class="ahud-mana-section" data-mana-section aria-label="Spell slots" hidden>
        <div class="ahud-mana-visual" data-mana-visual>
          <svg class="ahud-mana-svg" data-mana-svg viewBox="0 0 200 200" role="img" aria-label="Spell slot availability"></svg>
          <div class="ahud-mana-center" data-mana-center></div>
        </div>
        <div class="ahud-gm-rest-actions" data-gm-rest-actions hidden>
          <button type="button" data-action="team-short-rest" title="Team short rest"><i class="fas fa-utensils"></i><span>Short Rest</span></button>
          <button type="button" data-action="team-long-rest" title="Team long rest"><i class="fas fa-campground"></i><span>Long Rest</span></button>
        </div>
      </section>
      <div class="ahud-drawer" data-drawer-panel hidden></div>
      <div class="ahud-notice" data-notice hidden></div>
    </div>
    <button type="button" class="ahud-next-turn-side" data-action="next-turn" title="Next Turn" aria-label="Next Turn" hidden>
      <i class="fas fa-forward-step" aria-hidden="true"></i><span>${game.i18n.localize("ACTION_HUD.nextTurn")}</span>
    </button>
    <div class="ahud-effect-strip" data-effect-strip aria-label="Active effects" hidden></div>`;
  document.body.appendChild(hudRoot);
  hudResizeObserver?.disconnect();
  hudResizeObserver = new ResizeObserver(() => clampHudPosition());
  hudResizeObserver.observe(hudRoot);
  hudRoot.style.setProperty("--ahud-scale", String(game.settings.get(MODULE_ID, "scale") ?? 1));
  bindHudEvents();
  hudRoot.hidden = !game.settings.get(MODULE_ID, "enabled");
}

function bindHudEvents() {
  // Rich description cards must not cover the favorites while an item/slot is dragged.
  // Hide them temporarily instead of destroying the hover card; restore it if the pointer
  // is still over its source, otherwise discard it cleanly when the drag finishes.
  const clearItemDragState = () => {
    document.body.classList.remove("ahud-item-dragging");
    const state = hoverTooltipState;
    if (state && !state.pinned) {
      state.anchorHovered = Boolean(state.anchor?.matches?.(":hover"));
      state.cardHovered = Boolean(state.card?.matches?.(":hover"));
      if (!state.anchorHovered && !state.cardHovered) {
        state.card?.remove();
        if (hoverTooltipState === state) hoverTooltipState = null;
      }
    }
  };
  document.addEventListener("dragstart", event => {
    // The browser emits dragstart for document/item rows as well as for HUD tiles.
    if (!event.target?.closest?.("[data-item-id], [data-item-uuid], [data-slot], .ahud-spell-tile, .ahud-item-tile, [draggable='true']")) return;
    document.body.classList.add("ahud-item-dragging");
  }, true);
  document.addEventListener("dragend", clearItemDragState, true);
  document.addEventListener("drop", () => window.setTimeout(clearItemDragState, 0), true);
  // If a dragstart is cancelled by a sheet/system handler, some browsers omit dragend.
  // Pointer-up and Escape clear the temporary hidden state in that case.
  document.addEventListener("pointerup", () => {
    if (document.body.classList.contains("ahud-item-dragging")) window.setTimeout(clearItemDragState, 0);
  }, true);
  document.addEventListener("keydown", event => { if (event.key === "Escape") clearItemDragState(); }, true);
  window.addEventListener("blur", clearItemDragState);

  // Dropping a favorite anywhere outside the 12-slot grid removes it. Use capture phase so
  // Foundry's canvas drop handler doesn't try to interpret our private hotbar payload.
  document.addEventListener("dragover", event => {
    if (hasDragType(event.dataTransfer, SLOT_DRAG_MIME)) {
      if (!event.target?.closest?.("[data-slot]")) event.preventDefault();
    }
  }, true);
  document.addEventListener("drop", event => {
    if (event.target?.closest?.("[data-slot]")) return; // The HUD handles moves/swaps itself.
    const payload = readDragPayload(event.dataTransfer);
    if (payload?.type !== "ActionHUDSlot" || !Number.isInteger(Number(payload.index))) return;
    event.preventDefault();
    event.stopPropagation();
    void removeFavoriteFromSlot(Number(payload.index));
  }, true);

  hudRoot.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    event.preventDefault();
    const action = button.dataset.action;
    if (action === "collapse") setCollapsed(true);
    else if (action === "expand") setCollapsed(false);
    else if (action === "lock") setLocked(!locked);
    else if (action === "open-sheet") activeActor?.sheet?.render(true);
    else if (action === "hp-globe") {
      if (!activeActor) return;
      const hp = activeActor.system.attributes?.hp;
      const dying = activeActor.type === "character" && Number(hp?.value ?? 1) <= 0 && Boolean(activeActor.system.attributes?.death);
      if (dying) {
        if (!activeToken) return ui.notifications.info(game.i18n.localize("ACTION_HUD.selectTokenToRoll"));
        try { await activeActor.rollDeathSave?.({ event }); }
        catch (error) { console.error(`${MODULE_ID} | Failed to roll death save`, error); }
      } else activeActor.sheet?.render(true);
    }
    else if (action === "movement-menu") toggleMovementMenu();
    else if (action === "set-movement") await setMovementAction(button.dataset.movementAction);
    else if (action === "gm-mode") { gmMode = !gmMode; refreshContext(); }
    else if (action === "team-short-rest") await runTeamRest("short");
    else if (action === "team-long-rest") await runTeamRest("long");
    else if (action === "settings") openSettings();
    else if (action === "drawer") openDrawer(button.dataset.drawer);
    else if (action === "combat-action") await handleCoreCombatAction(button.dataset.combatAction);
    else if (action === "gm-select-token") selectSceneToken(button.dataset.tokenId);
    else if (action === "gm-token-selection") toggleGMEncounterTokenSelection(button.dataset.tokenId, button);
    else if (action === "gm-encounter") await handleGMEncounterAction(button.dataset.encounterAction, button.dataset.tokenId);
    else if (action === "gm-token-filter") { gmTokenFilter = button.dataset.tokenFilter || "all"; refreshGMEncounterPanel(); }
    else if (action === "reset-favorites") await resetFavorites();
    else if (action === "next-turn") game.combat?.nextTurn?.();
    else if (action === "slot") await activateSlot(Number(button.dataset.slot));
    else if (action === "effect-toggle") await toggleEffect(button.dataset.effectId);
    else if (action === "effect-delete") await deleteEffect(button.dataset.effectId);
  });
  hudRoot.addEventListener("contextmenu", async event => {
    const slot = event.target.closest("[data-slot]");
    if (!slot || slot.dataset.empty !== "false") return;
    event.preventDefault();
    const entry = getFavorites()[Number(slot.dataset.slot)];
    const item = await resolveItem(entry);
    item?.sheet?.render(true);
  });
  hudRoot.addEventListener("dragover", event => {
    const slot = event.target.closest("[data-slot]");
    hudRoot.querySelectorAll("[data-slot].is-drop-target").forEach(el => { if (el !== slot) el.classList.remove("is-drop-target"); });
    if (slot) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = hasDragType(event.dataTransfer, SLOT_DRAG_MIME) ? "move" : "copy";
      slot.classList.add("is-drop-target");
    }
  });
  hudRoot.addEventListener("dragenter", event => {
    const slot = event.target.closest("[data-slot]");
    if (slot) { event.preventDefault(); slot.classList.add("is-drop-target"); }
  });
  hudRoot.addEventListener("dragleave", event => {
    const slot = event.target.closest("[data-slot]");
    if (slot && !slot.contains(event.relatedTarget)) slot.classList.remove("is-drop-target");
  });
  hudRoot.addEventListener("drop", event => {
    hudRoot.querySelectorAll("[data-slot].is-drop-target").forEach(el => el.classList.remove("is-drop-target"));
    void handleDrop(event);
  });
  hudRoot.addEventListener("contextmenu", event => {
    const effect = event.target.closest("[data-effect-id]");
    if (!effect) return;
    event.preventDefault();
    void deleteEffect(effect.dataset.effectId);
  });
  const dragHandle = hudRoot.querySelector(".ahud-character");
  dragHandle.addEventListener("pointerdown", startMove);
  window.addEventListener("pointermove", moveHud);
  window.addEventListener("pointerup", endMove);
  window.addEventListener("resize", () => {
    const panel = hudRoot?.querySelector("[data-drawer-panel]");
    if (panel && !panel.hidden && panel.dataset.currentDrawer === "conditions" && game.user.isGM && gmMode) openDrawer("conditions", true);
  });
}

function startMove(event) {
  if (locked || event.target.closest("button")) return;
  const rect = hudRoot.getBoundingClientRect();
  // Track the pointer relative to the bar's center, not its left edge. The GM and actor bars
  // have different widths, but should always share the same horizontal anchor.
  dragOffset = { x: event.clientX - (rect.left + rect.width / 2), y: event.clientY - rect.top };
  hudRoot.classList.add("is-moving");
  hudRoot.setPointerCapture?.(event.pointerId);
}
function moveHud(event) {
  if (!dragOffset || !hudRoot) return;
  const width = hudRoot.offsetWidth, height = hudRoot.offsetHeight;
  const centerX = Math.max(width / 2, Math.min(window.innerWidth - width / 2, event.clientX - dragOffset.x));
  const top = Math.max(0, Math.min(window.innerHeight - height, event.clientY - dragOffset.y));
  hudRoot.style.left = `${centerX}px`; hudRoot.style.top = `${top}px`; hudRoot.style.bottom = "auto"; hudRoot.style.transform = "translateX(-50%)";
}
function endMove() {
  if (!dragOffset) return;
  dragOffset = null; hudRoot?.classList.remove("is-moving");
  if (hudRoot) {
    const rect = hudRoot.getBoundingClientRect();
    const centerX = Math.max(0, Math.min(1, (rect.left + rect.width / 2) / Math.max(window.innerWidth, 1)));
    game.user.setFlag(MODULE_ID, "position", { centerX, top: `${rect.top}px` });
  }
  const panel = hudRoot?.querySelector("[data-drawer-panel]");
  if (panel && !panel.hidden && panel.dataset.currentDrawer === "conditions" && game.user.isGM && gmMode) openDrawer("conditions", true);
}
function restorePosition() {
  const position = game.user.getFlag(MODULE_ID, "position");
  const width = hudRoot.getBoundingClientRect().width || hudRoot.offsetWidth || 0;
  const minCenter = width / 2;
  const maxCenter = Math.max(minCenter, window.innerWidth - width / 2);
  if (Number.isFinite(Number(position?.centerX)) && position?.top) {
    // New format stores a normalized horizontal center so widths can change between GM and actor bars.
    const centerPx = Math.max(minCenter, Math.min(maxCenter, Number(position.centerX) * window.innerWidth));
    hudRoot.style.left = `${centerPx}px`;
    hudRoot.style.top = position.top;
    hudRoot.style.bottom = "auto";
    hudRoot.style.transform = "translateX(-50%)";
  } else if (position?.left && position?.top) {
    // Migrate the previous top-left coordinate format to the new center-anchored format.
    let centerRatio;
    if (String(position.left).trim().endsWith("%")) centerRatio = Number.parseFloat(position.left) / 100;
    else centerRatio = (Number.parseFloat(position.left) + width / 2) / Math.max(window.innerWidth, 1);
    centerRatio = Math.max(minCenter / Math.max(window.innerWidth, 1), Math.min(maxCenter / Math.max(window.innerWidth, 1), centerRatio));
    hudRoot.style.left = `${centerRatio * 100}%`;
    hudRoot.style.top = position.top;
    hudRoot.style.bottom = "auto";
    hudRoot.style.transform = "translateX(-50%)";
    game.user.setFlag(MODULE_ID, "position", { centerX: centerRatio, top: position.top });
  } else {
    hudRoot.style.left = `${DEFAULT_POSITION.left}%`;
    hudRoot.style.bottom = `${DEFAULT_POSITION.bottom}px`;
    hudRoot.style.top = "auto";
    hudRoot.style.transform = "translateX(-50%)";
  }
  locked = Boolean(game.user.getFlag(MODULE_ID, "locked"));
  setLocked(locked, false);
  clampHudPosition();
}
function clampHudPosition() {
  if (!hudRoot || hudRoot.hidden || dragOffset) return;
  const rect = hudRoot.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const left = Math.max(0, Math.min(Math.max(0, window.innerWidth - rect.width), rect.left));
  const top = Math.max(0, Math.min(Math.max(0, window.innerHeight - rect.height), rect.top));
  if (Math.abs(left - rect.left) < 0.5 && Math.abs(top - rect.top) < 0.5) return;

  hudRoot.style.left = `${left + rect.width / 2}px`;
  hudRoot.style.top = `${top}px`;
  hudRoot.style.bottom = "auto";
  hudRoot.style.transform = "translateX(-50%)";
  const centerX = Math.max(0, Math.min(1, (left + rect.width / 2) / Math.max(window.innerWidth, 1)));
  game.user.setFlag(MODULE_ID, "position", { centerX, top: `${top}px` });
}
function setLocked(value, persist = true) {
  locked = value;
  const button = hudRoot?.querySelector('[data-action="lock"]');
  if (button) { button.innerHTML = locked ? '<i class="fas fa-lock"></i>' : '<i class="fas fa-lock-open"></i>'; button.title = game.i18n.localize(locked ? "ACTION_HUD.unlock" : "ACTION_HUD.lock"); }
  hudRoot?.classList.toggle("is-locked", locked);
  if (persist) game.user.setFlag(MODULE_ID, "locked", locked);
}
function setCollapsed(value) {
  collapsed = value;
  hudRoot.querySelector(".ahud-expanded").hidden = collapsed;
  hudRoot.querySelector(".ahud-collapsed").hidden = !collapsed;
  hudRoot.classList.toggle("is-collapsed", collapsed);
  updateNextTurnVisibility();
  renderEffectsStrip();
  requestAnimationFrame(() => clampHudPosition());
}
function toggleHud() {
  if (!hudRoot) return;
  const enabled = hudRoot.hidden;
  hudRoot.hidden = !enabled;
  game.settings.set(MODULE_ID, "enabled", enabled);
  if (enabled) requestAnimationFrame(() => clampHudPosition());
}
function queueRefresh(...sections) {
  for (const section of sections.length ? sections : ["all"]) pendingRefreshSections.add(section);
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    const requestedSections = new Set(pendingRefreshSections);
    pendingRefreshSections.clear();
    refreshContext(requestedSections.has("all") ? new Set(["all"]) : requestedSections);
  });
}

function getControlledOwnedToken() {
  const controlled = canvas.tokens?.controlled ?? [];
  return controlled.find(token => token.actor && (game.user.isGM || token.actor.testUserPermission(game.user, "OWNER"))) ?? null;
}
function getAssignedActor() {
  const actor = game.user.character;
  if (actor && (game.user.isGM || actor.testUserPermission(game.user, "OWNER"))) return actor;
  return null;
}
function getCurrentCombatant() {
  const combat = game.combat;
  if (!combat) return null;
  return combat.combatant
    ?? combat.turns?.[combat.turn]
    ?? combat.combatants?.get?.(combat.combatantId)
    ?? null;
}

function isActiveActorTurn() {
  const combat = game.combat;
  if (!combat?.started || !activeActor || (game.user.isGM && gmMode)) return false;
  const combatant = getCurrentCombatant();
  if (!combatant?.actor || combatant.actor.id !== activeActor.id) return false;

  // When a token is selected, require the exact combatant token as well as the actor.
  // This avoids showing Next Turn for a different token of the same linked actor.
  if (activeToken) {
    const selectedTokenId = activeToken.document?.id ?? activeToken.id;
    const combatTokenId = combatant.tokenId ?? combatant.token?.id ?? combatant.token?.document?.id;
    if (selectedTokenId != null && combatTokenId != null) return String(selectedTokenId) === String(combatTokenId);
  }
  // When the player is viewing their assigned actor without a selected token, actor
  // identity is enough to allow turn advancement for their own currently active turn.
  return true;
}

function updateNextTurnVisibility() {
  const button = hudRoot?.querySelector('[data-action="next-turn"]');
  if (!button) return;
  button.hidden = collapsed || !isActiveActorTurn();
  button.title = game.i18n.localize("ACTION_HUD.nextTurn");
  button.setAttribute("aria-label", button.title);
  const label = button.querySelector("span");
  if (label) label.textContent = game.i18n.localize("ACTION_HUD.nextTurn");
}

function closeContextPopups() {
  closeSpellTooltip(true);
  const drawer = hudRoot?.querySelector("[data-drawer-panel]");
  if (drawer) {
    drawer.hidden = true;
    drawer.replaceChildren();
    delete drawer.dataset.currentDrawer;
    drawer.classList.remove("ahud-condition-drawer");
  }
  const movementMenu = hudRoot?.querySelector("[data-movement-menu]");
  if (movementMenu) movementMenu.hidden = true;
  hudRoot?.querySelector('[data-action="movement-menu"]')?.setAttribute("aria-expanded", "false");
  for (const dialog of [...hudDialogs]) {
    try { dialog.close(); } catch (error) { console.warn(`${MODULE_ID} | Could not close HUD dialog`, error); }
  }
  hudDialogs.clear();
}
function renderStealthObserverReadouts(actor, token) {
  const host = hudRoot?.querySelector("[data-external-readouts]");
  if (!host) return;
  host.replaceChildren();
  const module = game.modules?.get?.("stealth-observer");
  const getter = module?.api?.getActionHUDReadouts;
  if (!module?.active || typeof getter !== "function" || !actor) {
    host.hidden = true;
    return;
  }
  let entries = [];
  try {
    entries = getter(token ?? actor) ?? [];
  } catch (error) {
    console.warn(`${MODULE_ID} | Stealth Observer readout integration failed.`, error);
    host.hidden = true;
    return;
  }
  for (const entry of entries) {
    if (!entry || typeof entry.icon !== "string") continue;
    const badge = document.createElement("span");
    badge.className = `ahud-external-readout ${String(entry.className ?? "").replace(/[^a-z0-9_-]/gi, "")}`;
    badge.title = String(entry.title ?? entry.key ?? "Additional readout");
    badge.setAttribute("aria-label", badge.title);
    const icon = document.createElement("i");
    icon.className = `fas ${entry.icon}`;
    icon.setAttribute("aria-hidden", "true");
    badge.appendChild(icon);
    if (entry.value !== null && entry.value !== undefined && entry.value !== "") {
      const value = document.createElement("b");
      value.textContent = String(entry.value);
      badge.appendChild(value);
    }
    host.appendChild(badge);
  }
  host.hidden = entries.length === 0;
}

function refreshContext(sections = new Set(["all"])) {
  if (!hudRoot || !canvas.ready) return;
  const refreshAll = sections.has("all");
  const refreshActor = refreshAll || sections.has("actor");
  const refreshItems = refreshAll || refreshActor || sections.has("items");
  const refreshFavoritesSection = refreshItems || sections.has("favorites") || sections.has("effects") || sections.has("combat");
  activeToken = getControlledOwnedToken();
  if (game.user.isGM && gmMode) activeActor = null;
  else if (activeToken) activeActor = activeToken.actor;
  else activeActor = getAssignedActor();

  // Popups are bound to the actor/token context they were opened for. Close them
  // before rendering a different context so stale content cannot remain visible.
  const controlledSignature = [...(canvas.tokens?.controlled ?? [])]
    .map(token => token.document?.uuid ?? token.id)
    .filter(Boolean)
    .sort()
    .join(",");
  const contextKey = [
    game.user.isGM && gmMode ? "gm" : "actor",
    activeActor?.uuid ?? activeActor?.id ?? "none",
    activeToken?.document?.uuid ?? activeToken?.id ?? "none",
    controlledSignature
  ].join("|");
  if (lastContextKey !== null && contextKey !== lastContextKey) closeContextPopups();
  lastContextKey = contextKey;

  const canAct = Boolean(activeToken && activeActor && (game.user.isGM || activeActor.testUserPermission(game.user, "OWNER")));
  const isGMBar = Boolean(game.user.isGM && gmMode);
  hudRoot.classList.toggle("is-gm", isGMBar);
  hudRoot.classList.toggle("is-unavailable", !canAct);
  const portrait = hudRoot.querySelector(".ahud-portrait img");
  const fallbackPortrait = "icons/svg/mystery-man.svg";
  if (isGMBar) {
    // In the GM bar, prefer the GM's assigned character portrait, then the GM
    // user's profile avatar, and finally Foundry's generic fallback portrait.
    const assignedCharacterImage = getAssignedActor()?.img;
    const gmUserImage = game.user.avatar;
    portrait.src = [assignedCharacterImage, gmUserImage, fallbackPortrait]
      .find(image => typeof image === "string" && image.trim()) ?? fallbackPortrait;
  } else {
    portrait.src = activeActor?.img || fallbackPortrait;
  }
  hudRoot.querySelector(".ahud-name").textContent = activeActor?.name ?? (game.user.isGM && gmMode ? game.i18n.localize("ACTION_HUD.gmControls") : game.i18n.localize("ACTION_HUD.noActor"));
  hudRoot.querySelector(".ahud-subline").textContent = activeToken?.name ?? (game.user.isGM && gmMode ? game.i18n.localize("ACTION_HUD.gmBarSubtitle") : activeActor ? game.i18n.localize("ACTION_HUD.tokenNotSelected") : game.i18n.localize("ACTION_HUD.noActorSubtitle"));
  hudRoot.querySelector('[data-stat="ac"]').textContent = activeActor ? String(activeActor.system.attributes?.ac?.value ?? "—") : "—";
  const gmButton = hudRoot.querySelector('[data-action="gm-mode"]');
  // Only show the mode-switch button when there is a selected token to switch to/from.
  gmButton.hidden = !game.user.isGM || !activeToken;
  gmButton.title = gmMode ? game.i18n.localize("ACTION_HUD.actorMode") : game.i18n.localize("ACTION_HUD.gmMode");
  gmButton.classList.toggle("is-selected", gmMode);
  hudRoot.querySelectorAll("[data-gm-only]").forEach(button => { button.hidden = !isGMBar; });
  for (const button of hudRoot.querySelectorAll('.ahud-tools [data-drawer]')) {
    const drawerName = button.dataset.drawer;
    if (drawerName === "gm-tools") button.hidden = !isGMBar;
    else if (drawerName === "combat-actions") button.hidden = isGMBar || !activeActor || !activeToken;
    else if (!["conditions", "quick-dice"].includes(drawerName)) button.hidden = isGMBar;
  }
  updateNextTurnVisibility();
  const shortRestButton = hudRoot.querySelector('[data-action="team-short-rest"]');
  const longRestButton = hudRoot.querySelector('[data-action="team-long-rest"]');
  shortRestButton.hidden = !isGMBar;
  longRestButton.hidden = !isGMBar;
  shortRestButton.title = game.i18n.localize("ACTION_HUD.teamShortRest");
  longRestButton.title = game.i18n.localize("ACTION_HUD.teamLongRest");
  shortRestButton.querySelector("span").textContent = game.i18n.localize("ACTION_HUD.shortRest");
  longRestButton.querySelector("span").textContent = game.i18n.localize("ACTION_HUD.longRest");
  const conditionsButton = hudRoot.querySelector('[data-drawer="conditions"]');
  conditionsButton.title = game.i18n.localize("ACTION_HUD.conditions");
  conditionsButton.querySelector("span").textContent = game.i18n.localize("ACTION_HUD.conditions");
  const party = game.actors?.party;
  for (const button of [shortRestButton, longRestButton]) {
    button.disabled = !party || party.type !== "group";
    if (button.disabled) button.title = game.i18n.localize("ACTION_HUD.noPrimaryParty");
  }
  const drawer = hudRoot.querySelector("[data-drawer-panel]");
  if (drawer?.dataset.currentDrawer === "conditions") {
    if (!isGMBar) drawer.hidden = true;
    else if (!drawer.hidden) openDrawer("conditions", true);
  }
  const notice = hudRoot.querySelector("[data-notice]");
  notice.hidden = canAct || (game.user.isGM && gmMode);
  notice.textContent = game.i18n.localize(activeActor ? "ACTION_HUD.noTokenSelected" : "ACTION_HUD.noActorNotice");
  if (refreshActor) renderHealth(activeActor);
  if (refreshAll || refreshActor || sections.has("readouts")) renderStealthObserverReadouts(activeActor, activeToken);
  if (refreshActor || sections.has("movement")) renderMovement(activeActor);
  if (refreshActor) renderResources(activeActor);
  else if (sections.has("mana")) renderManaGlobe(activeActor);
  if (refreshFavoritesSection) renderFavorites();
  const weaponSetHost = hudRoot.querySelector("[data-weapon-sets]");
  if (weaponSetHost && refreshItems) renderWeaponSetToolbar(weaponSetHost, activeActor);
  if (refreshItems) {
    refreshInventoryEquipStates();
    refreshVisibleDrawerResourceIndicators();
  }
  // Populate a brand-new NPC bar once; never reshuffle an existing/customized one.
  if (refreshAll || refreshActor) void maybeAutoFillNpcFavorites(activeActor, activeToken);
  if (refreshAll || refreshActor || sections.has("effects")) renderEffectsStrip();
  const movementMenu = hudRoot.querySelector("[data-movement-menu]");
  if ((refreshAll || refreshActor || sections.has("movement")) && movementMenu && !movementMenu.hidden) renderMovementMenu();
}
function getConfigDocument() {
  if (activeToken && !activeToken.document.actorLink) return activeToken.document;
  return activeActor;
}

function hasNpcItemActivation(item) {
  const system = item?.system ?? {};
  const activation = system.activation ?? {};
  return getActivityValues(item).length > 0
    || Boolean(activation.type || activation.value || activation.cost);
}

function npcActivationPriority(item) {
  const types = itemActivationTypes(item);
  if (types.has("action")) return 30;
  if (types.has("bonus")) return 20;
  if (types.has("reaction")) return 10;
  return 0;
}

function buildNpcAutoFillFavorites(actor) {
  const alwaysExcluded = new Set(["class", "subclass", "background", "race", "species", "tool", "loot", "container", "backpack"]);
  const scored = [];
  for (const item of actor?.items?.contents ?? []) {
    const system = item.system ?? {};
    const type = String(item.type ?? "").toLowerCase();
    // Contents belong in the container, not in the combat hotbar. Keep the
    // container and ordinary inventory available through the Inventory drawer.
    if (system.container) continue;
    if (alwaysExcluded.has(type)) continue;

    const hasActivation = hasNpcItemActivation(item);
    const activationScore = npcActivationPriority(item);
    let score = null;

    if (type === "weapon") {
      // NPC weapons are the most useful defaults. Prefer equipped weapons, but
      // retain an unequipped one as a lower-priority fallback if needed.
      score = 1000 + activationScore + (system.equipped === true ? 25 : 0) - (system.equipped === false ? 125 : 0);
    } else if (type === "feat") {
      // Passive traits generally have no activities or activation and are omitted.
      if (hasActivation) score = 900 + activationScore + (hasUsesOrCharges(item) ? 3 : 0);
    } else if (type === "spell") {
      if (!isSpellbookEligible(item, actor)) continue;
      const level = Math.max(0, Number(system.level) || 0);
      const method = spellMethod(item);
      score = 780 + (level === 0 ? 55 : 0) - Math.min(level, 9) * 5
        + (["atwill", "innate"].includes(method) ? 25 : 0) + activationScore;
    } else if (hasActivation) {
      // Include genuinely usable consumables and other items with activities,
      // but not passive gear, containers, loot, or tools.
      score = 700 + activationScore + (hasUsesOrCharges(item) ? 5 : 0);
    }

    if (score === null) continue;
    scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score
    || a.item.name.localeCompare(b.item.name, game.i18n.lang || undefined, { sensitivity: "base" })
    || String(a.item.id).localeCompare(String(b.item.id)));

  return Array.from({ length: SLOT_COUNT }, (_, index) => {
    const item = scored[index]?.item;
    return item ? { id: item.id, uuid: item.uuid, name: item.name, img: item.img, type: item.type } : null;
  });
}

async function maybeAutoFillNpcFavorites(actor, token) {
  if (!actor || actor.type !== "npc" || !token || token.actor?.uuid !== actor.uuid) return;
  const doc = token.document && !token.document.actorLink ? token.document : actor;
  if (!doc?.getFlag || !doc?.setFlag) return;
  const key = doc.uuid ?? `${doc.documentName ?? "Document"}.${doc.id ?? "unknown"}`;
  if (npcAutoFillInProgress.has(key)) return;
  npcAutoFillInProgress.add(key);

  try {
    if (doc.getFlag(MODULE_ID, "npcFavoritesAutoFillChecked")) return;

    const existing = doc.getFlag(MODULE_ID, "favorites");
    if (Array.from({ length: SLOT_COUNT }, (_, i) => existing?.[i] ?? null).some(Boolean)) {
      // An already-populated bar is user-owned, even if some of its slots are empty.
      await doc.setFlag(MODULE_ID, "npcFavoritesAutoFillChecked", true);
      return;
    }

    // Mark the attempt first so a refresh/update hook cannot start another attempt.
    await doc.setFlag(MODULE_ID, "npcFavoritesAutoFillChecked", true);
    // Check again after awaiting the flag write: the GM may have customized the bar
    // during the async operation, and those choices always win over auto-fill.
    const current = doc.getFlag(MODULE_ID, "favorites");
    if (Array.from({ length: SLOT_COUNT }, (_, i) => current?.[i] ?? null).some(Boolean)) return;

    const favorites = buildNpcAutoFillFavorites(actor);
    if (favorites.some(Boolean)) {
      await doc.setFlag(MODULE_ID, "favorites", favorites);
      if (activeActor?.uuid === actor.uuid && getConfigDocument() === doc) renderFavorites();
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not auto-fill NPC favorites`, error);
  } finally {
    npcAutoFillInProgress.delete(key);
  }
}
function getFavorites() {
  const doc = getConfigDocument();
  const favs = doc?.getFlag(MODULE_ID, "favorites");
  return Array.from({ length: SLOT_COUNT }, (_, i) => favs?.[i] ?? null);
}
async function saveFavorites(favorites) {
  const doc = getConfigDocument();
  if (!doc) return ui.notifications.warn("Select an actor or token before editing favorites.");
  await doc.setFlag(MODULE_ID, "favorites", Array.from({ length: SLOT_COUNT }, (_, i) => favorites[i] ?? null));
  renderFavorites();
}
function getResourceUseCount(uses) {
  if (!uses || typeof uses !== "object") return null;
  const max = Number(uses.max);
  const spent = Number(uses.spent ?? 0);
  const explicitValue = uses.value;
  const value = explicitValue !== undefined && explicitValue !== null && explicitValue !== ""
    ? Number(explicitValue)
    : max - (Number.isFinite(spent) ? spent : 0);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(value)) return null;
  return { max, value: Math.max(0, Math.min(max, value)) };
}

function getFavoriteResourceIndicators(item) {
  const system = item?.system ?? {};
  const indicators = [];
  const itemUses = getResourceUseCount(system.uses);
  if (itemUses) {
    indicators.push({
      kind: "uses", text: `${itemUses.value}/${itemUses.max}`,
      title: `${game.i18n.localize("DND5E.Uses")}: ${itemUses.value} / ${itemUses.max}`,
      unavailable: itemUses.value <= 0
    });
  }

  // Item uses and recharge state are independent pieces of information. Show both when present
  // rather than letting the uses counter hide an uncharged recharge ability.
  const rechargeValue = Number(system.recharge?.value);
  if (Number.isFinite(rechargeValue) && rechargeValue > 0) {
    const range = rechargeValue >= 6 ? "6" : `${rechargeValue}–6`;
    indicators.push({
      kind: "recharge", text: `↻${range}`,
      title: `${game.i18n.localize("ACTION_HUD.recharge")}: ${range}`,
      unavailable: system.recharge?.charged === false
    });
  }

  // D&D 5e 6.x also supports uses belonging to an individual Activity. These are only relevant
  // to this item's favorite badge when an activity actually consumes its Activity Uses pool.
  // The actor/item use workflow itself remains native and is not changed here.
  for (const activity of getActivityValues(item)) {
    const uses = activity?.uses ?? activity?.system?.uses;
    const count = getResourceUseCount(uses);
    if (!count) continue;
    const targets = activity?.consumption?.targets ?? activity?.system?.consumption?.targets ?? [];
    if (!targets.some(target => String(target?.type ?? "").toLowerCase() === "activityuses")) continue;
    const activityName = String(activity.name ?? activity.label ?? game.i18n.localize("ACTION_HUD.activityUses"));
    const recharge = (uses.recovery ?? []).find(entry => entry?.period === "recharge");
    const recoveryText = recharge?.formula
      ? ` · ${game.i18n.localize("ACTION_HUD.recharge")}: ${Number(recharge.formula) >= 6 ? "6" : `${recharge.formula}–6`}`
      : "";
    indicators.push({
      kind: "activity-uses", text: `${count.value}/${count.max}`,
      title: `${activityName} · ${game.i18n.localize("DND5E.Uses")}: ${count.value} / ${count.max}${recoveryText}`,
      unavailable: count.value <= 0
    });
  }
  return indicators;
}

function renderTileResourceIndicators(tile, item) {
  tile.querySelector(":scope > .ahud-tile-resource-indicators")?.remove();
  const indicators = getFavoriteResourceIndicators(item);
  tile.classList.toggle("is-resource-unavailable", Boolean(indicators.length) && indicators.every(indicator => indicator.unavailable));
  if (!indicators.length) return indicators;
  const group = document.createElement("span");
  group.className = "ahud-slot-resource-indicators ahud-tile-resource-indicators";
  group.setAttribute("aria-label", indicators.map(indicator => indicator.title).join("; "));
  for (const indicator of indicators.slice(0, 2)) {
    const badge = document.createElement("span");
    badge.className = `ahud-slot-resource-badge is-${indicator.kind}${indicator.unavailable ? " is-unavailable" : ""}`;
    badge.textContent = indicator.text;
    badge.title = indicator.title;
    group.appendChild(badge);
  }
  if (indicators.length > 2) {
    const hidden = indicators.slice(2);
    const more = document.createElement("span");
    more.className = "ahud-slot-resource-badge is-more";
    more.textContent = `+${hidden.length}`;
    more.title = hidden.map(indicator => indicator.title).join("\n");
    group.appendChild(more);
  }
  tile.appendChild(group);
  return indicators;
}

function renderInventoryQuantityBadge(tile, item) {
  tile.querySelector(":scope > .ahud-item-quantity-badge")?.remove();
  if (!tile.classList.contains("ahud-item-tile") || item?.type !== "consumable") return null;
  const quantity = Number(item.system?.quantity ?? 1);
  // A single consumable needs no extra badge; show a stack count only when there
  // are multiple copies, independently of each item's own limited-use charges.
  if (!Number.isFinite(quantity) || quantity <= 1) return null;
  const quantityLabel = game.i18n.localize("DND5E.Quantity");
  const title = `${quantityLabel && quantityLabel !== "DND5E.Quantity" ? quantityLabel : "Quantity"}: ${quantity}`;
  const badge = document.createElement("span");
  badge.className = "ahud-item-quantity-badge";
  badge.textContent = `×${quantity}`;
  badge.title = title;
  badge.setAttribute("aria-label", title);
  tile.appendChild(badge);
  return { quantity, title };
}

function refreshVisibleDrawerResourceIndicators() {
  const panel = hudRoot?.querySelector("[data-drawer-panel]");
  if (!panel || panel.hidden || !["spells", "features", "inventory"].includes(panel.dataset.currentDrawer) || !activeActor) return;
  for (const tile of panel.querySelectorAll(".ahud-spell-tile[data-item-id], .ahud-item-tile[data-item-id]")) {
    const item = activeActor.items?.get?.(tile.dataset.itemId);
    if (!item) continue;
    const indicators = renderTileResourceIndicators(tile, item);
    const quantityIndicator = renderInventoryQuantityBadge(tile, item);
    const baseLabel = tile.dataset.resourceBaseAria ?? tile.getAttribute("aria-label") ?? item.name;
    const resourceText = indicators.map(indicator => indicator.title);
    tile.setAttribute("aria-label", [baseLabel, ...resourceText, quantityIndicator?.title].filter(Boolean).join(". "));
  }
}

function renderFavorites() {
  const host = hudRoot.querySelector("[data-slots]");
  host.replaceChildren();
  const favorites = getFavorites();
  favorites.forEach((entry, index) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "ahud-slot"; button.dataset.action = "slot"; button.dataset.slot = String(index);
    button.dataset.empty = entry ? "false" : "true";
    if (entry?.img) { const img = document.createElement("img"); img.src = entry.img; img.alt = ""; img.draggable = false; button.appendChild(img); }
    else { const number = document.createElement("span"); number.className = "ahud-slot-number"; number.textContent = String(index + 1); button.appendChild(number); }
    if (entry?.name) { const label = document.createElement("span"); label.className = "ahud-slot-label"; label.textContent = entry.name; button.appendChild(label); }
    const item = entry ? findItemSync(entry) : null;
    // Compact badges show item uses, item recharge, and Activity Uses pools exposed by D&D 5e 6.x.
    const resourceIndicators = item ? getFavoriteResourceIndicators(item) : [];
    if (resourceIndicators.length) {
      const badgeGroup = document.createElement("span");
      badgeGroup.className = "ahud-slot-resource-indicators";
      const visibleIndicators = resourceIndicators.slice(0, 2);
      for (const indicator of visibleIndicators) {
        const badge = document.createElement("span");
        badge.className = `ahud-slot-resource-badge is-${indicator.kind}`;
        if (indicator.unavailable) badge.classList.add("is-unavailable");
        badge.textContent = indicator.text;
        badge.title = indicator.title;
        badgeGroup.appendChild(badge);
      }
      if (resourceIndicators.length > visibleIndicators.length) {
        const hiddenIndicators = resourceIndicators.slice(visibleIndicators.length);
        const more = document.createElement("span");
        more.className = "ahud-slot-resource-badge is-more";
        more.textContent = `+${hiddenIndicators.length}`;
        more.title = hiddenIndicators.map(indicator => indicator.title).join("\n");
        badgeGroup.appendChild(more);
      }
      button.appendChild(badgeGroup);
      button.classList.toggle("is-resource-unavailable", resourceIndicators.every(indicator => indicator.unavailable));
    }
    // The hotbar intentionally uses a small native title tooltip, not the rich hover card.
    if (entry && !item) button.classList.add("is-missing");
    const useState = item && activeActor ? getItemActionAvailability(activeActor, item) : { blocked: false, reason: "" };
    const unequipped = Boolean(item && ["weapon", "equipment"].includes(item.type) && typeof item.system?.equipped === "boolean" && !item.system.equipped);
    button.classList.toggle("is-action-used", Boolean(useState.blocked));
    button.classList.toggle("is-unequipped", unequipped);
    button.title = entry?.name ?? `${game.i18n.localize("ACTION_HUD.emptySlot")} ${index + 1}`;
    if (unequipped) button.title += ` — ${game.i18n.localize("ACTION_HUD.notEquipped")}`;
    if (useState.blocked) button.title += ` — ${useState.reason}`;
    if (resourceIndicators.length) button.title += `\n${resourceIndicators.map(indicator => indicator.title).join("\n")}`;
    const enabled = Boolean(activeToken && activeActor && entry && item && (game.user.isGM || activeActor.testUserPermission(game.user, "OWNER")));
    // Empty favorites must remain valid drop targets even though they cannot be activated.
    // Keep the slot pointer-active for drag/drop and context menus; activateSlot enforces usability.
    button.disabled = false;
    button.setAttribute("aria-disabled", String(Boolean(entry) && !enabled));
    button.classList.toggle("is-unusable", Boolean(entry) && !enabled);
    if (entry) {
      button.draggable = true;
      button.addEventListener("dragstart", event => {
        if (!event.dataTransfer) return;
        const payload = { type: "ActionHUDSlot", index };
        const serialized = JSON.stringify(payload);
        event.dataTransfer.setData(SLOT_DRAG_MIME, serialized);
        event.dataTransfer.setData("text/plain", serialized);
        event.dataTransfer.effectAllowed = "move";
      });
    }
    if (entry && !activeToken) {
      button.classList.add("is-inactive");
      button.title = `${entry.name} — ${game.i18n.localize("ACTION_HUD.selectTokenToUse")}${useState.blocked ? ` · ${useState.reason}` : ""}`;
    } else if (!entry) button.title = `${game.i18n.localize("ACTION_HUD.emptySlot")} ${index + 1}`;
    button.setAttribute("aria-label", button.title);
    host.appendChild(button);
  });
}
function findItemSync(entry) {
  if (!activeActor || !entry) return null;
  return activeActor.items.get(entry.id) ?? null;
}
async function resolveItem(entry) {
  if (!entry || !activeActor) return null;
  if (entry.uuid) {
    try { const doc = await fromUuid(entry.uuid); if (doc?.parent?.id === activeActor.id) return doc; } catch (_) {}
  }
  return activeActor.items.get(entry.id) ?? null;
}
async function activateSlot(index) {
  if (!activeToken || !activeActor) return;
  const entry = getFavorites()[index];
  const item = await resolveItem(entry);
  if (!item) return ui.notifications.warn("That favorite no longer exists on this actor.");
  // Equipment may be shown dimmed on the hotbar, but it must not be usable until equipped.
  // Restrict this to item types that expose a real equipped state; consumables and other
  // equipment-like items without that state keep their normal behavior.
  const requiresEquipped = ["weapon", "equipment"].includes(item.type)
    && typeof item.system?.equipped === "boolean";
  if (requiresEquipped && !item.system.equipped) {
    ui.notifications.info(game.i18n.localize("ACTION_HUD.equipBeforeUse"));
    return;
  }
  if (item.system?.recharge?.value && item.system.recharge.charged === false) {
    ui.notifications.info(game.i18n.localize("ACTION_HUD.rechargeUnavailable"));
    return;
  }
  // Use the system's normal item entry point so its native activity and targeting flow remains in charge.
  if (typeof item.use === "function") await item.use();
  else item.sheet?.render(true);
}
async function handleDrop(event) {
  const slot = event.target.closest("[data-slot]");
  if (!slot) return;
  event.preventDefault();
  if (!getConfigDocument()) return ui.notifications.warn("Select an actor or token before editing favorites.");
  const data = readDragPayload(event.dataTransfer);
  if (data?.type === "ActionHUDSlot" && Number.isInteger(Number(data.index))) {
    const from = Number(data.index), to = Number(slot.dataset.slot);
    if (from < 0 || from >= SLOT_COUNT || to < 0 || to >= SLOT_COUNT || from === to) return;
    const favorites = getFavorites();
    [favorites[from], favorites[to]] = [favorites[to], favorites[from]];
    await saveFavorites(favorites);
    return;
  }
  const uuid = data?.uuid || data?.data?.uuid || safeTransferGet(event.dataTransfer, "text/uuid");
  let item = null;
  if (uuid) { try { item = await fromUuid(uuid); } catch (_) {} }
  if (!item && (data?.type === "Item" || data?.data?.type === "Item" || data?.documentName === "Item")) {
    const id = data.id || data._id || data.data?._id || data.data?.id;
    item = activeActor?.items.get(id) ?? null;
  }
  if (!item || item.documentName !== "Item") return ui.notifications.info("Drop an item from this actor's sheet or the HUD item list.");
  if (item.parent?.id !== activeActor?.id) return ui.notifications.warn("Only items owned by the currently displayed actor can be added.");
  const favorites = getFavorites();
  favorites[Number(slot.dataset.slot)] = { id: item.id, uuid: item.uuid, name: item.name, img: item.img, type: item.type };
  await saveFavorites(favorites);
}
function attachSheetDragSource(html, sheetActor = null) {
  const root = html?.[0] ?? html;
  root?.querySelectorAll?.("[data-item-id]").forEach(container => {
    const id = container.dataset.itemId;
    const sourceActor = sheetActor ?? activeActor;
    const item = sourceActor?.items?.get(id);
    if (!item) return;

    // D&D5e's inventory rows expect the child .item-row to be draggable, not the outer
    // <li data-item-id>. Feature rows use .item-name instead. Making the outer container
    // draggable can start a browser drag that Foundry's DragDrop handler then rejects.
    const dragTarget = container.matches(".item-row, .item-name")
      ? container
      : container.querySelector(":scope > .item-row")
        ?? container.querySelector(":scope > .item-name")
        ?? container.querySelector(":scope > .item-image")
        ?? container;
    if (!dragTarget || dragTarget.dataset.ahudDragBound) return;
    dragTarget.dataset.ahudDragBound = "true";
    dragTarget.draggable = true;
    // Prevent a child image from starting a competing native image drag instead of the row drag.
    dragTarget.querySelectorAll?.("img").forEach(img => { img.draggable = false; });
    dragTarget.addEventListener("dragstart", event => writeItemDragPayload(event, item, { nativeSource: true }));
  });
}

function writeItemDragPayload(event, item, { nativeSource = false } = {}) {
  const transfer = event?.dataTransfer;
  if (!transfer || !item) return;
  const payload = { type: "Item", uuid: item.uuid, id: item.id, documentName: "Item" };
  const serialized = JSON.stringify(payload);
  // Private MIME type is consumed by Action HUD. text/plain remains Foundry-compatible so
  // dragging from sheets continues to work with the system's own DragDrop workflows.
  try { transfer.setData(ITEM_DRAG_MIME, serialized); } catch (_) {}
  const nativeData = typeof item.toDragData === "function" ? JSON.stringify(item.toDragData()) : serialized;
  try { transfer.setData("text/plain", nativeSource ? nativeData : serialized); } catch (_) {}
  try { transfer.setData("text/uuid", item.uuid); } catch (_) {}
  if (!nativeSource) { try { transfer.effectAllowed = "copy"; } catch (_) {} }
}

function enableHudItemDrag(tile, item) {
  if (!tile || !item) return;
  tile.draggable = true;
  tile.querySelectorAll?.("img").forEach(img => { img.draggable = false; });
  tile.addEventListener("dragstart", event => writeItemDragPayload(event, item));
}

function safeTransferGet(transfer, type) {
  try { return transfer?.getData?.(type) ?? ""; } catch (_) { return ""; }
}

function hasDragType(transfer, wanted) {
  try { return Array.from(transfer?.types ?? []).includes(wanted); } catch (_) { return false; }
}

function readDragPayload(transfer) {
  if (!transfer) return {};
  for (const type of [SLOT_DRAG_MIME, ITEM_DRAG_MIME, "text/plain", "application/json"]) {
    const raw = safeTransferGet(transfer, type);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {
      // Some Foundry drag sources use a plain UUID in a text channel.
    }
    if (/^(Actor|Item|Compendium|Token)\./.test(raw)) return { type: "Item", uuid: raw, documentName: "Item" };
  }
  const uuid = safeTransferGet(transfer, "text/uuid");
  return uuid ? { type: "Item", uuid, documentName: "Item" } : {};
}

async function removeFavoriteFromSlot(index) {
  if (!Number.isInteger(index) || index < 0 || index >= SLOT_COUNT) return;
  if (!getConfigDocument()) return ui.notifications.warn("Select an actor or token before editing favorites.");
  const favorites = getFavorites();
  if (!favorites[index]) return;
  favorites[index] = null;
  await saveFavorites(favorites);
}
function renderHealth(actor) {
  const section = hudRoot.querySelector("[data-hp-section]");
  const globe = hudRoot.querySelector("[data-action=hp-globe]");
  const liquid = hudRoot.querySelector("[data-hp-liquid]");
  const normal = hudRoot.querySelector(".ahud-hp-normal");
  const value = hudRoot.querySelector("[data-hp-value]");
  const maxLabel = hudRoot.querySelector("[data-hp-max]");
  const temp = hudRoot.querySelector("[data-hp-temp]");
  const deathHost = hudRoot.querySelector("[data-death-saves]");
  if (!actor) { section.hidden = true; return; }
  const hp = actor.system.attributes?.hp;
  if (!hp) { section.hidden = true; return; }
  section.hidden = false;
  const current = Math.max(0, Number(hp.value) || 0);
  const max = Math.max(0, Number(hp.effectiveMax ?? ((Number(hp.max) || 0) + (Number(hp.tempmax) || 0))) || 0);
  const pct = max > 0 ? Math.max(0, Math.min(100, current / max * 100)) : 0;
  globe.style.setProperty("--ahud-hp-fill", `${pct}%`);
  value.textContent = String(hp.value ?? 0);
  maxLabel.textContent = `/ ${max}`;
  const tempHP = Math.max(0, Number(hp.temp) || 0);
  temp.hidden = !tempHP;
  temp.textContent = tempHP ? `+${tempHP}` : "";
  const death = actor.system.attributes?.death;
  const dying = actor.type === "character" && current <= 0 && Boolean(death);
  globe.classList.toggle("is-dying", dying);
  globe.disabled = Boolean(dying && !activeToken);
  globe.title = dying ? game.i18n.localize("ACTION_HUD.deathSave") : game.i18n.localize("ACTION_HUD.openCharacterSheet");
  normal.hidden = dying;
  deathHost.hidden = !dying;
  deathHost.replaceChildren();
  if (dying) {
    const skull = document.createElement("i"); skull.className = "fas fa-skull"; skull.setAttribute("aria-hidden", "true"); deathHost.appendChild(skull);
    for (const [kind, count, label] of [["success", Number(death.success) || 0, game.i18n.localize("ACTION_HUD.deathSaveSuccesses")], ["failure", Number(death.failure) || 0, game.i18n.localize("ACTION_HUD.deathSaveFailures")]]) {
      const row = document.createElement("span"); row.className = `ahud-death-pips is-${kind}`; row.title = `${label}: ${count}/3`;
      for (let i = 0; i < 3; i++) { const pip = document.createElement("i"); pip.className = i < count ? "is-filled" : ""; row.appendChild(pip); }
      deathHost.appendChild(row);
    }
  }
}
function getHitDiceByType(actor) {
  const counts = new Map();
  const add = (dieValue, totalValue, remainingValue) => {
    if (dieValue && typeof dieValue === "object") dieValue = dieValue.faces ?? dieValue.die ?? dieValue.value ?? dieValue.formula;
    const match = String(dieValue ?? "").match(/d?\s*(4|6|8|10|12|20)\b/i);
    if (!match) return;
    const die = `d${match[1]}`;
    let total = totalValue;
    if (total && typeof total === "object") total = total.value ?? total.levels ?? total.total;
    total = Number(total);
    if (!Number.isFinite(total) || total <= 0) total = 1;
    let remaining = Number(remainingValue);
    if (!Number.isFinite(remaining)) remaining = total;
    remaining = Math.max(0, Math.min(Math.floor(total), Math.floor(remaining)));
    const current = counts.get(die) ?? { total: 0, remaining: 0 };
    current.total += Math.floor(total);
    current.remaining += remaining;
    counts.set(die, current);
  };
  for (const item of actor?.items?.contents ?? []) {
    if (item.type !== "class") continue;
    const sys = item.system ?? {};
    const total = sys.hd?.max ?? sys.levels ?? sys.level ?? 1;
    const remaining = sys.hd?.value ?? (Number(total) - (Number(sys.hd?.spent) || 0));
    add(sys.hd?.denomination ?? sys.hitDice ?? sys.hitDie ?? sys.hitDiceType, total, remaining);
  }
  return [...counts.entries()].sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
}
function renderHitDice(actor) {
  const host = hudRoot.querySelector("[data-hit-dice]");
  host.replaceChildren();
  if (!actor) return;
  const entries = getHitDiceByType(actor);
  for (const [die, dice] of entries) {
    const badge = document.createElement("span"); badge.className = "ahud-hit-die"; badge.title = `${dice.remaining}/${dice.total} ${die} ${game.i18n.localize("ACTION_HUD.hitDice")}`;
    const icon = document.createElement("span"); icon.className = "ahud-die-face"; icon.textContent = die;
    const qty = document.createElement("b"); qty.textContent = `${dice.remaining}/${dice.total}`;
    badge.append(icon, qty); host.appendChild(badge);
  }
  if (!entries.length) {
    const hd = actor.system.attributes?.hd;
    if (Number(hd?.max) > 0) {
      const badge = document.createElement("span"); badge.className = "ahud-hit-die"; badge.title = game.i18n.localize("ACTION_HUD.hitDice");
      badge.textContent = `HD ${Number(hd.value ?? hd.max)}/${Number(hd.max)}`; host.appendChild(badge);
    }
  }
}
function getSpellDCEntries(actor) {
  if (!actor) return [];
  const base = Number(actor.system.attributes?.spell?.dc ?? actor.system.attributes?.spelldc);
  const profData = actor.system.attributes?.prof;
  const prof = Number(typeof profData === "object" && profData !== null ? profData.value : profData);
  const classes = (actor.items?.contents ?? []).filter(item => item.type === "class");
  const classEntries = [];
  for (const item of classes) {
    let ability = item.system?.spellcasting?.ability ?? item.system?.spellcastingAbility ?? item.system?.spellcasting?.ability?.value;
    if (ability && typeof ability === "object") ability = ability.value ?? ability.id;
    if (typeof ability !== "string" || !actor.system.abilities?.[ability]) continue;
    const configuredDC = Number(item.system?.spellcasting?.save);
    if (Number.isFinite(configuredDC) && configuredDC > 0) {
      classEntries.push({ label: item.name, dc: configuredDC });
      continue;
    }
    const mod = Number(actor.system.abilities[ability]?.mod);
    if (!Number.isFinite(mod) || !Number.isFinite(prof)) continue;
    classEntries.push({ label: item.name, dc: 8 + prof + mod });
  }
  const uniqueDCs = [...new Set(classEntries.map(entry => entry.dc))];
  if (uniqueDCs.length > 1) return classEntries.filter((entry, index, all) => all.findIndex(other => other.dc === entry.dc) === index);
  if (classEntries.length) {
    const classDC = uniqueDCs[0];
    if (!Number.isFinite(base) || base <= 0 || base !== classDC) return [classEntries[0]];
    return [{ label: game.i18n.localize("ACTION_HUD.spellDC"), dc: classDC }];
  }
  if (Number.isFinite(base) && base > 0) return [{ label: game.i18n.localize("ACTION_HUD.spellDC"), dc: base }];
  return [];
}
function svgSector(cx, cy, outerR, innerR, startAngle, endAngle) {
  const point = (r, a) => ({ x: cx + r * Math.cos(a * Math.PI / 180), y: cy + r * Math.sin(a * Math.PI / 180) });
  const p1 = point(outerR, startAngle), p2 = point(outerR, endAngle), p3 = point(innerR, endAngle), p4 = point(innerR, startAngle);
  const span = endAngle - startAngle;
  const large = span > 180 ? 1 : 0;
  return `M ${p1.x.toFixed(3)} ${p1.y.toFixed(3)} A ${outerR} ${outerR} 0 ${large} 1 ${p2.x.toFixed(3)} ${p2.y.toFixed(3)} L ${p3.x.toFixed(3)} ${p3.y.toFixed(3)} A ${innerR} ${innerR} 0 ${large} 0 ${p4.x.toFixed(3)} ${p4.y.toFixed(3)} Z`;
}
function getIndyDiceD20State() {
  const module = game.modules?.get?.(INDY_DICE_MODULE_ID);
  if (!module?.active || typeof module.api?.getActionHudD20State !== "function") {
    return { active: false, value: null };
  }
  try {
    const result = module.api.getActionHudD20State();
    const value = Number(result?.value);
    return {
      active: result?.active === true,
      value: Number.isInteger(value) && value >= 1 && value <= 20 ? value : null
    };
  } catch (error) {
    console.warn(`${MODULE_ID} | Indy Dice Chronicle integration failed; keeping Spell DC display.`, error);
    return { active: false, value: null };
  }
}

function renderD20Die(center, value) {
  const accessibleValue = Number.isInteger(value) ? String(value) : "—";
  const die = document.createElement("div");
  die.className = "ahud-last-roll-die";
  die.setAttribute("role", "button");
  die.setAttribute("tabindex", "0");
  die.setAttribute("aria-label", Number.isInteger(value)
    ? `${game.i18n.localize("ACTION_HUD.latestD20")}: ${value}. Left-click to toggle Indy Dice Stats Monitor; right-click to toggle Stats Analysis.`
    : `${game.i18n.localize("ACTION_HUD.waitingForD20")}. Left-click to toggle Indy Dice Stats Monitor; right-click to toggle Stats Analysis.`);
  die.title = "Left-click: Indy Dice Stats Monitor · Right-click: Stats Analysis";
  const toggleIndyDiceWindow = (kind) => {
    const module = game.modules?.get?.(INDY_DICE_MODULE_ID);
    const method = kind === "monitor" ? "toggleStatsMonitor" : "toggleStatsAnalysis";
    if (!module?.active || typeof module.api?.[method] !== "function") {
      ui.notifications?.warn?.("Indy Dice Chronicle window controls are unavailable.");
      return;
    }
    try {
      module.api[method]();
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to toggle Indy Dice Chronicle ${kind}.`, error);
    }
  };
  die.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleIndyDiceWindow("monitor");
  });
  die.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleIndyDiceWindow("analysis");
  });
  die.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      toggleIndyDiceWindow("monitor");
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      event.stopPropagation();
      toggleIndyDiceWindow("analysis");
    }
  });
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ahud-last-roll-die-svg");
  // Faceted, front-facing d20 silhouette. The broad central triangular face
  // carries the rolled natural value, while the surrounding facets make it
  // read as a die instead of a number badge at the orb's small size.
  const outline = document.createElementNS(NS, "polygon");
  outline.setAttribute("points", "32,2 60,18 62,42 48,53 32,62 16,53 2,42 4,18");
  outline.setAttribute("class", "ahud-last-roll-die-outline");
  svg.appendChild(outline);
  const frontFace = document.createElementNS(NS, "polygon");
  frontFace.setAttribute("points", "32,15 14,43 50,43");
  frontFace.setAttribute("class", "ahud-last-roll-die-front-face");
  svg.appendChild(frontFace);
  const facets = document.createElementNS(NS, "path");
  facets.setAttribute("d", "M32 2 L32 15 L4 18 M32 15 L60 18 M4 18 L14 43 L32 15 L50 43 L60 18 M2 42 L14 43 L16 53 L32 62 L48 53 L50 43 L62 42 M14 43 L50 43");
  facets.setAttribute("class", "ahud-last-roll-die-facets");
  svg.appendChild(facets);
  const number = document.createElementNS(NS, "text");
  number.setAttribute("x", "32"); number.setAttribute("y", "34.5");
  number.setAttribute("text-anchor", "middle"); number.setAttribute("dominant-baseline", "middle");
  number.setAttribute("class", "ahud-last-roll-die-number"); number.textContent = accessibleValue;
  svg.appendChild(number);
  die.appendChild(svg);
  center.appendChild(die);
}

function renderManaGlobe(actor) {
  const section = hudRoot.querySelector("[data-mana-section]");
  const svg = hudRoot.querySelector("[data-mana-svg]");
  const center = hudRoot.querySelector("[data-mana-center]");
  const visual = hudRoot.querySelector("[data-mana-visual]");
  const restActions = hudRoot.querySelector("[data-gm-rest-actions]");
  svg.replaceChildren(); center.replaceChildren();
  const isGMBar = Boolean(game.user.isGM && gmMode);
  section.classList.toggle("is-gm-rest", isGMBar);
  restActions.hidden = !isGMBar;
  visual.hidden = isGMBar;
  if (isGMBar) {
    section.hidden = false;
    hudRoot.classList.remove("has-mana-globe");
    return;
  }
  if (!actor) { section.hidden = true; hudRoot.classList.remove("has-mana-globe"); return; }
  const allSpells = actor.system.spells ?? {};
  const levels = [];
  for (let level = 1; level <= 9; level++) {
    const key = `spell${level}`, slot = allSpells[key];
    const max = Math.max(0, Math.floor(Number(slot?.max) || 0));
    if (max > 0) levels.push({ key, level, max, value: Math.max(0, Math.min(max, Math.floor(Number(slot?.value) || 0))), pact: false });
  }
  const pactSlot = allSpells.pact;
  const pact = pactSlot && Number(pactSlot.max) > 0 ? { key: "pact", level: Number(pactSlot.level ?? 0), max: Math.max(0, Math.floor(Number(pactSlot.max) || 0)), value: Math.max(0, Math.min(Number(pactSlot.max) || 0, Math.floor(Number(pactSlot.value) || 0))), pact: true } : null;
  const dcs = getSpellDCEntries(actor);
  const indyDice = getIndyDiceD20State();
  if (!levels.length && !pact && !dcs.length && !indyDice.active) { section.hidden = true; hudRoot.classList.remove("has-mana-globe"); return; }
  section.hidden = false;
  hudRoot.classList.add("has-mana-globe");
  const NS = "http://www.w3.org/2000/svg";
  const addPath = (path, key, index, slotLabel, value, max, color, isPact = false, trackColor = "#273233") => {
    const node = document.createElementNS(NS, "path");
    node.setAttribute("d", path); node.setAttribute("fill", index < value ? color : (isPact ? "#342d46" : trackColor));
    node.setAttribute("stroke", isPact ? "#15141d" : "#141b1c"); node.setAttribute("stroke-width", "1.8");
    node.classList.add("ahud-mana-slot", index < value ? "is-filled" : "is-empty");
    if (isPact) node.classList.add("is-pact");
    const description = `${slotLabel} · ${index < value ? game.i18n.localize("ACTION_HUD.slotAvailable") : game.i18n.localize("ACTION_HUD.slotUsed")} · ${value}/${max}`;
    node.setAttribute("aria-label", description); node.setAttribute("role", "img");
    const title = document.createElementNS(NS, "title"); title.textContent = description; node.appendChild(title);
    if (game.user.isGM && activeToken) {
      node.classList.add("is-adjustable"); node.setAttribute("tabindex", "0"); node.setAttribute("role", "button");
      const adjust = async () => {
        const liveSlot = activeActor?.system.spells?.[key];
        if (!activeActor || !activeToken || !liveSlot) return;
        const current = Math.max(0, Math.min(Number(liveSlot.max) || 0, Number(liveSlot.value) || 0));
        const next = Math.max(0, Math.min(Number(liveSlot.max) || 0, current + (index < current ? -1 : 1)));
        if (next === current) return;
        await activeActor.update({ [`system.spells.${key}.value`]: next });
      };
      node.addEventListener("click", event => { event.preventDefault(); void adjust(); });
      node.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void adjust(); } });
    }
    svg.appendChild(node);
  };
  if (pact) {
    const gap = 2.2, perSlot = (360 - gap * pact.max) / pact.max;
    const pactLabel = pact.level > 0
      ? `${game.i18n.localize("ACTION_HUD.pactMagicSlots")} · ${game.i18n.localize("ACTION_HUD.level")} ${pact.level}`
      : game.i18n.localize("ACTION_HUD.pactMagicSlots");
    for (let i = 0; i < pact.max; i++) {
      const start = -90 + i * perSlot + gap / 2;
      const end = -90 + (i + 1) * perSlot - gap / 2;
      addPath(svgSector(100, 100, 73, 63, start, end), "pact", i, pactLabel, pact.value, pact.max, "#aa8be8", true);
    }
  }
  if (levels.length) {
    const total = levels.reduce((sum, slot) => sum + slot.max, 0);
    const groupGap = 4, slotGap = Math.min(2.2, (360 - levels.length * groupGap) / Math.max(total, 1) * .13);
    const perSlot = (360 - levels.length * groupGap) / total;
    const levelColors = { 1: "#6fd6c7", 2: "#69b9e8", 3: "#8b9bf5", 4: "#b49af3", 5: "#de91dc", 6: "#eb9fbd", 7: "#e9af78", 8: "#e4cd78", 9: "#e6e9ee" };
    const trackColors = { 1: "#28514c", 2: "#29475a", 3: "#303959", 4: "#41375b", 5: "#50314f", 6: "#522f40", 7: "#553c2e", 8: "#56502c", 9: "#48494b" };
    let cursor = -90;
    for (const slot of levels) {
      const color = levelColors[slot.level] ?? "#8fcfc4";
      const label = `${game.i18n.localize("ACTION_HUD.level")} ${slot.level} ${game.i18n.localize("ACTION_HUD.spellSlots")}`;
      const groupStart = cursor;
      for (let i = 0; i < slot.max; i++) {
        const start = cursor + slotGap / 2;
        const end = cursor + perSlot - slotGap / 2;
        addPath(svgSector(100, 100, 96, 82, start, end), slot.key, i, label, slot.value, slot.max, color, false, trackColors[slot.level] ?? "#273233");
        cursor += perSlot;
      }
      // Place the level badge near the beginning of this level's arc rather
      // than centering it over the whole section. A small angular inset keeps
      // the badge readable while visually tying it to the first slot.
      const labelAngle = groupStart + 6;
      const radians = labelAngle * Math.PI / 180;
      const labelX = 100 + 89 * Math.cos(radians);
      const labelY = 100 + 89 * Math.sin(radians);
      // A dark circular badge keeps the slot-level number readable without
      // moving it outward into the HUD edge or inward over Pact Magic slots.
      const levelBadge = document.createElementNS(NS, "circle");
      levelBadge.setAttribute("cx", String(labelX));
      levelBadge.setAttribute("cy", String(labelY));
      levelBadge.setAttribute("r", "9.1");
      levelBadge.setAttribute("fill", "#102329");
      levelBadge.setAttribute("stroke", color);
      levelBadge.setAttribute("stroke-width", "1.7");
      levelBadge.setAttribute("class", "ahud-mana-level-badge");
      svg.appendChild(levelBadge);
      const levelText = document.createElementNS(NS, "text");
      levelText.setAttribute("x", String(labelX));
      levelText.setAttribute("y", String(labelY));
      levelText.setAttribute("fill", "#f7ffff"); levelText.setAttribute("font-size", "13");
      levelText.setAttribute("font-weight", "900"); levelText.setAttribute("text-anchor", "middle"); levelText.setAttribute("dominant-baseline", "middle");
      levelText.setAttribute("class", "ahud-mana-level-label"); levelText.textContent = String(slot.level);
      svg.appendChild(levelText);
      cursor += groupGap;
    }
  }
  if (indyDice.active) {
    // The die itself communicates the current value; no separate heading is
    // shown so the natural face can be large and readable in the orb.
    renderD20Die(center, indyDice.value);
    const source = game.i18n.localize("ACTION_HUD.spellSlotsTooltip");
    const adjustHint = game.user.isGM && activeToken ? game.i18n.localize("ACTION_HUD.gmAdjustSlots") : "";
    const rollHint = indyDice.value === null
      ? game.i18n.localize("ACTION_HUD.waitingForD20")
      : `${game.i18n.localize("ACTION_HUD.latestD20")}: ${indyDice.value}`;
    section.title = [source, adjustHint, rollHint].filter(Boolean).join(" · ");
  } else {
    const dcHeading = document.createElement("span"); dcHeading.className = "ahud-mana-label"; dcHeading.textContent = game.i18n.localize("ACTION_HUD.spellDC"); center.appendChild(dcHeading);
    const dcList = document.createElement("div"); dcList.className = "ahud-mana-dcs";
    if (dcs.length) {
      for (const entry of dcs) {
        const span = document.createElement("span"); span.className = "ahud-mana-dc"; span.textContent = String(entry.dc); span.title = `${entry.label}: ${game.i18n.localize("ACTION_HUD.spellDC")} ${entry.dc}`; dcList.appendChild(span);
      }
    } else {
      const span = document.createElement("span"); span.className = "ahud-mana-dc is-none"; span.textContent = "—"; dcList.appendChild(span);
    }
    center.appendChild(dcList);
    const source = game.i18n.localize("ACTION_HUD.spellSlotsTooltip");
    section.title = `${source}${game.user.isGM && activeToken ? ` · ${game.i18n.localize("ACTION_HUD.gmAdjustSlots")}` : ""}`;
  }
}
function renderResources(actor) {
  renderHitDice(actor);
  renderManaGlobe(actor);
}

async function runTeamRest(type) {
  if (!game.user.isGM) return;
  const party = game.actors?.party;
  if (!party || party.type !== "group") {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.noPrimaryParty"));
    return;
  }
  try {
    // Use the system's primary Party/Group actor workflow so D&D 5e opens its native
    // group-rest dialog and applies the same options as the actor sheet.
    if (type === "short") await party.shortRest();
    else await party.longRest();
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to start team ${type} rest`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.teamRestFailed"));
  }
}
function getMovementSpeed(actor, actionId) {
  const movement = actor?.system?.attributes?.movement ?? {};
  const direct = Number(movement[actionId]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const normalized = String(actionId ?? "").toLowerCase();
  const key = ["walk", "fly", "burrow", "swim", "climb"].find(type => normalized === type || normalized.startsWith(`${type}-`));
  if (key) {
    const speed = Number(movement[key]);
    // Never substitute walking speed for a movement mode the actor does not possess.
    return Number.isFinite(speed) && speed > 0 ? speed : 0;
  }
  if (normalized === "crawl") {
    const walk = Number(movement.walk);
    return Number.isFinite(walk) && walk > 0 ? Math.floor(walk / 2) : 0;
  }
  const multiplier = Number(CONFIG.Token?.movement?.actions?.[actionId]?.speedMultiplier);
  if (Number.isFinite(multiplier) && multiplier > 0 && Number(movement.walk) > 0) return Math.round(Number(movement.walk) * multiplier);
  return 0;
}
function getMovementActionInfo(actionId) {
  const config = CONFIG.Token?.movement?.actions?.[actionId] ?? {};
  const label = game.i18n.localize(config.label ?? actionId ?? "Walk");
  const icons = { walk: "fas fa-person-walking", fly: "fas fa-feather-pointed", burrow: "fas fa-shovel", swim: "fas fa-person-swimming", climb: "fas fa-mountain", crawl: "fas fa-person-crawling" };
  return { config, label, icon: config.icon || icons[String(actionId).toLowerCase()] || "fas fa-person-walking" };
}
function renderMovement(actor) {
  const button = hudRoot.querySelector("[data-action=movement-menu]");
  const icon = button.querySelector("[data-movement-icon]");
  const speed = button.querySelector('[data-stat="speed"]');
  const actionId = activeToken?.document?.movementAction ?? CONFIG.Token?.movement?.defaultAction ?? "walk";
  const info = getMovementActionInfo(actionId);
  icon.className = info.icon;
  const value = getMovementSpeed(actor, actionId);
  const units = actor?.system?.attributes?.movement?.units ?? "";
  speed.textContent = actor && value > 0 ? `${value}${units ? ` ${units}` : ""}` : "—";
  button.disabled = !activeToken || (game.user.isGM && gmMode);
  button.title = `${game.i18n.localize("ACTION_HUD.movementType")}: ${info.label}${actor && value > 0 ? ` · ${value} ${units}` : ""}`;
  button.setAttribute("aria-expanded", String(!hudRoot.querySelector("[data-movement-menu]").hidden));
}
function toggleMovementMenu() {
  if (!activeToken) return;
  const menu = hudRoot.querySelector("[data-movement-menu]");
  if (!menu.hidden) { menu.hidden = true; hudRoot.querySelector('[data-action="movement-menu"]').setAttribute("aria-expanded", "false"); return; }
  renderMovementMenu(); menu.hidden = false;
  hudRoot.querySelector('[data-action="movement-menu"]').setAttribute("aria-expanded", "true");
}
function renderMovementMenu() {
  const menu = hudRoot.querySelector("[data-movement-menu]");
  menu.replaceChildren();
  const heading = document.createElement("div"); heading.className = "ahud-movement-menu-title"; heading.textContent = game.i18n.localize("ACTION_HUD.movementType"); menu.appendChild(heading);
  const actions = CONFIG.Token?.movement?.actions ?? {};
  const current = activeToken?.document?.movementAction ?? CONFIG.Token?.movement?.defaultAction ?? "walk";
  const entries = Object.entries(actions).sort((a,b) => Number(a[1]?.order ?? 0) - Number(b[1]?.order ?? 0));
  for (const [id, action] of entries) {
    const canSelect = typeof action.canSelect === "function" ? action.canSelect(activeToken.document) : action.canSelect !== false;
    if (!canSelect && id !== current) continue;
    const info = getMovementActionInfo(id);
    const row = document.createElement("button"); row.type = "button"; row.dataset.action = "set-movement"; row.dataset.movementAction = id;
    row.className = "ahud-movement-option"; row.classList.toggle("is-current", id === current);
    const icon = document.createElement("i"); icon.className = info.icon;
    const label = document.createElement("span"); label.textContent = info.label;
    const movementSpeed = getMovementSpeed(activeActor, id);
    const units = activeActor?.system?.attributes?.movement?.units ?? "";
    const value = document.createElement("small"); value.textContent = movementSpeed > 0 ? `${movementSpeed}${units ? ` ${units}` : ""}` : "";
    row.append(icon, label, value);
    menu.appendChild(row);
  }
}
async function setMovementAction(actionId) {
  if (!activeToken || !actionId) return;
  const action = CONFIG.Token?.movement?.actions?.[actionId];
  if (!action) return;
  if (typeof action.canSelect === "function" && !action.canSelect(activeToken.document) && actionId !== activeToken.document.movementAction) return;
  try {
    await activeToken.document.update({ movementAction: actionId });
    hudRoot.querySelector("[data-movement-menu]").hidden = true;
    renderMovement(activeActor);
  } catch (error) {
    console.error(`${MODULE_ID} | Could not change movement action`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.movementChangeFailed"));
  }
}
function openDrawer(name, force = false) {
  if (name !== "spells") closeSpellTooltip(true);
  const panel = hudRoot.querySelector("[data-drawer-panel]");
  if (!force && !panel.hidden && panel.dataset.currentDrawer === name) { panel.hidden = true; return; }
  panel.hidden = false; panel.dataset.currentDrawer = name; panel.replaceChildren();
  panel.classList.toggle("ahud-condition-drawer", name === "conditions");
  panel.classList.toggle("ahud-spellbook-drawer", name === "spells");
  panel.classList.toggle("ahud-features-drawer", name === "features");
  panel.classList.toggle("ahud-item-drawer", name === "inventory");
  panel.classList.toggle("ahud-checks-drawer", name === "checks");
  panel.classList.toggle("ahud-quick-dice-drawer", name === "quick-dice");
  panel.classList.toggle("ahud-combat-actions-drawer", name === "combat-actions");
  panel.classList.toggle("ahud-gm-tools-drawer", name === "gm-tools");
  const title = document.createElement("div"); title.className = "ahud-drawer-title";
  title.textContent = ({ checks: "Checks & Saves", features: "Features", inventory: "Inventory", spells: "Spellbook", conditions: game.i18n.localize("ACTION_HUD.conditions"), "quick-dice": game.i18n.localize("ACTION_HUD.quickDice"), "combat-actions": game.i18n.localize("ACTION_HUD.combatActions"), "gm-tools": game.i18n.localize("ACTION_HUD.encounterControls") })[name] ?? name;
  // Checks, Spellbook and Conditions use compact grouped layouts without an extra title row.
  if (!["conditions", "spells", "checks", "features", "inventory"].includes(name)) panel.appendChild(title);
  // Every drawer uses content-driven height. The Conditions drawer used to set its
  // height to the full distance above the bar, which created a mostly empty panel.
  panel.style.height = "";
  if (name === "conditions" && game.user.isGM && gmMode) {
    renderConditionsPanel(panel);
    return;
  }
  if (name === "gm-tools" && game.user.isGM && gmMode) { renderGMToolsPanel(panel); return; }
  if (name === "quick-dice") { renderQuickDicePanel(panel); return; }
  if (!activeActor) { panel.append("Select an actor to view this panel."); return; }
  if (name === "combat-actions") { renderCombatActionsPanel(panel); return; }
  if (name === "checks") renderChecksPanel(panel);
  else if (name === "spells") renderSpellbookPanel(panel);
  else if (name === "features") renderFeaturesPanel(panel);
  else if (name === "inventory") renderItemPanel(panel, name);
}
function renderFeaturesPanel(panel) {
  const actor = activeActor;
  const actorItems = actor?.items?.contents ?? [];
  const features = actorItems
    .filter(item => ["feat", "class", "subclass", "race", "species", "background"].includes(item.type))
    .sort(compareBrowserItemPriority);

  const classes = actorItems.filter(item => item.type === "class");
  const subclasses = actorItems.filter(item => item.type === "subclass");
  const raceDocs = actorItems.filter(item => ["race", "species"].includes(item.type));
  const backgroundDocs = actorItems.filter(item => item.type === "background");
  const memberships = new Map();
  for (const item of features) memberships.set(item.uuid, featureCategoryId(actor, item));

  const categoryDefinitions = [];
  const addClassCategory = item => categoryDefinitions.push({
    id: `class:${item.id}`, kind: "class", label: item.name, icon: item.img || "systems/dnd5e/icons/svg/items/class.svg", sourceItem: item
  });
  const addSubclassCategory = item => categoryDefinitions.push({
    id: `subclass:${item.id}`, kind: "subclass", label: item.name, icon: item.img || "systems/dnd5e/icons/svg/items/subclass.svg", sourceItem: item
  });

  // Keep each subclass adjacent to its owning class where the D&D 5e classIdentifier
  // relation is available. This makes multiclass tab order immediately understandable.
  const assignedSubclasses = new Set();
  for (const classItem of classes) {
    addClassCategory(classItem);
    const identifier = String(classItem.system?.identifier ?? "").toLowerCase();
    const matchingSubclasses = subclasses.filter(subclass => {
      if (assignedSubclasses.has(subclass.id)) return false;
      const classIdentifier = String(subclass.system?.classIdentifier ?? "").toLowerCase();
      return identifier && classIdentifier === identifier;
    });
    for (const subclass of matchingSubclasses) {
      assignedSubclasses.add(subclass.id);
      addSubclassCategory(subclass);
    }
  }
  for (const subclass of subclasses) if (!assignedSubclasses.has(subclass.id)) addSubclassCategory(subclass);

  const raceHasContent = features.some(item => memberships.get(item.uuid) === "racial");
  if (raceHasContent) {
    const race = raceDocs[0];
    const fallbackRaceName = actor?.system?.details?.race || actor?.system?.details?.species || game.i18n.localize("ACTION_HUD.featureTabRacial");
    categoryDefinitions.push({ id: "racial", kind: "race", label: race?.name || fallbackRaceName, icon: race?.img || "systems/dnd5e/icons/svg/items/race.svg", sourceItem: race });
  }
  const backgroundHasContent = features.some(item => memberships.get(item.uuid) === "background");
  if (backgroundHasContent) {
    const background = backgroundDocs[0];
    const fallbackBackgroundName = actor?.system?.details?.background || game.i18n.localize("ACTION_HUD.featureTabBackground");
    categoryDefinitions.push({ id: "background", kind: "background", label: background?.name || fallbackBackgroundName, icon: background?.img || "systems/dnd5e/icons/svg/items/background.svg", sourceItem: background });
  }
  if (features.some(item => memberships.get(item.uuid) === "other")) {
    categoryDefinitions.push({ id: "other", kind: "other", label: game.i18n.localize("ACTION_HUD.featureTabOther"), icon: "icons/commodities/tech/cog-gold.webp" });
  }

  const categoryItems = new Map();
  for (const definition of categoryDefinitions) {
    const matches = features.filter(item => memberships.get(item.uuid) === definition.id);
    if (matches.length) categoryItems.set(definition.id, matches);
  }
  const categories = categoryDefinitions.filter(definition => categoryItems.has(definition.id));
  if (!categories.length) {
    const empty = document.createElement("div"); empty.className = "ahud-empty-state";
    empty.textContent = game.i18n.localize("ACTION_HUD.noItemsFound"); panel.appendChild(empty); return;
  }

  let selectedCategory = categories[0].id;
  const activeActivationFilters = new Set();
  const tabs = document.createElement("div"); tabs.className = "ahud-spell-tabs ahud-feature-tabs"; tabs.setAttribute("role", "tablist");
  const tabButtons = new Map();
  for (const definition of categories) {
    const button = document.createElement("button"); button.type = "button"; button.className = "ahud-spell-tab ahud-feature-tab";
    button.title = definition.label; button.setAttribute("aria-label", definition.label); button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false"); button.dataset.category = definition.id;
    const image = document.createElement("img"); image.src = definition.icon; image.alt = ""; image.loading = "lazy"; image.setAttribute("aria-hidden", "true"); button.appendChild(image);
    const count = document.createElement("small"); count.className = "ahud-spell-tab-count"; count.textContent = String(categoryItems.get(definition.id).length); button.appendChild(count);
    button.addEventListener("click", () => { selectedCategory = definition.id; draw(); });
    tabs.appendChild(button); tabButtons.set(definition.id, button);
  }
  panel.appendChild(tabs);

  const controls = document.createElement("div"); controls.className = "ahud-spellbook-controls ahud-feature-controls";
  const search = document.createElement("input"); search.className = "ahud-filter ahud-spell-search"; search.type = "search";
  search.placeholder = game.i18n.localize("ACTION_HUD.filterItems"); search.setAttribute("aria-label", game.i18n.localize("ACTION_HUD.filterItems")); controls.appendChild(search);
  const activationFilters = document.createElement("div"); activationFilters.className = "ahud-spell-activation-filters";
  const filterDefinitions = [
    { id: "action", label: game.i18n.localize("ACTION_HUD.spellFilterAction"), marker: "●" },
    { id: "bonus", label: game.i18n.localize("ACTION_HUD.spellFilterBonus"), marker: "▲" },
    { id: "reaction", label: game.i18n.localize("ACTION_HUD.spellFilterReaction"), marker: "✦" }
  ];
  const activationButtons = new Map();
  for (const definition of filterDefinitions) {
    const button = document.createElement("button"); button.type = "button"; button.className = `ahud-spell-activation-filter is-${definition.id}`;
    button.title = definition.label; button.setAttribute("aria-label", definition.label); button.setAttribute("aria-pressed", "false");
    const marker = document.createElement("span"); marker.className = `ahud-action-marker is-${definition.id}`; marker.textContent = definition.marker;
    marker.setAttribute("aria-hidden", "true"); button.appendChild(marker);
    button.addEventListener("click", () => {
      if (activeActivationFilters.has(definition.id)) activeActivationFilters.delete(definition.id);
      else activeActivationFilters.add(definition.id);
      draw();
    });
    activationFilters.appendChild(button); activationButtons.set(definition.id, button);
  }
  controls.appendChild(activationFilters); panel.appendChild(controls);

  const grid = document.createElement("div"); grid.className = "ahud-spell-grid ahud-feature-grid"; panel.appendChild(grid);
  const draw = () => {
    for (const definition of categories) {
      const button = tabButtons.get(definition.id);
      const active = definition.id === selectedCategory;
      button.classList.toggle("is-active", active); button.setAttribute("aria-selected", String(active));
    }
    for (const definition of filterDefinitions) {
      const button = activationButtons.get(definition.id);
      const active = activeActivationFilters.has(definition.id);
      button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active));
    }
    grid.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase(game.i18n.lang || undefined);
    const matches = categoryItems.get(selectedCategory).filter(item => item.name.toLocaleLowerCase(game.i18n.lang || undefined).includes(query));
    for (const item of matches) {
      const types = itemActivationTypes(item);
      const useState = getItemActionAvailability(actor, item);
      const matchedTypes = [...activeActivationFilters].filter(type => types.has(type));
      const tile = document.createElement("button"); tile.type = "button"; tile.className = "ahud-spell-tile ahud-feature-tile";
      tile.classList.toggle("is-filter-highlighted", matchedTypes.length > 0);
      for (const type of ["action", "bonus", "reaction"]) tile.classList.toggle(`is-filter-match-${type}`, matchedTypes.includes(type));
      tile.classList.toggle("is-action-used", useState.blocked);
      tile.classList.toggle("is-unavailable", !activeToken);
      tile.dataset.itemUuid = item.uuid; tile.dataset.itemId = item.id;
      const img = document.createElement("img"); img.src = item.img; img.alt = ""; img.loading = "lazy";
      const label = document.createElement("span"); label.className = "ahud-spell-tile-name"; label.textContent = item.name;
      tile.append(img, label);
      const resourceIndicators = renderTileResourceIndicators(tile, item);
      const quantityIndicator = renderInventoryQuantityBadge(tile, item);
      if (matchedTypes.length) {
        const tileMarkers = document.createElement("span"); tileMarkers.className = "ahud-spell-tile-markers";
        for (const type of matchedTypes) {
          const marker = document.createElement("span"); marker.className = `ahud-action-marker is-${type}`;
          marker.textContent = filterDefinitions.find(def => def.id === type)?.marker ?? "";
          marker.setAttribute("aria-hidden", "true"); tileMarkers.appendChild(marker);
        }
        tile.appendChild(tileMarkers);
      }
      const activationNames = [...types].map(type => ({
        action: game.i18n.localize("ACTION_HUD.spellFilterAction"),
        bonus: game.i18n.localize("ACTION_HUD.spellFilterBonus"),
        reaction: game.i18n.localize("ACTION_HUD.spellFilterReaction")
      })[type]).filter(Boolean);
      tile.dataset.resourceBaseAria = [item.name, activationNames.join(" / "), useState.blocked ? useState.reason : ""].filter(Boolean).join(". ");
      tile.setAttribute("aria-label", [tile.dataset.resourceBaseAria, ...resourceIndicators.map(indicator => indicator.title), quantityIndicator?.title].filter(Boolean).join(". "));
      attachDocumentTooltip(tile, item, "item");
      tile.addEventListener("click", async () => {
        if (!activeActor || activeActor.uuid !== actor.uuid) return;
        if (!activeToken) { item.sheet?.render(true); return; }
        closeSpellTooltip(true);
        try {
          if (typeof item.use === "function") await item.use();
          else item.sheet?.render(true);
        } catch (error) {
          console.error(`${MODULE_ID} | Failed to use feature ${item.name}`, error);
          ui.notifications.error(game.i18n.localize("ACTION_HUD.spellUseFailed"));
        }
      });
      tile.addEventListener("contextmenu", event => { event.preventDefault(); item.sheet?.render(true); });
      enableHudItemDrag(tile, item);
      grid.appendChild(tile);
    }
    if (!matches.length) {
      const empty = document.createElement("div"); empty.className = "ahud-empty-state ahud-spell-empty";
      empty.textContent = game.i18n.localize("ACTION_HUD.noItemsFound"); grid.appendChild(empty);
    }
  };
  search.addEventListener("input", draw);
  draw();
}

function featureCategoryId(actor, item) {
  if (item.type === "class") return `class:${item.id}`;
  if (item.type === "subclass") return `subclass:${item.id}`;
  if (["race", "species"].includes(item.type)) return "racial";
  if (item.type === "background") return "background";

  // Resolve the item-grant origin to the root actor item so multiclass and background
  // features appear beside the image of the class/subclass/origin that grants them.
  const origin = item.getFlag?.("dnd5e", "advancementRoot")
    ?? item.getFlag?.("dnd5e", "advancementOrigin")
    ?? item.flags?.dnd5e?.advancementRoot
    ?? item.flags?.dnd5e?.advancementOrigin;
  if (typeof origin !== "string" || !origin) return "other";
  const actorItemMatch = origin.match(/(?:^|\.)Item\.([^.]+)/);
  const sourceId = actorItemMatch?.[1] ?? origin.split(".")[0];
  const sourceItem = actor?.items?.get?.(sourceId) ?? null;
  if (sourceItem?.type === "class") return `class:${sourceItem.id}`;
  if (sourceItem?.type === "subclass") return `subclass:${sourceItem.id}`;
  if (["race", "species"].includes(sourceItem?.type)) return "racial";
  if (sourceItem?.type === "background") return "background";
  return "other";
}

function canEditCurrentActor() {
  return Boolean(activeActor && (game.user.isGM || activeActor.testUserPermission(game.user, "OWNER")));
}

function isWeaponSetShield(item) {
  if (item?.type !== "equipment") return false;
  const subtype = String(item.system?.type?.value ?? item.system?.armor?.type ?? item.system?.type?.subtype ?? "").toLowerCase();
  return subtype === "shield";
}

function isUnarmedStrikeItem(item) {
  const name = String(item?.name ?? "").trim().toLowerCase();
  return name === "unarmed strike" || spellHasProperty(item, "unarmed") || String(item?.system?.type?.value ?? "").toLowerCase() === "unarmed";
}

function isWeaponSetFocusableWeapon(item) {
  // A weapon that doubles as an explicitly tagged spellcasting focus is not toggled
  // by weapon-set changes. The user's other foci, rods, jewelry, armor, and equipment
  // are excluded by requiring a Weapon or Shield item below.
  return item?.type === "weapon" && !isUnarmedStrikeItem(item) && !spellHasProperty(item, "foc");
}

function isWeaponSetItem(item) {
  return Boolean(item && typeof item.system?.equipped === "boolean"
    && (isWeaponSetFocusableWeapon(item) || isWeaponSetShield(item)));
}

function isWeaponSetTwoHanded(item) {
  return Boolean(item?.type === "weapon" && spellHasProperty(item, "two"));
}

function weaponSetItemReference(item) {
  return item ? { id: item.id, name: item.name, img: item.img, type: item.type } : null;
}

function getWeaponSetItem(actor, entry) {
  if (!actor || !entry?.id) return null;
  const item = actor.items?.get?.(entry.id) ?? null;
  return isWeaponSetItem(item) ? item : null;
}

function getWeaponSets() {
  const stored = getConfigDocument()?.getFlag(MODULE_ID, "weaponSets");
  const source = Array.isArray(stored) ? stored : [];
  const count = Math.max(DEFAULT_WEAPON_SET_COUNT, Math.min(MAX_WEAPON_SET_COUNT, source.length));
  const normalizeEntry = entry => entry && typeof entry === "object" && entry.id
    ? { id: String(entry.id), name: String(entry.name ?? "Item"), img: String(entry.img ?? "icons/svg/item-bag.svg"), type: String(entry.type ?? "") }
    : null;
  return Array.from({ length: count }, (_, index) => ({
    mainHand: normalizeEntry(source[index]?.mainHand),
    offHand: normalizeEntry(source[index]?.offHand)
  }));
}

async function saveWeaponSets(sets) {
  const doc = getConfigDocument();
  if (!doc || !canEditCurrentActor()) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetNoPermission"));
    return false;
  }
  const safeSets = sets.slice(0, MAX_WEAPON_SET_COUNT).map(set => ({
    mainHand: set?.mainHand ? { ...set.mainHand } : null,
    offHand: set?.offHand ? { ...set.offHand } : null
  }));
  while (safeSets.length < DEFAULT_WEAPON_SET_COUNT) safeSets.push({ mainHand: null, offHand: null });
  try {
    await doc.setFlag(MODULE_ID, "weaponSets", safeSets);
    return true;
  } catch (error) {
    console.error(`${MODULE_ID} | Could not save weapon sets`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.weaponSetSaveFailed"));
    return false;
  }
}

function weaponSetMatchesCurrent(actor, set) {
  if (!actor) return false;
  const mainEntry = set?.mainHand;
  const offEntry = set?.offHand;
  const mainItem = mainEntry ? getWeaponSetItem(actor, mainEntry) : null;
  const offItem = offEntry ? getWeaponSetItem(actor, offEntry) : null;
  if ((mainEntry && !mainItem) || (offEntry && !offItem)) return false;
  if (!mainItem && !offItem) return false;
  if (mainItem && isWeaponSetShield(mainItem)) return false;
  if (offItem && isWeaponSetTwoHanded(offItem)) return false;
  const selected = new Set();
  if (mainItem) selected.add(mainItem.id);
  if (!mainItem || !isWeaponSetTwoHanded(mainItem)) if (offItem) selected.add(offItem.id);
  const equipped = (actor.items?.contents ?? []).filter(item => isWeaponSetItem(item) && item.system.equipped).map(item => item.id);
  return equipped.length === selected.size && equipped.every(id => selected.has(id));
}

function weaponSetSlotTitle(index, hand, entry, ghost = false) {
  const handLabel = game.i18n.localize(hand === "mainHand" ? "ACTION_HUD.weaponSetMainHand" : "ACTION_HUD.weaponSetOffHand");
  const itemName = entry?.name ?? game.i18n.localize("ACTION_HUD.weaponSetEmpty");
  return `${game.i18n.localize("ACTION_HUD.weaponSet")} ${index + 1} · ${handLabel}: ${itemName}${ghost ? ` · ${game.i18n.localize("ACTION_HUD.weaponSetTwoHanded")}` : ""}\n${game.i18n.localize("ACTION_HUD.weaponSetClickToEquip")}\n${game.i18n.localize("ACTION_HUD.weaponSetDropToAssign")}\n${game.i18n.localize("ACTION_HUD.weaponSetRightClickToRemove")}`;
}

function renderWeaponSetToolbar(host, actor = activeActor) {
  if (!host) return;
  const previousScrollLeft = host.querySelector(".ahud-weapon-set-list")?.scrollLeft ?? 0;
  host.replaceChildren();
  if (!actor) { host.hidden = true; return; }
  host.hidden = false;
  const sets = getWeaponSets();
  const list = document.createElement("div"); list.className = "ahud-weapon-set-list";
  const editable = canEditCurrentActor();
  sets.forEach((set, index) => {
    const group = document.createElement("div"); group.className = "ahud-weapon-set"; group.dataset.weaponSetIndex = String(index);
    group.classList.toggle("is-current", weaponSetMatchesCurrent(actor, set));
    group.title = `${game.i18n.localize("ACTION_HUD.weaponSet")} ${index + 1}`;
    const number = document.createElement("span"); number.className = "ahud-weapon-set-number"; number.textContent = String(index + 1); number.setAttribute("aria-hidden", "true"); group.appendChild(number);
    const mainItem = getWeaponSetItem(actor, set.mainHand);
    const twoHanded = Boolean(mainItem && isWeaponSetTwoHanded(mainItem));
    list.appendChild(group);
    for (const hand of ["mainHand", "offHand"]) {
      const ghost = hand === "offHand" && twoHanded;
      const entry = ghost ? set.mainHand : set[hand];
      const item = ghost ? mainItem : getWeaponSetItem(actor, entry);
      const button = document.createElement("button"); button.type = "button";
      button.className = `ahud-weapon-set-slot ${hand === "mainHand" ? "is-main-hand" : "is-off-hand"}`;
      if (ghost) button.classList.add("is-ghost");
      if (entry && !item && !ghost) button.classList.add("is-missing");
      button.dataset.weaponSetSlot = "true"; button.dataset.weaponSetIndex = String(index); button.dataset.weaponSetHand = hand; button.dataset.weaponSetGhost = String(ghost);
      button.disabled = !editable;
      button.title = weaponSetSlotTitle(index, hand, entry, ghost);
      button.setAttribute("aria-label", button.title);
      if (item?.img || (entry && !ghost && entry.img)) {
        const image = document.createElement("img"); image.src = item?.img ?? entry.img; image.alt = ""; image.draggable = false; image.loading = "lazy"; button.appendChild(image);
      } else {
        const icon = document.createElement("i"); icon.className = hand === "mainHand" ? "fas fa-sword" : "fas fa-shield-halved"; icon.setAttribute("aria-hidden", "true"); button.appendChild(icon);
      }
      button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void equipWeaponSet(index); });
      button.addEventListener("contextmenu", event => {
        event.preventDefault(); event.stopPropagation();
        void removeWeaponSetAssignment(index, ghost ? "mainHand" : hand);
      });
      button.addEventListener("dragover", event => {
        if (!editable) return;
        event.preventDefault(); event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        button.classList.add("is-drop-target");
      });
      button.addEventListener("dragleave", event => { if (!button.contains(event.relatedTarget)) button.classList.remove("is-drop-target"); });
      button.addEventListener("drop", event => {
        event.preventDefault(); event.stopPropagation(); button.classList.remove("is-drop-target");
        void handleWeaponSetDrop(event, index, hand);
      });
      group.appendChild(button);
    }
  });
  host.appendChild(list);
  list.scrollLeft = previousScrollLeft;
  const add = document.createElement("button"); add.type = "button"; add.className = "ahud-weapon-set-add";
  add.textContent = "+"; add.title = game.i18n.localize("ACTION_HUD.weaponSetAdd"); add.setAttribute("aria-label", add.title);
  add.disabled = !editable || sets.length >= MAX_WEAPON_SET_COUNT; add.hidden = sets.length >= MAX_WEAPON_SET_COUNT;
  add.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void addWeaponSet(); });
  host.appendChild(add);
}

async function addWeaponSet() {
  if (!canEditCurrentActor()) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetNoPermission"));
  const sets = getWeaponSets();
  if (sets.length >= MAX_WEAPON_SET_COUNT) return ui.notifications.info(game.i18n.localize("ACTION_HUD.weaponSetMaxReached"));
  sets.push({ mainHand: null, offHand: null });
  if (await saveWeaponSets(sets)) {
    const host = hudRoot?.querySelector("[data-weapon-sets]");
    if (host) renderWeaponSetToolbar(host, activeActor);
  }
}

async function removeWeaponSetAssignment(index, hand) {
  if (!canEditCurrentActor()) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetNoPermission"));
  const sets = getWeaponSets();
  const set = sets[index];
  if (!set?.[hand]) return;
  const entry = set[hand];
  const handLabel = game.i18n.localize(hand === "mainHand" ? "ACTION_HUD.weaponSetMainHand" : "ACTION_HUD.weaponSetOffHand");
  const content = `<p>${game.i18n.format("ACTION_HUD.weaponSetRemoveConfirm", { item: foundry.utils.escapeHTML(entry.name ?? "Item"), set: index + 1, hand: handLabel })}</p>`;
  const confirmed = await confirmHudDialog(game.i18n.localize("ACTION_HUD.weaponSetRemoveTitle"), content);
  if (!confirmed) return;
  // A two-handed main-hand weapon owns the visual off-hand ghost, so clearing it also
  // guarantees no hidden conflicting off-hand assignment survives.
  if (hand === "mainHand") {
    const item = getWeaponSetItem(activeActor, set.mainHand);
    set.mainHand = null;
    if (item && isWeaponSetTwoHanded(item)) set.offHand = null;
  } else set.offHand = null;
  if (await saveWeaponSets(sets)) {
    const host = hudRoot?.querySelector("[data-weapon-sets]");
    if (host) renderWeaponSetToolbar(host, activeActor);
  }
}

async function handleWeaponSetDrop(event, index, hand) {
  const actor = activeActor;
  if (!actor || !canEditCurrentActor()) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetNoPermission"));
  const payload = readDragPayload(event.dataTransfer);
  const uuid = payload?.uuid || payload?.data?.uuid || safeTransferGet(event.dataTransfer, "text/uuid");
  let item = null;
  if (uuid) { try { item = await fromUuid(uuid); } catch (_) {} }
  if (!item && (payload?.type === "Item" || payload?.data?.type === "Item" || payload?.documentName === "Item")) {
    const id = payload.id || payload._id || payload.data?._id || payload.data?.id;
    item = actor.items?.get?.(id) ?? null;
  }
  if (!item || item.documentName !== "Item") return ui.notifications.info(game.i18n.localize("ACTION_HUD.weaponSetDropItemHint"));
  if (item.parent?.id !== actor.id) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetOwnItemsOnly"));
  if (!isWeaponSetItem(item)) return ui.notifications.info(game.i18n.format("ACTION_HUD.weaponSetUnsupportedItem", { item: foundry.utils.escapeHTML(item.name) }));
  if (hand === "mainHand" && isWeaponSetShield(item)) return ui.notifications.info(game.i18n.localize("ACTION_HUD.weaponSetShieldOffHandOnly"));
  if (hand === "offHand" && isWeaponSetTwoHanded(item)) return ui.notifications.info(game.i18n.localize("ACTION_HUD.weaponSetTwoHandedMainHandOnly"));
  const sets = getWeaponSets();
  if (!sets[index]) return;
  const currentMain = getWeaponSetItem(actor, sets[index].mainHand);
  if (hand === "offHand" && currentMain && isWeaponSetTwoHanded(currentMain)) {
    return ui.notifications.info(game.i18n.localize("ACTION_HUD.weaponSetMainHandUsesBoth"));
  }
  sets[index][hand] = weaponSetItemReference(item);
  if (hand === "mainHand" && isWeaponSetTwoHanded(item)) sets[index].offHand = null;
  if (await saveWeaponSets(sets)) {
    const host = hudRoot?.querySelector("[data-weapon-sets]");
    if (host) renderWeaponSetToolbar(host, activeActor);
  }
}

async function equipWeaponSet(index) {
  const actor = activeActor;
  if (!actor || !canEditCurrentActor()) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetNoPermission"));
  const set = getWeaponSets()[index];
  if (!set) return;
  const hasAssignments = Boolean(set.mainHand || set.offHand);
  if (!hasAssignments) return ui.notifications.info(game.i18n.localize("ACTION_HUD.weaponSetEmptyCannotEquip"));
  const mainItem = set.mainHand ? getWeaponSetItem(actor, set.mainHand) : null;
  const offItem = set.offHand ? getWeaponSetItem(actor, set.offHand) : null;
  if ((set.mainHand && !mainItem) || (set.offHand && !offItem)) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetItemMissing"));
  if (mainItem && isWeaponSetShield(mainItem)) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetShieldOffHandOnly"));
  if (offItem && isWeaponSetTwoHanded(offItem)) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetTwoHandedMainHandOnly"));
  if (mainItem && isWeaponSetTwoHanded(mainItem) && offItem) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.weaponSetMainHandUsesBoth"));
  const desired = new Set();
  if (mainItem) desired.add(mainItem.id);
  if (offItem && !(mainItem && isWeaponSetTwoHanded(mainItem))) desired.add(offItem.id);
  const switchable = (actor.items?.contents ?? []).filter(isWeaponSetItem);
  const updates = switchable
    .filter(item => Boolean(item.system.equipped) !== desired.has(item.id))
    .map(item => ({ _id: item.id, "system.equipped": desired.has(item.id) }));
  try {
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
    renderFavorites();
    refreshInventoryEquipStates();
    const host = hudRoot?.querySelector("[data-weapon-sets]");
    if (host) renderWeaponSetToolbar(host, actor);
  } catch (error) {
    console.error(`${MODULE_ID} | Could not equip weapon set`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.weaponSetEquipFailed"));
  }
}

function refreshInventoryEquipStates() {
  if (!hudRoot || !activeActor) return;
  hudRoot.querySelectorAll(".ahud-item-tile[data-item-id]").forEach(tile => {
    const item = activeActor.items?.get?.(tile.dataset.itemId);
    if (!item) return;
    const unequipped = ["weapon", "equipment"].includes(item.type) && typeof item.system?.equipped === "boolean" && !item.system.equipped;
    tile.classList.toggle("is-unequipped", unequipped);
    const button = tile.querySelector(".ahud-item-equip-toggle");
    if (!button) return;
    button.classList.toggle("is-equipped", Boolean(item.system.equipped));
    button.title = game.i18n.localize(item.system.equipped ? "ACTION_HUD.unequipItem" : "ACTION_HUD.equipItem");
    button.setAttribute("aria-label", button.title); button.setAttribute("aria-pressed", String(item.system.equipped));
    const icon = button.querySelector("i");
    if (icon) icon.className = item.system.equipped ? "fas fa-shield-halved" : "fas fa-shield";
  });
}

function renderItemPanel(panel, type) {
  if (type !== "inventory") return;
  const actor = activeActor;
  const itemTypes = ["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"];
  // Keep the drawer focused on top-level inventory. D&D 5e stores the parent
  // container's item ID in system.container; items stored in a container should
  // not be listed separately here. The container itself remains visible if it
  // is at the top level.
  const items = (actor?.items?.contents ?? []).filter(item =>
    itemTypes.includes(item.type) && !item.system?.container
  ).sort(compareBrowserItemPriority);
  const categoryDefinitions = [
    { id: "weapons", label: game.i18n.localize("ACTION_HUD.weapons"), icon: "icons/skills/melee/weapons-crossed-swords-black.webp", matches: item => item.type === "weapon" },
    { id: "equipment", label: game.i18n.localize("ACTION_HUD.equipment"), icon: "icons/equipment/chest/breastplate-cuirass-steel-grey.webp", matches: item => item.type === "equipment" },
    { id: "consumables", label: game.i18n.localize("ACTION_HUD.consumables"), icon: "icons/consumables/potions/bottle-round-corked-red.webp", matches: item => item.type === "consumable" },
    { id: "other", label: game.i18n.localize("ACTION_HUD.otherItems"), icon: "icons/containers/chest/chest-simple-steel-orange.webp", matches: item => !["weapon", "equipment", "consumable"].includes(item.type) }
  ];
  const categoryItems = new Map(categoryDefinitions.map(def => [def.id, items.filter(def.matches)]).filter(([, list]) => list.length));
  const categories = categoryDefinitions.filter(def => categoryItems.has(def.id));
  let selectedCategory = categories[0]?.id ?? "";
  const activeActivationFilters = new Set();
  const topbar = document.createElement("div"); topbar.className = "ahud-inventory-topbar";
  const tabs = document.createElement("div"); tabs.className = "ahud-spell-tabs ahud-item-tabs"; tabs.setAttribute("role", "tablist");
  tabs.hidden = !categories.length;
  const tabButtons = new Map();
  for (const definition of categories) {
    const button = document.createElement("button"); button.type = "button"; button.className = "ahud-spell-tab ahud-item-tab";
    button.title = definition.label; button.setAttribute("aria-label", definition.label); button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false"); button.dataset.category = definition.id;
    const image = document.createElement("img"); image.src = definition.icon; image.alt = ""; image.loading = "lazy"; image.setAttribute("aria-hidden", "true"); button.appendChild(image);
    const count = document.createElement("small"); count.className = "ahud-spell-tab-count"; count.textContent = String(categoryItems.get(definition.id).length); button.appendChild(count);
    button.addEventListener("click", () => { selectedCategory = definition.id; draw(); });
    tabs.appendChild(button); tabButtons.set(definition.id, button);
  }
  topbar.appendChild(tabs);
  const weaponSetsHost = document.createElement("div"); weaponSetsHost.className = "ahud-weapon-sets-host"; weaponSetsHost.dataset.weaponSets = "true";
  topbar.appendChild(weaponSetsHost);
  panel.appendChild(topbar);
  renderWeaponSetToolbar(weaponSetsHost, actor);

  const controls = document.createElement("div"); controls.className = "ahud-spellbook-controls ahud-item-controls";
  const search = document.createElement("input"); search.className = "ahud-filter ahud-spell-search"; search.type = "search";
  search.placeholder = game.i18n.localize("ACTION_HUD.filterItems"); search.setAttribute("aria-label", game.i18n.localize("ACTION_HUD.filterItems")); controls.appendChild(search);
  const activationFilters = document.createElement("div"); activationFilters.className = "ahud-spell-activation-filters";
  const filterDefinitions = [
    { id: "action", label: game.i18n.localize("ACTION_HUD.spellFilterAction"), marker: "●" },
    { id: "bonus", label: game.i18n.localize("ACTION_HUD.spellFilterBonus"), marker: "▲" },
    { id: "reaction", label: game.i18n.localize("ACTION_HUD.spellFilterReaction"), marker: "✦" }
  ];
  const activationButtons = new Map();
  for (const definition of filterDefinitions) {
    const button = document.createElement("button"); button.type = "button"; button.className = `ahud-spell-activation-filter is-${definition.id}`;
    button.title = definition.label; button.setAttribute("aria-label", definition.label); button.setAttribute("aria-pressed", "false");
    const marker = document.createElement("span"); marker.className = `ahud-action-marker is-${definition.id}`; marker.textContent = definition.marker; marker.setAttribute("aria-hidden", "true"); button.appendChild(marker);
    button.addEventListener("click", () => { if (activeActivationFilters.has(definition.id)) activeActivationFilters.delete(definition.id); else activeActivationFilters.add(definition.id); draw(); });
    activationFilters.appendChild(button); activationButtons.set(definition.id, button);
  }
  controls.appendChild(activationFilters); panel.appendChild(controls);
  const grid = document.createElement("div"); grid.className = "ahud-spell-grid ahud-item-grid"; panel.appendChild(grid);

  const draw = () => {
    for (const definition of categories) {
      const button = tabButtons.get(definition.id); const active = definition.id === selectedCategory;
      button.classList.toggle("is-active", active); button.setAttribute("aria-selected", String(active));
    }
    for (const definition of filterDefinitions) {
      const button = activationButtons.get(definition.id); const active = activeActivationFilters.has(definition.id);
      button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active));
    }
    grid.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase(game.i18n.lang || undefined);
    const matches = (categoryItems.get(selectedCategory) ?? []).filter(item => item.name.toLocaleLowerCase(game.i18n.lang || undefined).includes(query));
    for (const item of matches) {
      const types = itemActivationTypes(item);
      const useState = getItemActionAvailability(actor, item);
      const matchedTypes = [...activeActivationFilters].filter(actionType => types.has(actionType));
      const tile = document.createElement("div"); tile.className = "ahud-spell-tile ahud-item-tile"; tile.dataset.itemId = item.id; tile.tabIndex = 0; tile.setAttribute("role", "button");
      tile.classList.toggle("is-filter-highlighted", matchedTypes.length > 0);
      for (const actionType of ["action", "bonus", "reaction"]) tile.classList.toggle(`is-filter-match-${actionType}`, matchedTypes.includes(actionType));
      tile.classList.toggle("is-action-used", useState.blocked);
      const unequipped = ["weapon", "equipment"].includes(item.type) && typeof item.system?.equipped === "boolean" && !item.system.equipped;
      tile.classList.toggle("is-unequipped", unequipped);
      const img = document.createElement("img"); img.src = item.img; img.alt = ""; img.loading = "lazy";
      const label = document.createElement("span"); label.className = "ahud-spell-tile-name"; label.textContent = item.name;
      tile.append(img, label);
      const resourceIndicators = renderTileResourceIndicators(tile, item);
      const quantityIndicator = renderInventoryQuantityBadge(tile, item);
      if (matchedTypes.length) {
        const markers = document.createElement("span"); markers.className = "ahud-spell-tile-markers";
        for (const actionType of matchedTypes) { const marker = document.createElement("span"); marker.className = `ahud-action-marker is-${actionType}`; marker.textContent = filterDefinitions.find(def => def.id === actionType)?.marker ?? ""; marker.setAttribute("aria-hidden", "true"); markers.appendChild(marker); }
        tile.appendChild(markers);
      }
      if (["weapon", "equipment"].includes(item.type) && typeof item.system?.equipped === "boolean") {
        const equip = document.createElement("button"); equip.type = "button"; equip.className = "ahud-item-equip-toggle";
        equip.classList.toggle("is-equipped", item.system.equipped); equip.title = game.i18n.localize(item.system.equipped ? "ACTION_HUD.unequipItem" : "ACTION_HUD.equipItem");
        equip.setAttribute("aria-label", equip.title); equip.setAttribute("aria-pressed", String(item.system.equipped));
        const icon = document.createElement("i"); icon.className = item.system.equipped ? "fas fa-shield-halved" : "fas fa-shield"; equip.appendChild(icon);
        equip.addEventListener("click", async event => {
          event.stopPropagation();
          if (!activeActor || activeActor.uuid !== actor.uuid || !actor.testUserPermission(game.user, "OWNER") && !game.user.isGM) return;
          try {
            await item.update({ "system.equipped": !item.system.equipped });
            const equippedNow = Boolean(item.system.equipped);
            equip.classList.toggle("is-equipped", equippedNow);
            equip.title = game.i18n.localize(equippedNow ? "ACTION_HUD.unequipItem" : "ACTION_HUD.equipItem");
            equip.setAttribute("aria-label", equip.title); equip.setAttribute("aria-pressed", String(equippedNow));
            icon.className = equippedNow ? "fas fa-shield-halved" : "fas fa-shield";
            tile.classList.toggle("is-unequipped", !equippedNow);
            renderFavorites();
            refreshInventoryEquipStates();
            const weaponSetHost = hudRoot?.querySelector("[data-weapon-sets]");
            if (weaponSetHost) renderWeaponSetToolbar(weaponSetHost, activeActor);
          } catch (error) { console.error(`${MODULE_ID} | Could not toggle equipment state`, error); ui.notifications.error(game.i18n.localize("ACTION_HUD.equipmentToggleFailed")); }
        });
        tile.appendChild(equip);
      }
      const actionNames = [...types].map(actionType => ({ action: game.i18n.localize("ACTION_HUD.spellFilterAction"), bonus: game.i18n.localize("ACTION_HUD.spellFilterBonus"), reaction: game.i18n.localize("ACTION_HUD.spellFilterReaction") })[actionType]).filter(Boolean);
      tile.dataset.resourceBaseAria = [item.name, actionNames.join(" / "), unequipped ? game.i18n.localize("ACTION_HUD.notEquipped") : "", useState.blocked ? useState.reason : ""].filter(Boolean).join(". ");
      tile.setAttribute("aria-label", [tile.dataset.resourceBaseAria, ...resourceIndicators.map(indicator => indicator.title), quantityIndicator?.title].filter(Boolean).join(". "));
      attachDocumentTooltip(tile, item, "item");
      const useItem = async () => {
        if (!activeActor || activeActor.uuid !== actor.uuid) return;
        if (eventTargetWasEquip) return;
        if (!activeToken) { item.sheet?.render(true); return; }
        try { if (typeof item.use === "function") await item.use(); else item.sheet?.render(true); }
        catch (error) { console.error(`${MODULE_ID} | Failed to use item ${item.name}`, error); ui.notifications.error(game.i18n.localize("ACTION_HUD.spellUseFailed")); }
      };
      let eventTargetWasEquip = false;
      tile.addEventListener("click", event => { eventTargetWasEquip = event.target.closest(".ahud-item-equip-toggle") !== null; if (!eventTargetWasEquip) void useItem(); });
      tile.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void useItem(); } });
      tile.addEventListener("contextmenu", event => { event.preventDefault(); item.sheet?.render(true); });
      enableHudItemDrag(tile, item);
      grid.appendChild(tile);
    }
    if (!matches.length) { const empty = document.createElement("div"); empty.className = "ahud-empty-state ahud-spell-empty"; empty.textContent = game.i18n.localize("ACTION_HUD.noItemsFound"); grid.appendChild(empty); }
  };
  search.addEventListener("input", draw); draw();
}

function renderSpellbookPanel(panel) {
  const actor = activeActor;
  const spellItems = (actor?.items?.contents ?? [])
    .filter(item => item.type === "spell" && isSpellbookEligible(item, actor))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang || undefined, { sensitivity: "base" }));

  const categoryDefinitions = [
    { id: "cantrip", label: game.i18n.localize("ACTION_HUD.spellTabCantrips"), mark: "C" },
    ...Array.from({ length: 9 }, (_, index) => {
      const level = index + 1;
      const key = CONFIG.DND5E.spellLevels?.[level];
      return {
        id: `level${level}`,
        label: key ? game.i18n.localize(key) : `${game.i18n.localize("ACTION_HUD.level")} ${level}`,
        mark: String(level)
      };
    }),
    { id: "ritual", label: game.i18n.localize("ACTION_HUD.spellTabRituals"), icon: "pentagram" },
    { id: "atwill", label: game.i18n.localize("ACTION_HUD.spellTabAtWill"), icon: "fas fa-infinity" },
    { id: "innate", label: game.i18n.localize("ACTION_HUD.spellTabInnate"), icon: "fas fa-sparkles" },
    { id: "additional", label: game.i18n.localize("ACTION_HUD.spellTabAdditional"), icon: "fas fa-scroll" }
  ];

  const memberships = new Map();
  for (const item of spellItems) memberships.set(item.uuid, spellbookCategories(actor, item));
  const categoryItems = new Map();
  for (const definition of categoryDefinitions) {
    const matches = spellItems.filter(item => memberships.get(item.uuid)?.includes(definition.id));
    if (matches.length) categoryItems.set(definition.id, matches);
  }
  const categories = categoryDefinitions.filter(definition => categoryItems.has(definition.id));
  if (!categories.length) {
    const empty = document.createElement("div"); empty.className = "ahud-empty-state";
    empty.textContent = game.i18n.localize("ACTION_HUD.noPreparedSpells"); panel.appendChild(empty); return;
  }

  let selectedCategory = categories[0].id;
  const activeActivationFilters = new Set();
  const tabs = document.createElement("div"); tabs.className = "ahud-spell-tabs"; tabs.setAttribute("role", "tablist");
  const tabButtons = new Map();
  for (const definition of categories) {
    const button = document.createElement("button"); button.type = "button"; button.className = "ahud-spell-tab";
    button.title = definition.label; button.setAttribute("aria-label", definition.label); button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false"); button.dataset.category = definition.id;
    if (definition.mark) {
      const mark = document.createElement("span"); mark.className = "ahud-spell-tab-level"; mark.textContent = definition.mark;
      mark.setAttribute("aria-hidden", "true"); button.appendChild(mark);
    } else if (definition.icon === "pentagram") {
      // Use a small inline SVG so the ritual tab does not depend on a Pro-only icon font.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("aria-hidden", "true");
      svg.classList.add("ahud-spell-tab-pentagram");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M50 4 L79 92 L4 37 L96 37 L21 92 Z");
      svg.appendChild(path); button.appendChild(svg);
    } else {
      const icon = document.createElement("i"); icon.className = definition.icon; icon.setAttribute("aria-hidden", "true"); button.appendChild(icon);
    }
    const count = document.createElement("small"); count.className = "ahud-spell-tab-count"; count.textContent = String(categoryItems.get(definition.id).length); button.appendChild(count);
    button.addEventListener("click", () => { selectedCategory = definition.id; draw(); });
    tabs.appendChild(button); tabButtons.set(definition.id, button);
  }
  panel.appendChild(tabs);

  const controls = document.createElement("div"); controls.className = "ahud-spellbook-controls";
  const search = document.createElement("input"); search.className = "ahud-filter ahud-spell-search"; search.type = "search";
  search.placeholder = game.i18n.localize("ACTION_HUD.filterItems"); search.setAttribute("aria-label", game.i18n.localize("ACTION_HUD.filterItems"));
  controls.appendChild(search);
  const activationFilters = document.createElement("div"); activationFilters.className = "ahud-spell-activation-filters";
  const filterDefinitions = [
    { id: "action", label: game.i18n.localize("ACTION_HUD.spellFilterAction"), marker: "●" },
    { id: "bonus", label: game.i18n.localize("ACTION_HUD.spellFilterBonus"), marker: "▲" },
    { id: "reaction", label: game.i18n.localize("ACTION_HUD.spellFilterReaction"), marker: "✦" }
  ];
  const activationButtons = new Map();
  for (const definition of filterDefinitions) {
    const button = document.createElement("button"); button.type = "button"; button.className = `ahud-spell-activation-filter is-${definition.id}`;
    button.title = definition.label; button.setAttribute("aria-label", definition.label); button.setAttribute("aria-pressed", "false");
    const marker = document.createElement("span"); marker.className = `ahud-action-marker is-${definition.id}`; marker.textContent = definition.marker;
    marker.setAttribute("aria-hidden", "true"); button.appendChild(marker);
    button.addEventListener("click", () => {
      if (activeActivationFilters.has(definition.id)) activeActivationFilters.delete(definition.id);
      else activeActivationFilters.add(definition.id);
      draw();
    });
    activationFilters.appendChild(button); activationButtons.set(definition.id, button);
  }
  controls.appendChild(activationFilters); panel.appendChild(controls);

  const grid = document.createElement("div"); grid.className = "ahud-spell-grid"; panel.appendChild(grid);
  const draw = () => {
    for (const definition of categories) {
      const button = tabButtons.get(definition.id);
      const active = definition.id === selectedCategory;
      button.classList.toggle("is-active", active); button.setAttribute("aria-selected", String(active));
    }
    for (const definition of filterDefinitions) {
      const button = activationButtons.get(definition.id);
      const active = activeActivationFilters.has(definition.id);
      button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active));
    }
    grid.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase(game.i18n.lang || undefined);
    const matches = categoryItems.get(selectedCategory).filter(item => item.name.toLocaleLowerCase(game.i18n.lang || undefined).includes(query));
    for (const item of matches) {
      const types = itemActivationTypes(item);
      const useState = getItemActionAvailability(actor, item);
      const matchedTypes = [...activeActivationFilters].filter(type => types.has(type));
      const tile = document.createElement("button"); tile.type = "button"; tile.className = "ahud-spell-tile";
      tile.classList.toggle("is-filter-highlighted", matchedTypes.length > 0);
      for (const type of ["action", "bonus", "reaction"]) tile.classList.toggle(`is-filter-match-${type}`, matchedTypes.includes(type));
      tile.classList.toggle("is-action-used", useState.blocked);
      tile.classList.toggle("is-unavailable", !activeToken);
      tile.dataset.itemUuid = item.uuid; tile.dataset.itemId = item.id;
      const img = document.createElement("img"); img.src = item.img; img.alt = ""; img.loading = "lazy";
      const label = document.createElement("span"); label.className = "ahud-spell-tile-name"; label.textContent = item.name;
      tile.append(img, label);
      const resourceIndicators = renderTileResourceIndicators(tile, item);
      const quantityIndicator = renderInventoryQuantityBadge(tile, item);
      if (matchedTypes.length) {
        const tileMarkers = document.createElement("span"); tileMarkers.className = "ahud-spell-tile-markers";
        for (const type of matchedTypes) {
          const marker = document.createElement("span"); marker.className = `ahud-action-marker is-${type}`;
          marker.textContent = filterDefinitions.find(def => def.id === type)?.marker ?? "";
          marker.setAttribute("aria-hidden", "true"); tileMarkers.appendChild(marker);
        }
        tile.appendChild(tileMarkers);
      }
      tile.dataset.resourceBaseAria = [item.name, spellTooltipDetails(item, types), useState.blocked ? useState.reason : ""].filter(Boolean).join(". ");
      tile.setAttribute("aria-label", [tile.dataset.resourceBaseAria, ...resourceIndicators.map(indicator => indicator.title), quantityIndicator?.title].filter(Boolean).join(". "));
      attachDocumentTooltip(tile, item, "item");
      tile.addEventListener("click", async () => {
        // Delegate targeting, activity selection, resource consumption, and Midi-QoL hooks
        // to the same native item workflow used by the actor sheet.
        if (!activeActor || activeActor.uuid !== actor.uuid) return;
        if (!activeToken) { item.sheet?.render(true); return; }
        closeSpellTooltip(true);
        try { await item.use?.(); }
        catch (error) { console.error(`${MODULE_ID} | Failed to use spell ${item.name}`, error); ui.notifications.error(game.i18n.localize("ACTION_HUD.spellUseFailed")); }
      });
      tile.addEventListener("contextmenu", event => { event.preventDefault(); item.sheet?.render(true); });
      enableHudItemDrag(tile, item);
      grid.appendChild(tile);
    }
    if (!matches.length) {
      const empty = document.createElement("div"); empty.className = "ahud-empty-state ahud-spell-empty";
      empty.textContent = game.i18n.localize("ACTION_HUD.noItemsFound"); grid.appendChild(empty);
    }
  };
  search.addEventListener("input", draw);
  draw();
}

function isSpellbookEligible(item, actor) {
  const system = item.system ?? {};
  const level = Number(system.level ?? 0);
  const method = spellMethod(item);
  // Spells granted by a limited-use item/feature are available through that source,
  // even when they are not part of the actor's prepared spell list.
  if (spellHasAdditionalSource(actor, item)) return true;
  // These methods do not rely on preparation/slot preparation.
  if (["atwill", "innate", "ritual"].includes(method)) return true;
  // Cantrips are known abilities, not prepared leveled spells.
  if (level === 0) return true;
  if (system.prepared !== undefined && system.prepared !== null) return Number(system.prepared) > 0;
  const preparation = system.preparation;
  if (preparation) {
    if (typeof preparation.prepared === "boolean") return preparation.prepared;
    if (typeof preparation.mode === "string") return ["prepared", "always"].includes(preparation.mode);
  }
  // Legacy/manual spell data without a preparation field is not explicitly unprepared.
  return true;
}

function spellMethod(item) {
  const system = item.system ?? {};
  const method = String(system.method ?? "").toLowerCase();
  if (method) return method;
  const legacyMode = String(system.preparation?.mode ?? "").toLowerCase();
  if (["atwill", "innate", "ritual"].includes(legacyMode)) return legacyMode;
  return "spell";
}

function spellHasProperty(item, property) {
  const properties = item.system?.properties;
  if (properties?.has instanceof Function) return properties.has(property);
  if (Array.isArray(properties)) return properties.includes(property);
  if (typeof properties === "string") return properties.split(/[\s,]+/).includes(property);
  return Boolean(properties?.[property]);
}

function hasUsesOrCharges(document) {
  const system = document?.system ?? {};
  const uses = system.uses;
  const positiveOrConfigured = value => {
    if (typeof value === "number") return value > 0;
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized !== "" && !/^[+-]?0+(?:\.0+)?$/.test(normalized);
    }
    return false;
  };
  // D&D 5e 6.x stores limited uses and charges under system.uses. Keep a few legacy
  // spell/item representations supported as well, without treating quantity as charges.
  return positiveOrConfigured(uses?.max) || positiveOrConfigured(uses?.value)
    || positiveOrConfigured(uses?.charges) || positiveOrConfigured(system.charges)
    || positiveOrConfigured(system.charge);
}

function spellSourceItem(actor, item) {
  const sourceKey = item.system?.sourceItem ?? item.flags?.dnd5e?.sourceItem;
  if (typeof sourceKey === "string" && sourceKey) {
    let source = null;
    try {
      const matches = actor?.identifiedItems?.get?.(sourceKey);
      source = matches?.first?.() ?? matches?.contents?.[0] ?? (Array.isArray(matches) ? matches[0] : null);
    } catch (_) { /* Some system data providers expose identifiedItems as plain objects. */ }
    if (!source) {
      const suffix = sourceKey.includes(":") ? sourceKey.slice(sourceKey.indexOf(":") + 1) : sourceKey;
      source = (actor?.items?.contents ?? []).find(candidate =>
        candidate.id === sourceKey || candidate.uuid === sourceKey || candidate.identifier === sourceKey
        || candidate.id === suffix || candidate.identifier === suffix
      );
    }
    if (source) return source;
  }

  // Cached spells can point to an Activity UUID on the original actor item. Resolve the
  // owning item so subclass-granted spells are not mistaken for charge-based item spells.
  const cachedFor = item.getFlag?.("dnd5e", "cachedFor");
  if (typeof cachedFor === "string" && cachedFor) {
    try {
      const parsed = foundry.utils.parseUuid?.(cachedFor, { relative: actor });
      const embedded = parsed?.embedded ?? [];
      const activityPath = embedded.slice(-3);
      const sourceId = activityPath[0];
      const source = sourceId ? actor?.items?.get?.(sourceId) : null;
      if (source) return source;
    } catch (_) { /* If UUID parsing fails, use the ordinary source identifier if available. */ }
    try {
      const document = typeof fromUuidSync === "function" ? fromUuidSync(cachedFor) : null;
      const source = document?.documentName === "Item" ? document : document?.parent?.documentName === "Item" ? document.parent : null;
      if (source) return source;
    } catch (_) { /* Missing/stale cached source UUIDs should not break the Spellbook. */ }
  }
  return null;
}

function spellHasAdditionalSource(actor, item) {
  const source = spellSourceItem(actor, item);
  if (!source) return false;
  const sourceType = String(source.type ?? source.documentName ?? "").toLowerCase();
  // Class and subclass spells, including always-prepared subclass spells, normally use
  // the spell-slot category. Additional is reserved for a linked item/feature with uses.
  if (["class", "subclass"].includes(sourceType)) return false;
  return hasUsesOrCharges(source) || hasUsesOrCharges(item);
}

function spellbookCategories(actor, item) {
  const method = spellMethod(item);
  const level = Number(item.system?.level ?? 0);
  const categories = [];
  const additional = spellHasAdditionalSource(actor, item);

  // Cantrips always live in Cantrips, regardless of where they came from. A cantrip
  // with a linked charge-based source may also appear in Additional, but never in a
  // leveled spell-slot tab.
  if (level === 0) categories.push("cantrip");
  else if (method === "atwill") categories.push("atwill");
  else if (method === "innate") categories.push("innate");
  else if (method === "ritual") categories.push("ritual");
  else if (additional) categories.push("additional");
  else categories.push(`level${level}`);

  // Additional spells can overlap with explicit methods (At-Will, Innate, Ritual),
  // but regular limited-use item spells should not also appear in the spell-slot level.
  if (additional) categories.push("additional");
  // Ritual-capable spells remain available in the Ritual tab as well as their main category.
  if (method !== "ritual" && spellHasProperty(item, "ritual")) categories.push("ritual");
  // Cantrips explicitly granted as at-will/innate spells can still be found in those tabs.
  if (level === 0 && method === "atwill") categories.push("atwill");
  if (level === 0 && method === "innate") categories.push("innate");
  return [...new Set(categories)];
}

function itemActivationTypes(item) {
  const result = new Set();
  const add = value => {
    if (value && typeof value === "object") value = value.type ?? value.value ?? value.id;
    if (typeof value !== "string") return;
    const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
    if (normalized === "action" || normalized === "actions") result.add("action");
    else if (normalized === "bonus" || normalized === "bonusaction" || normalized === "bonusactions") result.add("bonus");
    else if (normalized === "reaction" || normalized === "reactions") result.add("reaction");
  };
  const activities = item.system?.activities;
  let values = [];
  if (Array.isArray(activities)) values = activities;
  else if (activities?.contents) values = activities.contents;
  else if (activities?.values instanceof Function) values = [...activities.values()];
  else if (activities && typeof activities === "object") values = Object.values(activities);
  for (const activity of values) add(activity?.activation?.type ?? activity?.system?.activation?.type ?? activity?.data?.activation?.type);
  add(item.system?.activation?.type ?? item.system?.activation?.value);
  return result;
}

function spellTooltipDetails(item, activationTypes) {
  const details = [];
  const method = spellMethod(item);
  const level = Number(item.system?.level ?? 0);
  const levelKey = CONFIG.DND5E.spellLevels?.[level];
  if (levelKey) details.push(game.i18n.localize(levelKey));
  const school = CONFIG.DND5E.spellSchools?.[item.system?.school]?.label;
  if (school) details.push(game.i18n.localize(school));
  if (spellHasProperty(item, "ritual") || method === "ritual") details.push(game.i18n.localize("ACTION_HUD.spellTabRituals"));
  if (method === "atwill") details.push(game.i18n.localize("ACTION_HUD.spellTabAtWill"));
  if (method === "innate") details.push(game.i18n.localize("ACTION_HUD.spellTabInnate"));
  const activationLabels = {
    action: game.i18n.localize("ACTION_HUD.spellFilterAction"),
    bonus: game.i18n.localize("ACTION_HUD.spellFilterBonus"),
    reaction: game.i18n.localize("ACTION_HUD.spellFilterReaction")
  };
  if (activationTypes.size) details.push([...activationTypes].map(type => activationLabels[type]).join(" / "));
  return details.join(" · ");
}

function spellTooltipMetadata(item, activationTypes) {
  const system = item.system ?? {};
  const bits = [];
  const level = Number(system.level ?? 0);
  const levelKey = CONFIG.DND5E.spellLevels?.[level];
  if (levelKey) bits.push(game.i18n.localize(levelKey));
  const school = CONFIG.DND5E.spellSchools?.[system.school]?.label;
  if (school) bits.push(game.i18n.localize(school));
  const activation = system.activation ?? {};
  const activities = getActivityValues(item);
  const activationTypesAll = new Set(activationTypes);
  const activationCosts = [];
  for (const activity of activities) {
    const a = activity?.activation ?? activity?.system?.activation ?? activity?.data?.activation ?? {};
    const label = activationLabel(a.type, a.value ?? a.cost);
    if (label && !activationCosts.includes(label)) activationCosts.push(label);
  }
  const legacyActivation = activationLabel(activation.type, activation.value ?? activation.cost);
  const castTime = activationCosts.join(" / ") || legacyActivation || "—";
  const range = formatSpellRange(system.range);
  const duration = formatSpellDuration(system.duration);
  const components = formatSpellComponents(system);
  const tags = [];
  if (spellHasProperty(item, "concentration") || system.duration?.concentration) tags.push(game.i18n.localize("DND5E.Concentration"));
  if (spellHasProperty(item, "ritual") || spellMethod(item) === "ritual") tags.push(game.i18n.localize("ACTION_HUD.spellTabRituals"));
  if (spellMethod(item) === "atwill") tags.push(game.i18n.localize("ACTION_HUD.spellTabAtWill"));
  if (spellMethod(item) === "innate") tags.push(game.i18n.localize("ACTION_HUD.spellTabInnate"));
  const label = key => game.i18n.localize(key);
  return [
    { label: label("DND5E.SpellCastTime"), value: castTime },
    { label: label("DND5E.Range"), value: range },
    { label: label("DND5E.Duration"), value: duration },
    { label: label("DND5E.SpellComponents"), value: components },
    { label: "", value: tags.join(" · ") }
  ].filter(row => row.value && row.value !== "—");
}

function getActivityValues(item) {
  const activities = item?.system?.activities;
  if (Array.isArray(activities)) return activities;
  if (activities?.contents) return activities.contents;
  if (activities?.values instanceof Function) return [...activities.values()];
  if (activities && typeof activities === "object") return Object.values(activities);
  return [];
}

// Features and Inventory share a useful combat-first browsing order:
// 1) items with limited uses/charges/recharge or activity-use pools,
// 2) items with activities but no configured resource pool,
// 3) passive/ordinary entries. Names remain alphabetical within each group.
// Spellbook deliberately keeps its own level/category ordering.
function browserItemPriority(item) {
  const activities = getActivityValues(item);
  const hasActivityResourcePool = activities.some(activity =>
    Boolean(getResourceUseCount(activity?.uses ?? activity?.system?.uses))
  );
  if (hasUsesOrCharges(item) || getFavoriteResourceIndicators(item).length > 0 || hasActivityResourcePool) return 0;
  if (activities.length > 0) return 1;
  return 2;
}

function compareBrowserItemPriority(a, b) {
  const priority = browserItemPriority(a) - browserItemPriority(b);
  if (priority) return priority;
  return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), game.i18n.lang || undefined, { sensitivity: "base" });
}

function activationLabel(type, cost) {
  if (type && typeof type === "object") type = type.value ?? type.type ?? type.id;
  const normalized = String(type ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const keys = {
    action: "DND5E.Action",
    bonus: "DND5E.BonusAction",
    bonusaction: "DND5E.BonusAction",
    reaction: "DND5E.Reaction",
    minute: "DND5E.TimeMinute",
    hour: "DND5E.TimeHour",
    day: "DND5E.TimeDay",
    special: "DND5E.Special"
  };
  const key = keys[normalized];
  if (!key) return type ? String(type) : "";
  const base = game.i18n.localize(key);
  const amount = Number(cost);
  return Number.isFinite(amount) && amount > 1 ? `${amount} ${base.toLocaleLowerCase(game.i18n.lang || undefined)}s` : base;
}

function formatSpellRange(range = {}) {
  const value = range.value;
  const units = range.units ? game.i18n.localize(CONFIG.DND5E.distanceUnits?.[range.units]?.label ?? range.units) : "";
  if (value == null || value === "") return range.special ?? "—";
  return `${value}${units ? ` ${units}` : ""}`;
}

function formatSpellDuration(duration = {}) {
  if (duration.concentration) return `${game.i18n.localize("DND5E.Concentration")}, ${duration.value ?? ""} ${duration.units ? game.i18n.localize(CONFIG.DND5E.timePeriods?.[duration.units]?.label ?? duration.units) : ""}`.trim();
  if (duration.value == null || duration.value === "") return duration.special ?? "—";
  const units = duration.units ? game.i18n.localize(CONFIG.DND5E.timePeriods?.[duration.units]?.label ?? duration.units) : "";
  return `${duration.value}${units ? ` ${units}` : ""}`;
}

function formatSpellComponents(system) {
  const properties = system.properties;
  const has = (...keys) => keys.some(key => spellHasProperty({ system: { properties } }, key));
  const parts = [];
  if (has("v", "verbal")) parts.push("V");
  if (has("s", "somatic")) parts.push("S");
  if (has("m", "material")) {
    const material = system.materials?.value;
    parts.push(material ? `M (${material})` : "M");
  }
  return parts.join(", ") || "—";
}

function closeSpellTooltip(force = false) {
  // This closes only the transient hover card. Pinned cards are independent and stay
  // on screen until individually unpinned/closed or the page is reloaded.
  if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  const state = hoverTooltipState;
  hoverTooltipState = null;
  if (state) removeAnchorTooltipPin(state);
  if (state && !state.pinned) state.card.remove();
}

function scheduleHideSpellTooltip(state = hoverTooltipState) {
  if (!state || state.pinned || document.body.classList.contains("ahud-item-dragging")) return;
  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(() => {
    tooltipHideTimer = null;
    if (hoverTooltipState !== state || state.pinned || state.anchorHovered || state.pinHovered) return;
    removeAnchorTooltipPin(state);
    if (state.cardHovered) return;
    state.card.remove();
    hoverTooltipState = null;
  }, 180);
}

function attachDocumentTooltip(element, document, kind = "item") {
  if (!element || !document || element.dataset.ahudTooltipBound) return;
  element.dataset.ahudTooltipBound = "true";
  // Suppress the browser's plain-text title tooltip when the richer item/effect card is available.
  element.removeAttribute("title");
  element.addEventListener("pointerenter", event => showDocumentTooltip(document, element, kind, event));
  // Active-effect tooltips follow the pointer so they don't cover the effect strip or HUD.
  // They are intentionally non-interactive and never pinnable.
  if (kind === "effect") element.addEventListener("pointermove", event => {
    const state = hoverTooltipState;
    if (state?.anchor !== element || state.kind !== "effect") return;
    state.pointerX = event.clientX;
    state.pointerY = event.clientY;
    positionSpellTooltip(state.card, element, state);
  });
  element.addEventListener("pointerleave", () => {
    const state = hoverTooltipState;
    if (state?.anchor === element) {
      state.anchorHovered = false;
      scheduleHideSpellTooltip(state);
    }
  });
}

async function showDocumentTooltip(document, anchor, kind = "item", pointerEvent = null) {
  if (!document || !anchor) return;
  if (hoverTooltipState?.anchor === anchor && hoverTooltipState?.document?.uuid === document.uuid) {
    hoverTooltipState.anchorHovered = true;
    if (pointerEvent && kind === "effect") {
      hoverTooltipState.pointerX = pointerEvent.clientX;
      hoverTooltipState.pointerY = pointerEvent.clientY;
      positionSpellTooltip(hoverTooltipState.card, anchor, hoverTooltipState);
    }
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    if (kind !== "effect") {
      createAnchorTooltipPin(hoverTooltipState);
      positionAnchorTooltipPin(hoverTooltipState);
    }
    return;
  }
  closeSpellTooltip(true);
  const state = {
    request: ++tooltipRequestSequence,
    document,
    anchor,
    kind,
    card: window.document.createElement("aside"),
    // Effect tooltips use pointer coordinates; item cards retain HUD-relative placement.
    pointerX: pointerEvent?.clientX ?? (anchor.getBoundingClientRect().left + anchor.getBoundingClientRect().width / 2),
    pointerY: pointerEvent?.clientY ?? (anchor.getBoundingClientRect().top + anchor.getBoundingClientRect().height / 2),
    pinned: false,
    anchorHovered: true,
    pinHovered: false,
    cardHovered: false,
    anchorPin: null,
    cardPin: null
  };
  const card = state.card;
  card.className = "ahud-spell-tooltip-card";
  if (kind === "effect") card.style.pointerEvents = "none";
  card.style.setProperty("--ahud-scale", String(game.settings.get(MODULE_ID, "scale") ?? 1));
  card.style.zIndex = String(100500 + state.request);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", `${document.name ?? "Details"} ${kind === "effect" ? "effect details" : "item details"}`);
  const header = window.document.createElement("div"); header.className = "ahud-spell-tooltip-header";
  const hasActivities = kind !== "effect" && getActivityValues(document).length > 0;
  let imageAction = null;
  let image;
  if (hasActivities) {
    imageAction = window.document.createElement("button");
    imageAction.type = "button";
    imageAction.className = "ahud-tooltip-item-image has-activities";
    imageAction.disabled = true; // Item execution is enabled only while the description card is pinned.
    imageAction.title = game.i18n.localize("ACTION_HUD.pinToUseItem");
    imageAction.setAttribute("aria-label", `${document.name ?? "Item"} — ${imageAction.title}`);
    image = window.document.createElement("img");
    image.src = document.img ?? "icons/svg/aura.svg"; image.alt = "";
    imageAction.appendChild(image);
  } else {
    image = window.document.createElement("img");
    image.src = document.img ?? "icons/svg/aura.svg"; image.alt = "";
  }
  const title = window.document.createElement("strong"); title.textContent = document.name ?? "";
  const pin = window.document.createElement("button"); pin.type = "button"; pin.className = "ahud-spell-tooltip-pin";
  pin.title = game.i18n.localize("ACTION_HUD.pinTooltip"); pin.setAttribute("aria-label", pin.title); pin.innerHTML = '<i class="fas fa-thumbtack" aria-hidden="true"></i>';
  state.cardPin = pin;
  const close = window.document.createElement("button"); close.type = "button"; close.className = "ahud-spell-tooltip-close";
  close.title = game.i18n.localize("ACTION_HUD.closeTooltip"); close.setAttribute("aria-label", close.title); close.innerHTML = '<i class="fas fa-xmark" aria-hidden="true"></i>';
  const headActions = window.document.createElement("span"); headActions.className = "ahud-spell-tooltip-actions"; headActions.append(pin, close);
  // Effect cards are transient hover-only tooltips: no pin or close controls.
  if (kind === "effect") header.append(image, title);
  else header.append(imageAction ?? image, title, headActions);
  card.appendChild(header);
  // Keep all detailed content inside one independently scrolling region. The card itself
  // uses max-height rather than a fixed height, so short descriptions remain compact.
  const content = window.document.createElement("div"); content.className = "ahud-spell-tooltip-content";
  const meta = window.document.createElement("div"); meta.className = "ahud-spell-tooltip-meta";
  const details = documentTooltipMetadata(document, kind);
  for (const row of details) {
    const line = window.document.createElement("div"); line.className = row.label ? "ahud-spell-tooltip-detail" : "ahud-spell-tooltip-tags";
    if (row.label) { const label = window.document.createElement("b"); label.textContent = `${row.label}: `; line.appendChild(label); }
    const value = window.document.createElement("span"); value.textContent = row.value; line.appendChild(value); meta.appendChild(line);
  }
  if (details.length) content.appendChild(meta);
  const body = window.document.createElement("div"); body.className = "ahud-spell-tooltip-description";
  body.innerHTML = `<p>${game.i18n.localize("ACTION_HUD.loadingSpellDescription")}</p>`;
  content.appendChild(body);
  card.appendChild(content);
  window.document.body.appendChild(card);
  hoverTooltipState = state;
  positionSpellTooltip(card, anchor, state);
  if (kind !== "effect") {
    createAnchorTooltipPin(state);
    positionAnchorTooltipPin(state);
  }

  card.addEventListener("pointerdown", () => {
    if (state.pinned) card.style.zIndex = String(100500 + ++tooltipRequestSequence);
  }, true);
  card.addEventListener("pointerenter", () => {
    state.cardHovered = true;
    state.anchorHovered = Boolean(anchor.matches?.(":hover"));
    removeAnchorTooltipPin(state);
    if (hoverTooltipState === state && tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  });
  card.addEventListener("pointerleave", () => {
    state.cardHovered = false;
    if (!state.pinned) scheduleHideSpellTooltip(state);
  });
  pin.addEventListener("click", () => {
    if (!state.pinned) {
      state.pinned = true;
      pinnedTooltipCards.add(card);
      card.classList.add("is-pinned");
      pin.classList.add("is-active");
      if (imageAction && hasActivities) {
        imageAction.disabled = false;
        imageAction.title = game.i18n.localize("ACTION_HUD.useItemFromPinnedTooltip");
        imageAction.setAttribute("aria-label", `${document.name ?? "Item"} — ${imageAction.title}`);
      }
      if (hoverTooltipState === state) hoverTooltipState = null;
      removeAnchorTooltipPin(state);
    } else {
      state.pinned = false;
      pinnedTooltipCards.delete(card);
      card.classList.remove("is-pinned");
      pin.classList.remove("is-active");
      if (imageAction) {
        imageAction.disabled = true;
        imageAction.title = game.i18n.localize("ACTION_HUD.pinToUseItem");
        imageAction.setAttribute("aria-label", `${document.name ?? "Item"} — ${imageAction.title}`);
      }
      // Rejoin the transient hover lifecycle when unpinned; it will disappear on pointer leave.
      closeSpellTooltip(true);
      hoverTooltipState = state;
      state.anchorHovered = Boolean(anchor.matches?.(":hover"));
      state.cardHovered = true;
      if (state.anchorHovered) {
        createAnchorTooltipPin(state);
        positionAnchorTooltipPin(state);
      } else removeAnchorTooltipPin(state);
    }
    pin.title = game.i18n.localize(state.pinned ? "ACTION_HUD.unpinTooltip" : "ACTION_HUD.pinTooltip");
    pin.setAttribute("aria-label", pin.title);
    if (!state.pinned) scheduleHideSpellTooltip(state);
  });
  close.addEventListener("click", () => {
    pinnedTooltipCards.delete(card);
    if (hoverTooltipState === state) hoverTooltipState = null;
    removeAnchorTooltipPin(state);
    card.remove();
  });
  if (imageAction && hasActivities) {
    imageAction.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      if (!state.pinned || imageAction.disabled) return;
      try {
        // Match the actor sheet's normal entry point: let D&D 5e resolve the activity,
        // targeting, resource consumption, and Midi-QoL integration.
        if (typeof document.use === "function") await document.use();
        else document.sheet?.render(true);
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to use item from pinned description card`, error);
        ui.notifications.error(game.i18n.localize("ACTION_HUD.spellUseFailed"));
      }
    });
  }
  header.addEventListener("pointerdown", event => {
    if (!state.pinned || event.target.closest("button")) return;
    event.preventDefault();
    const rect = card.getBoundingClientRect();
    const offsetX = event.clientX - rect.left, offsetY = event.clientY - rect.top;
    const onMove = moveEvent => {
      if (!state.pinned || !card.isConnected) return;
      const left = Math.max(4, Math.min(window.innerWidth - card.offsetWidth - 4, moveEvent.clientX - offsetX));
      const top = Math.max(4, Math.min(window.innerHeight - card.offsetHeight - 4, moveEvent.clientY - offsetY));
      card.style.left = `${left}px`; card.style.top = `${top}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      card.classList.remove("is-dragging");
    };
    card.classList.add("is-dragging");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  });

  const description = documentDescription(document, kind);
  try {
    const enriched = typeof TextEditor?.enrichHTML === "function"
      ? await TextEditor.enrichHTML(description, { async: true, secrets: false, relativeTo: kind === "effect" ? document.parent ?? activeActor : document })
      : description;
    if (card.isConnected) {
      body.innerHTML = enriched || `<p>${game.i18n.localize("ACTION_HUD.noSpellDescription")}</p>`;
      positionSpellTooltip(card, anchor, state);
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not enrich description`, error);
    if (card.isConnected) body.textContent = String(description).replace(/<[^>]*>/g, " ").trim() || game.i18n.localize("ACTION_HUD.noSpellDescription");
  }
}

function documentTooltipMetadata(document, kind) {
  if (kind === "effect") {
    const meta = [];
    const remaining = effectRemainingLabel(document);
    if (remaining) meta.push({ label: game.i18n.localize("ACTION_HUD.remainingTime"), value: remaining });
    const statuses = [...(document.statuses ?? [])].map(id => configLabel(CONFIG.DND5E?.conditionTypes?.[id]?.name ?? CONFIG.statusEffects?.[id]?.name ?? id, id));
    if (statuses.length) meta.push({ label: game.i18n.localize("ACTION_HUD.effectStatuses"), value: statuses.join(", ") });
    return meta;
  }
  if (document.type === "spell") return spellTooltipMetadata(document, itemActivationTypes(document));

  const system = document.system ?? {};
  const rows = [];
  const typeLabel = CONFIG.Item?.typeLabels?.[document.type] ?? CONFIG.DND5E?.itemTypes?.[document.type]?.label;
  if (typeLabel) rows.push({ label: game.i18n.localize("ACTION_HUD.itemType"), value: game.i18n.localize(typeLabel) });
  const activations = [...itemActivationTypes(document)].map(type => ({
    action: game.i18n.localize("DND5E.Action"),
    bonus: game.i18n.localize("DND5E.BonusAction"),
    reaction: game.i18n.localize("DND5E.Reaction")
  })[type]).filter(Boolean);
  if (activations.length) rows.push({ label: game.i18n.localize("DND5E.Activation"), value: [...new Set(activations)].join(" / ") });
  if (system.uses && (system.uses.max !== undefined && system.uses.max !== null && system.uses.max !== "")) {
    rows.push({ label: game.i18n.localize("DND5E.Uses"), value: `${system.uses.value ?? 0} / ${system.uses.max}` });
  }
  if (Number(system.quantity) > 1) rows.push({ label: game.i18n.localize("DND5E.Quantity"), value: String(system.quantity) });
  if (system.weight?.value ?? system.weight) {
    const weight = system.weight?.value ?? system.weight;
    rows.push({ label: game.i18n.localize("DND5E.Weight"), value: String(weight) });
  }
  if (system.range?.value != null || system.range?.special) rows.push({ label: game.i18n.localize("DND5E.Range"), value: formatSpellRange(system.range) });
  return rows;
}

function documentDescription(document, kind) {
  if (kind === "effect") {
    return document.description ?? document.system?.description?.value ?? document.getFlag?.("dae", "description") ?? document.getFlag?.("core", "description") ?? "";
  }
  return document.system?.description?.value ?? document.system?.description ?? document.description ?? "";
}

function effectRemainingLabel(effect) {
  const duration = effect?.duration ?? {};
  const remaining = Number(duration.remaining);
  if (Number.isFinite(remaining) && remaining >= 0 && duration.remaining !== undefined && duration.remaining !== null) {
    if (duration.rounds) return `${Math.ceil(remaining)} ${game.i18n.localize("ACTION_HUD.roundsRemaining")}`;
    return formatRemainingSeconds(remaining);
  }
  const seconds = Number(duration.seconds);
  const startTime = Number(duration.startTime);
  if (Number.isFinite(seconds) && seconds > 0 && Number.isFinite(startTime) && Number.isFinite(game.time?.worldTime)) {
    return formatRemainingSeconds(Math.max(0, seconds - (game.time.worldTime - startTime)));
  }
  const rounds = Number(duration.rounds);
  if (Number.isFinite(rounds) && rounds > 0) {
    if (game.combat?.started && duration.startRound !== undefined && duration.startRound !== null && (!duration.combat || duration.combat === game.combat.id)) {
      const left = Math.max(0, rounds - Math.max(0, Number(game.combat.round ?? 0) - Number(duration.startRound ?? 0)));
      return `${left} ${game.i18n.localize("ACTION_HUD.roundsRemaining")}`;
    }
    return `${rounds} ${game.i18n.localize("ACTION_HUD.roundsTotal")}`;
  }
  const turns = Number(duration.turns);
  if (Number.isFinite(turns) && turns > 0) return `${turns} ${game.i18n.localize("ACTION_HUD.turnsRemaining")}`;
  const label = duration.label;
  if (typeof label === "string" && label.trim() && label !== "—") return label;
  const daeSpecial = effect.getFlag?.("dae", "specialDuration") ?? effect.flags?.dae?.specialDuration;
  if (Array.isArray(daeSpecial) && daeSpecial.length) return game.i18n.localize("ACTION_HUD.untilTrigger");
  return game.i18n.localize("ACTION_HUD.temporaryEffect");
}

function formatRemainingSeconds(value) {
  const seconds = Math.max(0, Math.ceil(Number(value) || 0));
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function applyTooltipScale(value = game.settings.get(MODULE_ID, "scale") ?? 1) {
  const scale = Math.max(0.7, Math.min(1.2, Number(value) || 1));
  const cards = document.querySelectorAll(".ahud-spell-tooltip-card");
  for (const card of cards) {
    card.style.setProperty("--ahud-scale", String(scale));
    const state = hoverTooltipState?.card === card ? hoverTooltipState : null;
    if (state && !state.pinned) {
      positionSpellTooltip(card, state.anchor, state);
      continue;
    }
    // Keep pinned cards in view when enlarging them; their current position remains the anchor.
    if (card.classList.contains("is-pinned")) {
      const left = Number.parseFloat(card.style.left) || card.getBoundingClientRect().left || 4;
      const top = Number.parseFloat(card.style.top) || card.getBoundingClientRect().top || 4;
      const width = card.offsetWidth || 360;
      const height = card.offsetHeight || 420;
      card.style.left = `${Math.max(4, Math.min(window.innerWidth - width - 4, left))}px`;
      card.style.top = `${Math.max(4, Math.min(window.innerHeight - height - 4, top))}px`;
    }
  }
}

function positionSpellTooltip(card, tile, state) {
  if (!card || !tile || state?.pinned) return;
  if (state?.kind === "effect") {
    positionEffectTooltip(card, tile, state);
    return;
  }
  card.style.visibility = "hidden";
  card.style.left = "0px";
  card.style.top = "0px";
  card.style.width = "";
  card.style.maxHeight = "";
  card.hidden = false;

  const anchor = tile.getBoundingClientRect();
  const hudRect = hudRoot?.isConnected ? hudRoot.getBoundingClientRect() : null;
  const drawer = tile.closest?.(".ahud-drawer:not([hidden])");
  const drawerRect = drawer?.getBoundingClientRect?.() ?? null;
  const alignToDrawer = Boolean(drawerRect && hudRect);
  // For item tiles in an open extension, the hover card starts at the extension's top
  // and may grow down only as far as the extension-plus-HUD combined height.
  if (alignToDrawer) {
    const topEdge = Math.max(4, drawerRect.top);
    const hudBottomSpace = Math.max(0, hudRect.bottom - topEdge);
    const viewportSpace = Math.max(0, window.innerHeight - topEdge - 8);
    const maxHeight = Math.max(80, Math.min(hudBottomSpace, viewportSpace));
    card.style.maxHeight = `${maxHeight}px`;
  }

  let width = card.offsetWidth || 288;
  let height = card.offsetHeight || 300;
  let left = null;
  let preferredSide = "anchor";
  if (hudRect) {
    const leftSpace = Math.floor(hudRect.left - 16);
    const rightSpace = Math.floor(window.innerWidth - hudRect.right - 16);
    // Keep transient detail cards to the left of the overall HUD whenever practical.
    if (leftSpace >= 240) {
      preferredSide = "hud-left";
      if (leftSpace < width) card.style.width = `${Math.max(220, leftSpace)}px`;
      width = card.offsetWidth || width;
      left = Math.max(8, hudRect.left - width - 8);
    } else if (rightSpace >= 280) {
      preferredSide = "hud-right";
      if (rightSpace < width) card.style.width = `${Math.max(220, rightSpace)}px`;
      width = card.offsetWidth || width;
      left = Math.min(window.innerWidth - width - 8, hudRect.right + 8);
    }
  }
  if (left === null) {
    left = anchor.right + 8;
    if (left + width > window.innerWidth - 8) left = anchor.left - width - 8;
    left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
  }

  height = card.offsetHeight || height;
  let top;
  if (alignToDrawer) {
    // Exact top alignment with the open extension; flex content stays natural-height
    // below the cap, and scrolls internally only when it exceeds the available height.
    top = Math.max(4, drawerRect.top);
  } else {
    top = anchor.top;
    if (preferredSide.startsWith("hud-")) top = Math.min(anchor.top, hudRect?.bottom - height || anchor.top);
    if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8;
    top = Math.max(8, top);
  }
  // Keep the card's bottom within the viewport if the extension happens to start near it.
  if (top + Math.min(height, Number.parseFloat(card.style.maxHeight) || height) > window.innerHeight - 4) {
    top = Math.max(4, window.innerHeight - Math.min(height, Number.parseFloat(card.style.maxHeight) || height) - 4);
  }
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.style.visibility = "visible";
}
function positionEffectTooltip(card, anchor, state) {
  if (!card || !anchor || !state || state.pinned) return;
  card.style.visibility = "hidden";
  card.style.left = "0px";
  card.style.top = "0px";
  card.style.width = "";
  card.hidden = false;

  const anchorRect = anchor.getBoundingClientRect();
  const x = Number.isFinite(state.pointerX) ? state.pointerX : anchorRect.left + anchorRect.width / 2;
  const y = Number.isFinite(state.pointerY) ? state.pointerY : anchorRect.top + anchorRect.height / 2;
  const gap = 18;
  const width = card.offsetWidth || 288;
  const height = card.offsetHeight || 300;
  // Prefer the lower-right of the cursor, then flip sides when near a viewport edge.
  let left = x + gap;
  let top = y + gap;
  if (left + width > window.innerWidth - 8) left = x - width - gap;
  if (top + height > window.innerHeight - 8) top = y - height - gap;
  left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
  top = Math.max(8, Math.min(window.innerHeight - height - 8, top));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.style.visibility = "visible";
}

function removeAnchorTooltipPin(state) {
  if (!state?.anchorPin) return;
  state.anchorPin.remove();
  state.anchorPin = null;
  state.pinHovered = false;
}

function positionAnchorTooltipPin(state) {
  const button = state?.anchorPin;
  const anchor = state?.anchor;
  if (!button || !anchor?.isConnected || state.pinned) return;
  const rect = anchor.getBoundingClientRect();
  const size = Math.max(22, Math.min(28, 24 * (Number(game.settings.get(MODULE_ID, "scale")) || 1)));
  button.style.width = `${size}px`;
  button.style.height = `${size}px`;
  button.style.left = `${Math.max(4, Math.min(window.innerWidth - size - 4, rect.right - size - 2))}px`;
  button.style.top = `${Math.max(4, Math.min(window.innerHeight - size - 4, rect.bottom - size - 2))}px`;
  button.classList.add("is-visible");
}

function createAnchorTooltipPin(state) {
  if (!state || state.pinned || !state.anchor?.isConnected) return;
  if (state.anchorPin?.isConnected) {
    positionAnchorTooltipPin(state);
    return;
  }
  const button = window.document.createElement("button");
  button.type = "button";
  button.className = "ahud-anchor-tooltip-pin is-visible";
  button.title = game.i18n.localize("ACTION_HUD.pinTooltip");
  button.setAttribute("aria-label", button.title);
  button.innerHTML = '<i class="fas fa-thumbtack" aria-hidden="true"></i>';
  button.addEventListener("pointerenter", () => {
    state.pinHovered = true;
    button.classList.add("is-visible");
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  });
  button.addEventListener("pointerleave", () => {
    state.pinHovered = false;
    state.anchorHovered = Boolean(state.anchor?.matches?.(":hover"));
    scheduleHideSpellTooltip(state);
  });
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    state.cardPin?.click();
  });
  window.document.body.appendChild(button);
  state.anchorPin = button;
  positionAnchorTooltipPin(state);
}

function midiUsedAction(actor, type) {
  if (!actor) return false;
  const api = game.modules?.get?.("midi-qol")?.api ?? globalThis.MidiQOL;
  const methodNames = type === "bonus" ? ["hasUsedBonusAction"]
    : type === "reaction" ? ["hasUsedReaction"]
    : type === "action" ? ["hasUsedAction"] : [];
  for (const methodName of methodNames) {
    try {
      const result = api?.[methodName]?.(actor);
      if (result === true || (typeof result === "number" && result > 0)) return true;
    } catch (_) { /* Continue to flags/effect-based fallbacks for other Midi-QoL versions. */ }
  }

  const actions = foundry.utils.getProperty(actor, "flags.midi-qol.actions")
    ?? actor.getFlag?.("midi-qol", "actions") ?? {};
  const candidates = type === "bonus"
    ? [actions.bonus, actions.bonusAction, actions.bonusActionsUsed, actions.bonusActionUsed]
    : type === "reaction"
      ? [actions.reaction, actions.reactionsUsed, actions.reactionUsed]
      : [actions.action, actions.actionsUsed, actions.actionUsed];
  if (candidates.some(value => value === true || (typeof value === "number" && value > 0) || ["true", "1"].includes(String(value).toLowerCase()))) return true;

  // Midi-QoL's displayed status effects and common D&D/CUB compatibility effects. Exact normalized
  // IDs/names are used so ordinary features merely mentioning reactions are not mistaken as usage.
  const normalize = value => String(value ?? "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  const expected = type === "bonus"
    ? new Set(["bonusaction", "bonusactionused", "bonusactionspent", "bonusactiontaken", "midiqolbonusaction", "midiqolbonusactionused"])
    : type === "reaction"
      ? new Set(["reaction", "reactionused", "reactionspent", "reactiontaken", "midiqolreaction", "midiqolreactionused"])
      : new Set(["action", "actionused", "actionspent", "actiontaken", "midiqolaction", "midiqolactionused"]);
  const statusValues = [...(actor.statuses ?? [])].map(normalize);
  if (statusValues.some(value => expected.has(value))) return true;
  const effects = actor.effects?.contents ?? [];
  for (const effect of effects) {
    if (effect.disabled) continue;
    const keys = [effect.name, effect.id, effect.getFlag?.("core", "statusId"), ...(effect.statuses ?? [])].map(normalize);
    if (keys.some(value => expected.has(value))) return true;
  }
  // Compatibility with localized CUB effects: match their full localized labels exactly.
  const localizedKeys = type === "bonus"
    ? ["DND5E.BonusAction", "DND5E.BonusActionUsed", "CUB.conditions.bonus action", "midi-qol.bonusActionUsed"]
    : type === "reaction"
      ? ["DND5E.Reaction", "DND5E.ReactionUsed", "CUB.conditions.reaction", "midi-qol.reactionUsed"]
      : ["DND5E.Action", "DND5E.ActionUsed", "midi-qol.actionUsed"];
  const localized = new Set(localizedKeys.map(key => normalize(game.i18n.localize(key))));
  return effects.some(effect => !effect.disabled && [effect.name, effect.id, effect.getFlag?.("core", "statusId"), ...(effect.statuses ?? [])].some(value => localized.has(normalize(value))));
}

function getItemActionAvailability(actor, item) {
  const types = itemActivationTypes(item);
  if (!types.size) return { blocked: false, reason: "", types };
  const spent = new Set();
  if (midiUsedAction(actor, "action")) spent.add("action");
  if (midiUsedAction(actor, "bonus")) spent.add("bonus");
  if (midiUsedAction(actor, "reaction")) spent.add("reaction");
  const availableTypes = [...types].filter(type => !spent.has(type));
  const blocked = availableTypes.length === 0 && [...types].some(type => spent.has(type));
  const reasons = [];
  if (blocked && types.has("action") && spent.has("action")) reasons.push(game.i18n.localize("ACTION_HUD.actionUsed"));
  if (blocked && types.has("bonus") && spent.has("bonus")) reasons.push(game.i18n.localize("ACTION_HUD.bonusActionUsed"));
  if (blocked && types.has("reaction") && spent.has("reaction")) reasons.push(game.i18n.localize("ACTION_HUD.reactionUsed"));
  return { blocked, reason: reasons.join(" / "), types };
}

function configLabel(entry, fallback = "") {
  if (typeof entry === "string") return game.i18n.localize(entry);
  if (entry && typeof entry === "object") {
    const candidate = entry.label ?? entry.fullKey ?? entry.name ?? entry.abbreviation;
    const label = typeof candidate === "string" && candidate.trim() ? candidate : fallback;
    return game.i18n.localize(label);
  }
  return game.i18n.localize(fallback);
}
function renderQuickDicePanel(panel) {
  const formulaLabel = document.createElement("label");
  formulaLabel.className = "ahud-quick-dice-formula-label";
  formulaLabel.textContent = game.i18n.localize("ACTION_HUD.quickDiceFormula");

  const formulaInput = document.createElement("input");
  formulaInput.type = "text";
  formulaInput.className = "ahud-quick-dice-formula";
  formulaInput.value = quickDiceFormula;
  formulaInput.placeholder = game.i18n.localize("ACTION_HUD.quickDicePlaceholder");
  formulaInput.autocomplete = "off";
  formulaInput.spellcheck = false;
  formulaInput.setAttribute("aria-label", formulaLabel.textContent);
  formulaInput.addEventListener("input", () => { quickDiceFormula = formulaInput.value; });
  formulaInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void rollQuickDice(panel, formulaInput);
  });

  const formulaRow = document.createElement("div");
  formulaRow.className = "ahud-quick-dice-input-row";
  formulaRow.append(formulaLabel, formulaInput);
  panel.appendChild(formulaRow);

  const controls = document.createElement("div");
  controls.className = "ahud-quick-dice-controls";
  const dice = document.createElement("div");
  dice.className = "ahud-quick-dice-buttons";
  dice.setAttribute("aria-label", game.i18n.localize("ACTION_HUD.quickDiceAddDice"));
  const diceTypes = [20, 12, 10, 8, 6, 4];
  for (const die of diceTypes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ahud-quick-die-button";
    button.dataset.die = String(die);
    button.title = game.i18n.format("ACTION_HUD.quickDiceAddOne", { die: `d${die}` });
    button.innerHTML = `<span class="ahud-quick-die-glyph" aria-hidden="true">${die === 20 ? '<i class="fas fa-dice-d20"></i>' : '<i class="fas fa-dice"></i>'}</span><b>d${die}</b>`;
    button.addEventListener("click", () => {
      quickDiceFormula = addDieToFormula(quickDiceFormula, die);
      formulaInput.value = quickDiceFormula;
      formulaInput.focus();
      formulaInput.setSelectionRange(formulaInput.value.length, formulaInput.value.length);
    });
    dice.appendChild(button);
  }
  controls.appendChild(dice);

  const rollControls = document.createElement("div");
  rollControls.className = "ahud-quick-dice-roll-controls";
  const modeGroup = document.createElement("div");
  modeGroup.className = "ahud-quick-dice-mode";
  modeGroup.setAttribute("role", "group");
  modeGroup.setAttribute("aria-label", game.i18n.localize("ACTION_HUD.quickDiceMode"));
  for (const mode of [
    { id: "normal", label: game.i18n.localize("ACTION_HUD.quickDiceNormal"), short: game.i18n.localize("ACTION_HUD.quickDiceNormalShort") },
    { id: "advantage", label: game.i18n.localize("ACTION_HUD.quickDiceAdvantage"), short: game.i18n.localize("ACTION_HUD.quickDiceAdvantageShort") },
    { id: "disadvantage", label: game.i18n.localize("ACTION_HUD.quickDiceDisadvantage"), short: game.i18n.localize("ACTION_HUD.quickDiceDisadvantageShort") }
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ahud-quick-dice-mode-button";
    button.dataset.mode = mode.id;
    button.textContent = mode.short;
    button.title = mode.label;
    button.setAttribute("aria-pressed", String(quickDiceMode === mode.id));
    button.classList.toggle("is-selected", quickDiceMode === mode.id);
    button.addEventListener("click", () => {
      quickDiceMode = mode.id;
      for (const sibling of modeGroup.querySelectorAll("[data-mode]")) {
        const selected = sibling.dataset.mode === quickDiceMode;
        sibling.classList.toggle("is-selected", selected);
        sibling.setAttribute("aria-pressed", String(selected));
      }
    });
    modeGroup.appendChild(button);
  }
  rollControls.appendChild(modeGroup);

  const rollButton = document.createElement("button");
  rollButton.type = "button";
  rollButton.className = "ahud-quick-dice-roll";
  rollButton.innerHTML = `<i class="fas fa-dice-d20" aria-hidden="true"></i><span>${game.i18n.localize("ACTION_HUD.quickDiceRoll")}</span>`;
  rollButton.title = game.i18n.localize("ACTION_HUD.quickDiceRollHint");
  rollButton.addEventListener("click", () => void rollQuickDice(panel, formulaInput));
  rollControls.appendChild(rollButton);

  controls.appendChild(rollControls);
  panel.appendChild(controls);
}

function addDieToFormula(currentFormula, die) {
  const formula = String(currentFormula ?? "").trim();
  if (!formula) return `1d${die}`;
  // Increase the first positive term for this die size, if present. A negative term
  // is left alone so clicking a die adds a positive die rather than making it more negative.
  const expression = new RegExp(`(^|\\+\\s*)(\\d*)d${die}\\b`, "i");
  const match = expression.exec(formula);
  if (match) {
    const count = Math.max(1, Number.parseInt(match[2] || "1", 10));
    const updatedTerm = `${match[1]}${count + 1}d${die}`;
    return formula.slice(0, match.index) + updatedTerm + formula.slice(match.index + match[0].length);
  }
  return `${formula}${/[+\-*/(]\s*$/.test(formula) ? " " : " + "}1d${die}`;
}

function applyQuickDiceMode(formula, mode) {
  if (mode === "normal") return formula;
  // Advantage/disadvantage applies to the first d20 term only, as it would to a single
  // check. Other dice in the formula remain untouched as bonus or damage dice.
  const d20 = /\b\d*d20\b/i;
  if (!d20.test(formula)) return formula;
  return formula.replace(d20, mode === "advantage" ? "2d20kh" : "2d20kl");
}

async function rollQuickDice(panel, formulaInput) {
  if (quickDiceRolling) return;
  const formula = String(formulaInput?.value ?? quickDiceFormula).trim();
  quickDiceFormula = formula;
  if (!formula) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.quickDiceFormulaRequired"));
    formulaInput?.focus();
    return;
  }
  const rollFormula = applyQuickDiceMode(formula, quickDiceMode);
  quickDiceRolling = true;
  const rollButton = panel.querySelector(".ahud-quick-dice-roll");
  if (rollButton) rollButton.disabled = true;
  try {
    const data = activeActor?.getRollData?.() ?? {};
    const roll = await new Roll(rollFormula, data).evaluate();
    const speaker = ChatMessage.getSpeaker({ actor: activeActor ?? undefined, token: activeToken?.document ?? undefined });
    // Foundry V14 uses messageMode (public/gm/blind/self) for programmatic rolls.
    // Read the same current selection used by other automated rolls in the chat UI.
    const messageMode = game.settings.get("core", "messageMode") || "public";
    await roll.toMessage({ speaker }, { messageMode });
    // Clear the formula only after the roll has been successfully posted.
    // Keep the selected roll mode so repeated rolls can use the same setting.
    quickDiceFormula = "";
    if (formulaInput) formulaInput.value = "";
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to roll quick dice formula`, { formula, rollFormula, error });
    ui.notifications.error(game.i18n.localize("ACTION_HUD.quickDiceRollFailed"));
  } finally {
    quickDiceRolling = false;
    if (rollButton?.isConnected) rollButton.disabled = false;
  }
}

function renderCombatActionsPanel(panel) {
  const actor = activeActor;
  const token = activeToken;
  const enabled = Boolean(actor && token && (game.user.isGM || actor.testUserPermission(game.user, "OWNER")));
  const help = document.createElement("p");
  help.className = "ahud-panel-note";
  help.textContent = game.i18n.localize("ACTION_HUD.combatActionsHint");
  panel.appendChild(help);

  const actions = [
    { id: "dodge", label: game.i18n.localize("ACTION_HUD.dodge"), icon: "fa-shield-halved", description: game.i18n.localize("ACTION_HUD.dodgeHint") },
    { id: "help", label: game.i18n.localize("ACTION_HUD.help"), icon: "fa-handshake-angle", description: game.i18n.localize("ACTION_HUD.helpHint") },
    { id: "shove", label: game.i18n.localize("ACTION_HUD.shove"), icon: "fa-hand", description: game.i18n.localize(getShoveRulesVersion() === "modern" ? "ACTION_HUD.shoveHint2024" : "ACTION_HUD.shoveHint2014") },
    { id: "grapple", label: isActionHudGrappledToken(token?.document) ? game.i18n.localize("ACTION_HUD.grappleEscape") : game.i18n.localize("ACTION_HUD.grapple"), icon: isActionHudGrappledToken(token?.document) ? "fa-person-running" : "fa-hand-back-fist", description: game.i18n.localize(isActionHudGrappledToken(token?.document) ? "ACTION_HUD.grappleEscapeHint" : "ACTION_HUD.grappleHint") },
    { id: "dash", label: game.i18n.localize("ACTION_HUD.dash"), icon: "fa-person-running", description: game.i18n.localize("ACTION_HUD.dashHint") },
    { id: "disengage", label: game.i18n.localize("ACTION_HUD.disengage"), icon: "fa-person-walking-arrow-right", description: game.i18n.localize("ACTION_HUD.disengageHint") },
    { id: "ready", label: game.i18n.localize("ACTION_HUD.ready"), icon: "fa-hourglass-half", description: game.i18n.localize("ACTION_HUD.readyHint") },
    { id: "ready-spell", label: game.i18n.localize("ACTION_HUD.readySpell"), icon: "fa-hourglass-half", description: game.i18n.localize("ACTION_HUD.readySpellHint") },
    { id: "search", label: game.i18n.localize("ACTION_HUD.searchAction"), icon: "fa-eye", description: game.i18n.localize("ACTION_HUD.searchHint") },
    { id: "hide", label: game.i18n.localize("ACTION_HUD.hideAction"), icon: "fa-user-secret", description: game.i18n.localize("ACTION_HUD.hideHint") }
  ];
  const grid = document.createElement("div");
  grid.className = "ahud-combat-action-grid";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ahud-combat-action-tile";
    button.dataset.action = "combat-action";
    button.dataset.combatAction = action.id;
    button.disabled = !enabled;
    button.title = action.description;
    button.setAttribute("aria-label", `${action.label}. ${action.description}`);
    const icon = document.createElement("i"); icon.className = `fas ${action.icon}`; icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("strong"); label.textContent = action.label;
    button.append(icon, label);
    grid.appendChild(button);
  }
  panel.appendChild(grid);
}
function renderGMToolsPanel(panel) {
  if (!game.user.isGM || !gmMode) return;
  const section = document.createElement("section"); section.className = "ahud-gm-encounter-section";
  const combat = getSceneCombat();
  const combatants = combat?.combatants?.contents ?? [];
  const combatCount = combatants.length;
  const running = Boolean(combat?.started);
  const sceneTokens = [...(canvas.tokens?.placeables ?? [])].filter(token => token.actor);
  const sceneTokenIds = new Set(sceneTokens.map(token => String(token.document.id)));
  for (const selectedId of [...gmEncounterSelectedTokenIds]) {
    if (!sceneTokenIds.has(selectedId)) gmEncounterSelectedTokenIds.delete(selectedId);
  }
  const combatantTokenIds = new Set(combatants.map(combatant => String(combatant.tokenId ?? combatant.token?.id ?? "")));
  const addableSceneCount = sceneTokens.filter(token => !combatantTokenIds.has(String(token.document.id))).length;
  const selectedAddableCount = sceneTokens.filter(token => gmEncounterSelectedTokenIds.has(String(token.document.id)) && !combatantTokenIds.has(String(token.document.id))).length;
  const fallenCombatants = getFallenCombatants(combat);

  const status = document.createElement("div");
  status.className = `ahud-gm-combat-status ${running ? "is-running" : "is-stopped"}`;
  const stateIcon = document.createElement("i"); stateIcon.className = `fas ${running ? "fa-circle-play" : "fa-circle-pause"}`; stateIcon.setAttribute("aria-hidden", "true");
  const stateText = document.createElement("strong"); stateText.textContent = game.i18n.localize(running ? "ACTION_HUD.combatRunning" : combat ? "ACTION_HUD.combatNotStarted" : "ACTION_HUD.noCombatForScene");
  const count = document.createElement("small"); count.textContent = game.i18n.format(combatCount === 1 ? "ACTION_HUD.combatantCountSingular" : "ACTION_HUD.combatantCountPlural", { count: combatCount });
  status.append(stateIcon, stateText, count); section.appendChild(status);

  const controls = document.createElement("div"); controls.className = "ahud-gm-encounter-controls";
  const hasControlled = [...(canvas.tokens?.controlled ?? [])].some(token => token.actor);
  const actions = [
    { id: "start", label: game.i18n.localize("ACTION_HUD.startCombat"), icon: "fa-play", disabled: running },
    { id: "end", label: game.i18n.localize("ACTION_HUD.endCombat"), icon: "fa-stop", disabled: !running },
    { id: "add-controlled", label: game.i18n.localize("ACTION_HUD.addControlledToCombat"), icon: "fa-user-plus", disabled: !hasControlled },
    { id: "previous", label: game.i18n.localize("ACTION_HUD.previousCombatant"), icon: "fa-backward-step", disabled: !running || combatCount < 2 },
    { id: "next", label: game.i18n.localize("ACTION_HUD.nextCombatant"), icon: "fa-forward-step", disabled: !running || combatCount < 2 },
    { id: "tracker", label: game.i18n.localize("ACTION_HUD.openCombatTracker"), icon: "fa-list-ol", disabled: false },
    { id: "add-all", label: game.i18n.localize("ACTION_HUD.addAllSceneTokens"), icon: "fa-users", disabled: addableSceneCount === 0 },
    { id: "add-selected", label: game.i18n.format("ACTION_HUD.addSelectedSceneTokensCount", { count: selectedAddableCount }), icon: "fa-check-double", disabled: selectedAddableCount === 0 },
    { id: "remove-fallen", label: game.i18n.format("ACTION_HUD.removeFallenCombatantsCount", { count: fallenCombatants.length }), icon: "fa-user-minus", disabled: fallenCombatants.length === 0 }
  ];
  for (const entry of actions) {
    const button = document.createElement("button"); button.type = "button"; button.className = "ahud-gm-encounter-button";
    button.dataset.action = "gm-encounter"; button.dataset.encounterAction = entry.id; button.disabled = Boolean(entry.disabled);
    const icon = document.createElement("i"); icon.className = `fas ${entry.icon}`; icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span"); label.textContent = entry.label;
    button.append(icon, label); controls.appendChild(button);
  }
  section.appendChild(controls);
  const heading = document.createElement("h4"); heading.textContent = game.i18n.localize("ACTION_HUD.sceneTokens"); section.appendChild(heading);
  const search = document.createElement("input"); search.type = "search"; search.className = "ahud-filter ahud-gm-token-search";
  search.placeholder = game.i18n.localize("ACTION_HUD.searchSceneTokens"); search.setAttribute("aria-label", search.placeholder); search.value = gmTokenSearchQuery; section.appendChild(search);

  const filters = document.createElement("div"); filters.className = "ahud-gm-token-filters";
  const filterOptions = [
    { id: "all", label: game.i18n.localize("ACTION_HUD.allSceneTokens") },
    { id: "in-combat", label: game.i18n.localize("ACTION_HUD.tokensInCombat") },
    { id: "not-in-combat", label: game.i18n.localize("ACTION_HUD.tokensNotInCombat") }
  ];
  for (const option of filterOptions) {
    const button = document.createElement("button"); button.type = "button"; button.className = "ahud-gm-token-filter";
    button.dataset.action = "gm-token-filter"; button.dataset.tokenFilter = option.id; button.textContent = option.label;
    button.classList.toggle("is-selected", gmTokenFilter === option.id); button.setAttribute("aria-pressed", String(gmTokenFilter === option.id));
    filters.appendChild(button);
  }
  section.appendChild(filters);
  const list = document.createElement("div"); list.className = "ahud-gm-token-list"; list.dataset.gmTokenList = ""; section.appendChild(list);
  panel.appendChild(section);
  const renderTokenList = query => {
    list.replaceChildren();
    const normalized = String(query ?? "").trim().toLocaleLowerCase();
    const currentCombat = getSceneCombat();
    const currentCombatants = currentCombat?.combatants?.contents ?? [];
    const currentCombatantTokenIds = new Set(currentCombatants.map(combatant => String(combatant.tokenId ?? combatant.token?.id ?? "")));
    const tokens = [...(canvas.tokens?.placeables ?? [])].filter(placeable => placeable.actor)
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang || undefined, { sensitivity: "base" }));
    const filtered = tokens.filter(placeable => {
      const inCombat = currentCombatantTokenIds.has(String(placeable.document.id));
      const matchesQuery = !normalized || String(placeable.name ?? placeable.actor?.name ?? "").toLocaleLowerCase().includes(normalized);
      const matchesFilter = gmTokenFilter === "all" || (gmTokenFilter === "in-combat" ? inCombat : !inCombat);
      return matchesQuery && matchesFilter;
    });
    if (!filtered.length) {
      const empty = document.createElement("p"); empty.className = "ahud-empty-state";
      empty.textContent = tokens.length ? game.i18n.localize("ACTION_HUD.noMatchingTokens") : game.i18n.localize("ACTION_HUD.noSceneTokens");
      list.appendChild(empty); return;
    }
    const controlledIds = new Set([...(canvas.tokens?.controlled ?? [])].map(token => String(token.document.id)));
    for (const placeable of filtered) {
      const tokenId = String(placeable.document.id);
      const inCombat = currentCombatantTokenIds.has(tokenId);
      const selectedForBulk = gmEncounterSelectedTokenIds.has(tokenId);
      const row = document.createElement("div"); row.className = "ahud-gm-token-row";
      row.classList.toggle("is-controlled", controlledIds.has(tokenId));
      row.classList.toggle("is-in-combat", inCombat);
      row.classList.toggle("is-bulk-selected", selectedForBulk);

      const selection = document.createElement("button"); selection.type = "button";
      selection.className = `ahud-gm-token-selection ${selectedForBulk ? "is-selected" : ""}`;
      selection.dataset.action = "gm-token-selection"; selection.dataset.tokenId = tokenId;
      selection.title = game.i18n.localize(selectedForBulk ? "ACTION_HUD.deselectSceneToken" : "ACTION_HUD.selectSceneTokenForBulk");
      selection.setAttribute("aria-label", selection.title); selection.setAttribute("aria-pressed", String(selectedForBulk));
      const selectionIcon = document.createElement("i"); selectionIcon.className = `fas ${selectedForBulk ? "fa-check-square" : "fa-square"}`; selectionIcon.setAttribute("aria-hidden", "true"); selection.appendChild(selectionIcon);

      const selectButton = document.createElement("button"); selectButton.type = "button"; selectButton.className = "ahud-gm-token-select";
      selectButton.dataset.action = "gm-select-token"; selectButton.dataset.tokenId = tokenId;
      selectButton.title = game.i18n.localize("ACTION_HUD.selectTokenAndOpenHud");
      const portrait = document.createElement("span"); portrait.className = "ahud-gm-token-portrait"; portrait.setAttribute("aria-hidden", "true");
      const image = document.createElement("img"); image.src = placeable.document.texture?.src ?? placeable.actor.img ?? "icons/svg/mystery-man.svg"; image.alt = "";
      portrait.appendChild(image);
      const details = document.createElement("span"); details.className = "ahud-gm-token-details";
      const name = document.createElement("strong"); name.textContent = placeable.name ?? placeable.actor.name;
      details.append(name); selectButton.append(portrait, details);
      const membership = document.createElement("button"); membership.type = "button";
      membership.className = `ahud-gm-token-combat-toggle ${inCombat ? "is-in-combat" : "is-out-of-combat"}`;
      membership.dataset.action = "gm-encounter"; membership.dataset.encounterAction = inCombat ? "remove-token" : "add-token"; membership.dataset.tokenId = tokenId;
      membership.title = game.i18n.localize(inCombat ? "ACTION_HUD.removeTokenFromCombat" : "ACTION_HUD.addTokenToCombat");
      membership.setAttribute("aria-label", membership.title);
      const membershipIcon = document.createElement("i"); membershipIcon.className = `fas ${inCombat ? "fa-minus" : "fa-plus"}`; membershipIcon.setAttribute("aria-hidden", "true");
      membership.appendChild(membershipIcon);
      row.append(selection, selectButton, membership); list.appendChild(row);
    }
  };
  search.addEventListener("input", () => { gmTokenSearchQuery = search.value; renderTokenList(gmTokenSearchQuery); });
  renderTokenList(gmTokenSearchQuery);
}

function getFallenCombatants(combat) {
  return (combat?.combatants?.contents ?? []).filter(combatant => {
    if (combatant.defeated === true || combatant.isDefeated === true) return true;
    const actor = combatant.actor;
    const hpValue = Number(actor?.system?.attributes?.hp?.value);
    // A PC at 0 HP can still take death-saving turns; do not remove a character solely for reaching 0 HP.
    return actor?.type !== "character" && Number.isFinite(hpValue) && hpValue <= 0;
  });
}

function toggleGMEncounterTokenSelection(tokenId, button = null) {
  if (!game.user.isGM || !gmMode || !tokenId) return;
  const id = String(tokenId);
  if (gmEncounterSelectedTokenIds.has(id)) gmEncounterSelectedTokenIds.delete(id);
  else gmEncounterSelectedTokenIds.add(id);
  const selected = gmEncounterSelectedTokenIds.has(id);
  const row = button?.closest?.(".ahud-gm-token-row");
  row?.classList.toggle("is-bulk-selected", selected);
  if (button) {
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.title = game.i18n.localize(selected ? "ACTION_HUD.deselectSceneToken" : "ACTION_HUD.selectSceneTokenForBulk");
    button.setAttribute("aria-label", button.title);
    const icon = button.querySelector("i");
    if (icon) icon.className = `fas ${selected ? "fa-check-square" : "fa-square"}`;
  }
  const sceneTokenIds = new Set([...(canvas.tokens?.placeables ?? [])].filter(token => token.actor).map(token => String(token.document.id)));
  const combatTokenIds = new Set((getSceneCombat()?.combatants?.contents ?? []).map(combatant => String(combatant.tokenId ?? combatant.token?.id ?? "")));
  for (const selectedId of [...gmEncounterSelectedTokenIds]) if (!sceneTokenIds.has(selectedId)) gmEncounterSelectedTokenIds.delete(selectedId);
  const count = [...gmEncounterSelectedTokenIds].filter(selectedId => sceneTokenIds.has(selectedId) && !combatTokenIds.has(selectedId)).length;
  const addSelected = hudRoot?.querySelector('[data-action="gm-encounter"][data-encounter-action="add-selected"]');
  if (addSelected) {
    addSelected.disabled = count === 0;
    const label = addSelected.querySelector("span");
    if (label) label.textContent = game.i18n.format("ACTION_HUD.addSelectedSceneTokensCount", { count });
  }
}

function refreshGMEncounterPanel() {
  const panel = hudRoot?.querySelector("[data-drawer-panel]");
  if (!panel || panel.hidden || panel.dataset.currentDrawer !== "gm-tools" || !game.user.isGM || !gmMode) return;
  openDrawer("gm-tools", true);
}
/**
 * Mark a readied spell as concentration even when the spell itself would not normally
 * require it. The D&D 5e system recognizes active effects carrying the concentrating
 * status as entries in actor.concentration, allowing native concentration management
 * and replacement behavior to work with this marker.
 */
async function applyReadySpellAction(actor) {
  const statusId = CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating";
  const readySpellLabel = game.i18n.localize("ACTION_HUD.readySpell");
  const actionFlag = effect => effect.getFlag?.(MODULE_ID, "combatAction");
  const concentrationEffects = () => (actor.effects?.contents ?? [...(actor.effects ?? [])])
    .filter(effect => effect.active !== false && (effect.statuses?.has?.(statusId) || effect.statuses?.includes?.(statusId)));
  const isReadySpellConcentration = effect => actionFlag(effect) === "ready-spell-concentration";
  const currentEffects = concentrationEffects();
  const otherConcentrationEffects = currentEffects.filter(effect => !isReadySpellConcentration(effect));

  if (otherConcentrationEffects.length) {
    const labels = otherConcentrationEffects.map(effect => effect.name || game.i18n.localize("DND5E.CONCENTRATION.NoSource"));
    const content = `<p>${game.i18n.localize("ACTION_HUD.readySpellConcentrationPrompt")}</p><p><strong>${labels.map(label => foundry.utils.escapeHTML(label)).join("<br>")}</strong></p>`;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("ACTION_HUD.readySpellConcentrationTitle") },
      content,
      rejectClose: false,
      modal: true,
      yes: { label: game.i18n.localize("ACTION_HUD.replaceConcentration") },
      no: { label: game.i18n.localize("ACTION_HUD.keepConcentration") }
    });
    if (confirmed !== true) return;

    // Let D&D 5e end its native concentration effects first so dependent effects are cleaned up.
    const nativeEffects = [...(actor.concentration?.effects ?? [])];
    if (typeof actor.endConcentration === "function" && nativeEffects.length) {
      await actor.endConcentration();
    }
    const remainingConcentration = concentrationEffects();
    if (remainingConcentration.length) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", remainingConcentration.map(effect => effect.id));
    }
  } else if (currentEffects.length) {
    // Reusing Ready Spell replaces only our existing concentration, without prompting or ending unrelated effects.
    const nativeEffects = new Set(actor.concentration?.effects ?? []);
    for (const effect of currentEffects.filter(isReadySpellConcentration)) {
      if (nativeEffects.has(effect) && typeof actor.endConcentration === "function") await actor.endConcentration(effect);
    }
    const leftovers = concentrationEffects().filter(isReadySpellConcentration);
    if (leftovers.length) await actor.deleteEmbeddedDocuments("ActiveEffect", leftovers.map(effect => effect.id));
  }

  await replaceActorActionEffects(actor, ["ready"]);
  // Remove an orphaned Ready Spell child as well as any older single-effect implementation.
  await replaceActorActionEffects(actor, ["ready-spell", "ready-spell-concentration"]);

  const inCombat = Boolean(game.combat?.started);
  const duration = inCombat ? { rounds: 10 } : { seconds: 3600 };
  const expiryFlags = inCombat ? { dae: { specialDuration: ["turnStart"] } } : {};
  const readySpellId = foundry.utils.randomID();
  const concentrationName = `${game.i18n.localize("EFFECT.DND5E.StatusConcentrating")}: ${readySpellLabel}`;
  const concentrationData = {
    name: concentrationName,
    // Use D&D 5e's native concentrating icon for the concentration parent.
    img: "systems/dnd5e/icons/svg/statuses/concentrating.svg",
    origin: actor.uuid,
    disabled: false,
    duration: foundry.utils.deepClone(duration),
    statuses: [statusId],
    description: game.i18n.format("DND5E.CONCENTRATION.Description", {
      name: readySpellLabel,
      type: game.i18n.localize("TYPES.Item.spell")
    }),
    changes: [],
    flags: {
      ...expiryFlags,
      [MODULE_ID]: {
        combatAction: "ready-spell-concentration",
        sourceActorUuid: actor.uuid,
        readySpellId
      }
    }
  };
  // D&D 5e treats the concentrating status as the anchor. The Ready Spell marker is a dependent
  // effect, mirroring the native spell-concentration + spell-effect relationship without casting anything.
  const created = await createActionEffect(actor, concentrationData);
  let concentrationEffect = Array.isArray(created) ? created[0] : created;
  if (!concentrationEffect?.uuid) {
    concentrationEffect = (actor.effects?.contents ?? []).find(effect =>
      effect.getFlag?.(MODULE_ID, "readySpellId") === readySpellId && isReadySpellConcentration(effect));
  }
  if (!concentrationEffect?.uuid) {
    // Fail clearly rather than create an unlinked marker which would outlive concentration.
    throw new Error("Ready Spell concentration effect was created but could not be resolved for linking.");
  }

  await createActionEffect(actor, {
    name: readySpellLabel,
    img: "icons/tools/navigation/hourglass.webp",
    origin: concentrationEffect.uuid,
    disabled: false,
    duration: foundry.utils.deepClone(duration),
    changes: [],
    flags: {
      ...expiryFlags,
      dnd5e: { dependentOn: concentrationEffect.uuid },
      [MODULE_ID]: {
        combatAction: "ready-spell",
        sourceActorUuid: actor.uuid,
        concentrationEffectUuid: concentrationEffect.uuid,
        readySpellId
      }
    }
  });
}
async function handleCoreCombatAction(action) {
  const actor = activeActor;
  const token = activeToken;
  if (!actor || !token || !(game.user.isGM || actor.testUserPermission(game.user, "OWNER"))) {
    ui.notifications.info(game.i18n.localize("ACTION_HUD.selectTokenForAction")); return;
  }

  // These actions require an active combat. Help (Skill) remains usable during exploration.
  if (["dodge", "disengage", "shove", "grapple"].includes(action) && !game.combat?.started) {
    ui.notifications.info(game.i18n.localize(action === "shove" ? "ACTION_HUD.shoveRequiresCombat" : "ACTION_HUD.combatMustBeStarted")); return;
  }

  try {
    if (action === "grapple") {
      await handleGrappleAction(token, actor);
    } else if (action === "dodge") {
      if (actorIsIncapacitatedOrImmobile(actor)) {
        ui.notifications.info(game.i18n.localize("ACTION_HUD.cannotDodge")); return;
      }
      await replaceActorActionEffects(actor, ["dodge"]);
      await createActionEffect(actor, {
        name: game.i18n.localize("ACTION_HUD.dodgeEffect"),
        img: "icons/skills/melee/shield-block-gray-orange.webp",
        origin: actor.uuid,
        duration: { rounds: 10 },
        changes: [
          { key: "flags.midi-qol.grants.disadvantage.attack.all", mode: CONST.ACTIVE_EFFECT_MODES.CUSTOM, value: "1", priority: 20 },
          { key: "system.abilities.dex.save.roll.mode", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "1", priority: 20 }
        ],
        flags: { dae: { specialDuration: ["turnStart"] }, [MODULE_ID]: { combatAction: "dodge", sourceActorUuid: actor.uuid } }
      });
    } else if (action === "help") {
      const targetToken = getSingleTargetedToken(token, "help");
      if (!targetToken) return;
      if (!isTokenWithinFeet(token, targetToken, 5)) {
        ui.notifications.warn(game.i18n.localize("ACTION_HUD.helpTargetOutOfRange")); return;
      }

      let helpType = helpTypeForDisposition(targetToken);
      if (helpType === "choose") helpType = await chooseHelpTypeDialog(targetToken);
      if (!helpType) return;

      if (helpType === "help-attack") {
        if (!game.combat?.started) {
          ui.notifications.info(game.i18n.localize("ACTION_HUD.combatMustBeStarted")); return;
        }
        if (!game.modules.get("midi-qol")?.active) {
          ui.notifications.warn(game.i18n.localize("ACTION_HUD.helpRequiresMidi")); return;
        }
        await replaceActorActionEffects(targetToken.actor, ["help-attack"]);
        await createActionEffect(targetToken.actor, {
          name: game.i18n.localize("ACTION_HUD.helpedAgainstAttacks"),
          img: "icons/skills/social/diplomacy-handshake.webp",
          origin: actor.uuid,
          duration: { rounds: 10 },
          changes: [
            { key: "flags.midi-qol.grants.advantage.attack.all", mode: CONST.ACTIVE_EFFECT_MODES.CUSTOM, value: `tokenUuid !== ${JSON.stringify(token.document.uuid)} ? 1 : false`, priority: 20 }
          ],
          // isAttacked is the target-side DAE expiry: the effect is on the enemy and grants attackers advantage.
          // turnStartSource and the numeric duration are fallback expiries.
          flags: { dae: { specialDuration: ["isAttacked", "turnStartSource"] }, [MODULE_ID]: { combatAction: "help-attack", sourceActorUuid: actor.uuid, sourceTokenUuid: token.document.uuid, targetActorUuid: targetToken.actor.uuid } }
        });
      } else {
        const result = await chooseSkillDialog({
          title: game.i18n.localize("ACTION_HUD.helpSkill"),
          description: game.i18n.format("ACTION_HUD.chooseAllyAndSkill", { target: targetToken.name ?? targetToken.actor.name }),
          submitLabel: game.i18n.localize("ACTION_HUD.applyHelp")
        });
        if (!result) return;
        const inCombat = Boolean(game.combat?.started);
        await replaceActorActionEffects(targetToken.actor, ["help-skill"]);
        await createActionEffect(targetToken.actor, {
          name: game.i18n.format("ACTION_HUD.helpSkillEffect", { skill: result.skillLabel }),
          img: "icons/skills/social/diplomacy-handshake.webp",
          origin: actor.uuid,
          duration: inCombat ? { rounds: 10 } : { seconds: 3600 },
          changes: [
            { key: `system.skills.${result.skill}.roll.mode`, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "1", priority: 20 }
          ],
          flags: { dae: { specialDuration: [`isSkill.${result.skill}`, ...(inCombat ? ["turnStartSource"] : [])] }, [MODULE_ID]: { combatAction: "help-skill", sourceActorUuid: actor.uuid, targetActorUuid: targetToken.actor.uuid, skill: result.skill } }
        });
      }
    } else if (action === "shove") {
      const targetToken = getSingleTargetedToken(token, "shove");
      if (!targetToken) return;
      const shoveRulesVersion = getShoveRulesVersion();
      const shoveReachFeet = shoveRulesVersion === "modern" ? 5 : getLegacyShoveReachFeet(actor);
      if (!isTokenWithinFeet(token, targetToken, shoveReachFeet)) {
        ui.notifications.warn(game.i18n.localize(shoveRulesVersion === "modern"
          ? "ACTION_HUD.shoveTargetOutOfRange"
          : "ACTION_HUD.shoveTargetOutOfReach"));
        return;
      }
      if (!canShoveTargetBySize(actor, targetToken.actor)) {
        ui.notifications.warn(game.i18n.localize("ACTION_HUD.shoveTargetTooLarge")); return;
      }
      const outcome = await chooseShoveOutcomeDialog(targetToken, shoveRulesVersion);
      if (!outcome) return;

      const outcomeLabel = game.i18n.localize(outcome === "push" ? "ACTION_HUD.shoveOutcomePush" : "ACTION_HUD.shoveOutcomeProne");
      const targetName = targetToken.name ?? targetToken.actor.name;
      const sourceName = token.name ?? actor.name;
      let saveDC = null;
      let abilityUsed = "str";

      if (shoveRulesVersion === "modern") {
        // 2024 Shove is an Unarmed Strike option resolved by the target's Strength or Dexterity save.
        // Martial Arts lets a modern Monk use Dexterity instead of Strength for this DC.
        const shoveSave = calculateShoveSaveDC(actor);
        abilityUsed = shoveSave.ability;
        saveDC = shoveSave.dc;
        const requestMessageId = foundry.utils.randomID();
        const request = {
          rulesVersion: "modern",
          sourceActorUuid: actor.uuid,
          sourceTokenUuid: token.document.uuid,
          sourceTokenId: token.document.id,
          targetActorUuid: targetToken.actor.uuid,
          targetTokenUuid: targetToken.document.uuid,
          sceneId: targetToken.document.parent?.id ?? canvas.scene?.id,
          targetTokenId: targetToken.document.id,
          initiatorUserId: game.user.id,
          sourceName,
          targetName,
          outcome,
          outcomeLabel,
          saveDC,
          saveAbility: abilityUsed
        };
        try {
          const dispatch = game.user.isGM
            ? await startModernShoveSaveAsGM(requestMessageId, game.user.id, request)
            : await actionHudSocket?.executeAsGM?.("startModernShoveSaveAsGM", requestMessageId, game.user.id, request);
          if (!dispatch?.accepted) {
            throw new Error(dispatch?.reason ?? "The GM did not accept the 2024 Shove saving throw request.");
          }
        } catch (error) {
          console.error(`${MODULE_ID} | Could not start 2024 Shove saving throw`, error);
          ui.notifications.error(game.i18n.localize("ACTION_HUD.shoveResolutionFailed"));
        }
        return;
      }

      // 2014 Shove: prefer Midi-QoL's contestedRoll API. It routes the two native
      // skill rolls through the relevant clients, which is more reliable when a player
      // initiates the action and avoids the initiator trying to roll for another user.
      const defenderUserId = getShoveDefenseUserId(targetToken.actor, targetToken.document);
      if (!defenderUserId) {
        ui.notifications.warn(game.i18n.localize("ACTION_HUD.shoveNoDefender"));
        return;
      }
      const request = {
        rulesVersion: "legacy",
        sourceActorUuid: actor.uuid,
        sourceTokenUuid: token.document.uuid,
        sourceTokenId: token.document.id,
        targetActorUuid: targetToken.actor.uuid,
        targetTokenUuid: targetToken.document.uuid,
        sceneId: targetToken.document.parent?.id ?? canvas.scene?.id,
        targetTokenId: targetToken.document.id,
        defenderUserId,
        initiatorUserId: game.user.id,
        sourceName,
        targetName,
        outcome,
        outcomeLabel
      };
      // Use an in-memory request ID for coordination. Do not create a temporary chat card.
      const requestMessageId = foundry.utils.randomID();
      pendingShoveRequests.set(requestMessageId, request);
      setTimeout(() => pendingShoveRequests.delete(requestMessageId), 5 * 60 * 1000);

      const midi = globalThis.MidiQOL;
      const midiActive = Boolean(game.modules.get("midi-qol")?.active);
      if (midiActive) {
        // Always hand 2014 Shove to the GM coordinator when Midi-QoL is active.
        // Do NOT test MidiQOL.contestedRoll on the initiating player: Midi-QoL may
        // expose the contest API only on the GM client. Testing it here sent player
        // requests down the legacy fallback path, where the remote defender prompt
        // depended on the initiator's preliminary ownership guess.
        if (game.user.isGM) {
          if (typeof midi?.contestedRoll !== "function") {
            ui.notifications.error(game.i18n.localize("ACTION_HUD.shoveResolutionFailed"));
            console.error(`${MODULE_ID} | Midi-QoL is active but contestedRoll is unavailable on the GM client.`);
            return;
          }
          await runLegacyShoveContest(requestMessageId, { ...request, coordinatorUserId: game.user.id });
        } else {
          const coordinator = [...game.users].find(user => user.isGM && user.active);
          if (!coordinator) {
            ui.notifications.error(game.i18n.localize("ACTION_HUD.shoveNoDefender"));
            return;
          }
          const coordinatorRequest = actionHudSocket?.executeAsGM
            ? actionHudSocket.executeAsGM("startLegacyShoveContestAsGM", requestMessageId, game.user.id, request)
            : Promise.reject(new Error("Socketlib is unavailable"));
          try {
            const result = await coordinatorRequest;
            if (result?.accepted) {
              console.debug(`${MODULE_ID} | Routed player-initiated Shove to GM via Socketlib`, {
                requestMessageId: requestMessageId,
                initiatorUserId: game.user.id,
                coordinatorUserId: coordinator.id,
                preliminaryDefenderUserId: defenderUserId
              });
            } else {
              throw new Error(result?.reason ?? "GM coordinator did not accept the Shove request.");
            }
          } catch (error) {
            console.warn(`${MODULE_ID} | Socketlib GM handoff failed; using module-socket fallback.`, error);
            game.socket.emit(`module.${MODULE_ID}`, {
              type: "shove-start-contest",
              requestMessageId: requestMessageId,
              sourceUserId: game.user.id,
              targetUserId: coordinator.id,
              request
            });
          }
        }
        return;
      }

      // Compatibility fallback for worlds without Midi-QoL or without contestedRoll.
      const rolls = await actor.rollSkill({ skill: "ath" });
      if (!rolls || rolls === false || (Array.isArray(rolls) && rolls.length === 0)) return;
      const sourceTotal = extractShoveRollTotal(rolls);
      if (!Number.isFinite(sourceTotal)) {
        ui.notifications.warn(game.i18n.localize("ACTION_HUD.shoveSourceRollUnavailable"));
        return;
      }
      request.sourceTotal = sourceTotal;
      pendingShoveRequests.set(requestMessageId, request);
      game.socket.emit(`module.${MODULE_ID}`, { type: "shove-defense-prompt", requestMessageId, targetUserId: defenderUserId, request });
      if (defenderUserId === game.user.id) void promptShoveDefenseForRequest(requestMessageId, request);
    } else if (action === "ready-spell") {
      await applyReadySpellAction(actor);
    } else if (["ready", "search", "dash", "disengage"].includes(action)) {
      const effectInfo = {
        ready: [game.i18n.localize("ACTION_HUD.readyEffect"), "icons/tools/navigation/hourglass.webp"],
        search: [game.i18n.localize("ACTION_HUD.searchEffect"), "icons/tools/scribal/magnifying-glass.webp"],
        dash: [game.i18n.localize("ACTION_HUD.dashEffect"), "icons/skills/movement/figure-running-gray.webp"],
        disengage: [game.i18n.localize("ACTION_HUD.disengageEffect"), "icons/skills/movement/feet-winged-boots-brown.webp"]
      }[action];
      await replaceActorActionEffects(actor, [action]);
      const inCombat = Boolean(game.combat?.started);
      await createActionEffect(actor, {
        name: effectInfo[0], img: effectInfo[1], origin: actor.uuid,
        duration: inCombat ? { rounds: 10 } : { seconds: 3600 },
        changes: [],
        flags: { ...(inCombat ? { dae: { specialDuration: ["turnStart"] } } : {}), [MODULE_ID]: { combatAction: action, sourceActorUuid: actor.uuid } }
      });
    } else if (action === "hide") {
      // Hide is a direct native D&D 5e skill roll; no separate state is needed.
      await actor.rollSkill({ skill: "ste" });
    }
    renderEffectsStrip();
    renderFavorites();
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to apply combat action ${action}`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.combatActionFailed"));
  }
}

function helpTypeForDisposition(targetToken) {
  const disposition = Number(targetToken?.document?.disposition);
  const dispositions = CONST.TOKEN_DISPOSITIONS ?? {};
  if (disposition === Number(dispositions.HOSTILE ?? -1)) return "help-attack";
  if (disposition === Number(dispositions.FRIENDLY ?? 1)) return "help-skill";
  // Neutral and Secret targets are ambiguous, so ask which kind of Help is intended.
  return "choose";
}

function chooseHelpTypeDialog(targetToken) {
  const targetName = targetToken?.name ?? targetToken?.actor?.name ?? game.i18n.localize("ACTION_HUD.targetToken");
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; resolve(value); };
    const dialog = new Dialog({
      title: game.i18n.localize("ACTION_HUD.helpChooseTypeTitle"),
      content: `<form class="ahud-action-dialog"><p>${foundry.utils.escapeHTML(game.i18n.format("ACTION_HUD.helpChooseTypeDescription", { target: targetName }))}</p></form>`,
      classes: ["ahud-dialog-window"],
      buttons: {
        attack: { label: game.i18n.localize("ACTION_HUD.helpAttack"), callback: () => finish("help-attack") },
        skill: { label: game.i18n.localize("ACTION_HUD.helpSkill"), callback: () => finish("help-skill") },
        cancel: { label: game.i18n.localize("ACTION_HUD.cancel"), callback: () => finish(null) }
      },
      default: "cancel",
      close: () => { hudDialogs.delete(dialog); finish(null); },
      render: html => html?.[0]?.closest?.(".app.window-app")?.classList.add("ahud-dialog-window")
    });
    hudDialogs.add(dialog); dialog.render(true);
  });
}

function chooseShoveOutcomeDialog(targetToken, rulesVersion = getShoveRulesVersion()) {
  const targetName = targetToken?.name ?? targetToken?.actor?.name ?? game.i18n.localize("ACTION_HUD.targetToken");
  const promptKey = rulesVersion === "modern" ? "ACTION_HUD.shoveOutcomePrompt2024" : "ACTION_HUD.shoveOutcomePrompt2014";
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; resolve(value); };
    const dialog = new Dialog({
      title: game.i18n.localize("ACTION_HUD.shoveOutcomeTitle"),
      content: `<form class="ahud-action-dialog"><p>${foundry.utils.escapeHTML(game.i18n.format(promptKey, { target: targetName }))}</p></form>`,
      classes: ["ahud-dialog-window"],
      buttons: {
        push: { label: game.i18n.localize("ACTION_HUD.shovePush"), callback: () => finish("push") },
        prone: { label: game.i18n.localize("ACTION_HUD.shoveProne"), callback: () => finish("prone") },
        cancel: { label: game.i18n.localize("ACTION_HUD.cancel"), callback: () => finish(null) }
      },
      default: "cancel",
      close: () => { hudDialogs.delete(dialog); finish(null); },
      render: html => html?.[0]?.closest?.(".app.window-app")?.classList.add("ahud-dialog-window")
    });
    hudDialogs.add(dialog); dialog.render(true);
  });
}

function registerShoveDefenseSocket() {
  // Midi-QoL requires Socketlib in this environment. Use a real targeted RPC for the
  // cross-client prompt and player -> GM handoff; keep the module socket as a fallback
  // for worlds without Socketlib and for short-lived roll-context broadcasts.
  if (globalThis.socketlib?.registerModule) {
    try {
      actionHudSocket = globalThis.socketlib.registerModule(MODULE_ID);
      actionHudSocket.register("startLegacyShoveContestAsGM", startLegacyShoveContestAsGM);
      actionHudSocket.register("openShoveDefenseChoicePrompt", openShoveDefenseChoicePromptViaSocketlib);
      actionHudSocket.register("submitShoveDefenseChoiceAsGM", submitShoveDefenseChoiceAsGM);
      actionHudSocket.register("startModernShoveSaveAsGM", startModernShoveSaveAsGM);
      actionHudSocket.register("openModernShoveSavePrompt", openModernShoveSavePrompt);
      actionHudSocket.register("submitModernShoveSaveAsGM", submitModernShoveSaveAsGM);
      actionHudSocket.register("startLegacyGrappleAsGM", startLegacyGrappleAsGM);
      actionHudSocket.register("startModernGrappleAsGM", startModernGrappleAsGM);
      actionHudSocket.register("openGrappleChoicePrompt", openGrappleChoicePrompt);
      actionHudSocket.register("submitGrappleChoiceAsGM", submitGrappleChoiceAsGM);
      actionHudSocket.register("relayRideableGrappleRequest", relayRideableGrappleRequest);
      actionHudSocket.register("endGrappleLinkAsGM", endGrappleLinkAsGM);
    } catch (error) {
      actionHudSocket = null;
      console.warn(`${MODULE_ID} | Could not register Action HUD Socketlib handlers; falling back to module sockets.`, error);
    }
  }

  // The normal fallback prompt, Midi-QoL's remote ability-choice prompt, and result
  // application also use targeted module-socket events so they work with Chat closed.
  game.socket.on(`module.${MODULE_ID}`, payload => {
    if (!payload?.type || !payload.requestMessageId) return;

    if (payload.type === "modern-shove-save-prompt") {
      if (payload.targetUserId === game.user.id) {
        const accepted = openModernShoveSavePrompt(payload);
        if (!accepted?.accepted) {
          game.socket.emit(`module.${MODULE_ID}`, {
            type: "modern-shove-save-error",
            requestMessageId: payload.requestMessageId,
            sourceUserId: payload.coordinatorUserId,
            targetUserId: game.user.id,
            error: accepted?.reason ?? "The defender client rejected the Shove save prompt."
          });
        }
      }
      return;
    }

    if (payload.type === "modern-shove-save-response") {
      if (!game.user.isGM || payload.coordinatorUserId !== game.user.id) return;
      void submitModernShoveSaveAsGM(payload.requestMessageId, payload.targetUserId, payload.ability, payload.total);
      return;
    }

    if (payload.type === "modern-shove-save-error") {
      if (!game.user.isGM || payload.sourceUserId !== game.user.id) return;
      console.error(`${MODULE_ID} | Remote 2024 Shove save failed`, payload.error);
      ui.notifications.error(game.i18n.localize("ACTION_HUD.shoveResolutionFailed"));
      pendingShoveRequests.delete(payload.requestMessageId);
      clearShoveRollContexts(payload.requestMessageId);
      game.socket.emit(`module.${MODULE_ID}`, { type: "shove-roll-context-clear", requestMessageId: payload.requestMessageId });
      return;
    }

    if (payload.type === "shove-start-contest") {
      if (!game.user.isGM || payload.targetUserId !== game.user.id) return;
      if (!payload.request || payload.sourceUserId !== payload.request.initiatorUserId) {
        console.warn(`${MODULE_ID} | Rejected player-initiated Shove coordinator request`, {
          requestMessageId: payload.requestMessageId,
          sourceUserId: payload.sourceUserId,
          initiatorUserId: payload.request?.initiatorUserId,
          targetUserId: payload.targetUserId
        });
        return;
      }
      const routedRequest = { ...payload.request, coordinatorUserId: game.user.id };
      pendingShoveRequests.set(payload.requestMessageId, routedRequest);
      console.debug(`${MODULE_ID} | Accepted player-initiated Shove coordinator request`, {
        requestMessageId: payload.requestMessageId,
        sourceUserId: payload.sourceUserId,
        targetActorUuid: payload.request.targetActorUuid,
        targetName: payload.request.targetName
      });
      void runLegacyShoveContest(payload.requestMessageId, routedRequest);
      return;
    }

    if (payload.type === "shove-defense-prompt") {
      if (payload.targetUserId === game.user.id) void promptShoveDefenseForRequest(payload.requestMessageId, payload.request);
      return;
    }

    if (payload.type === "shove-defense-choice-prompt") {
      if (payload.targetUserId === game.user.id) {
        console.debug(`${MODULE_ID} | Received Shove defense-choice prompt`, {
          requestMessageId: payload.requestMessageId,
          sourceUserId: payload.sourceUserId,
          targetUserId: payload.targetUserId,
          actorUuid: payload.request?.targetActorUuid,
          targetName: payload.request?.targetName
        });
        void promptShoveDefenseChoiceForRequest(
          payload.requestMessageId,
          payload.sourceUserId,
          payload.request,
          payload.targetUserId
        );
      }
      return;
    }

    if (payload.type === "shove-defense-choice-status") {
      if (payload.sourceUserId !== game.user.id) return;
      const pending = pendingShoveSkillChoiceRequests.get(payload.requestMessageId);
      if (!pending || pending.targetUserId !== payload.targetUserId) return;
      if (payload.accepted) {
        pending.promptAcknowledged = true;
        return;
      }
      clearTimeout(pending.timer);
      pendingShoveSkillChoiceRequests.delete(payload.requestMessageId);
      ui.notifications.warn(`Shove defense prompt rejected: ${String(payload.reason ?? "unknown reason")}`);
      pending.resolve(null);
      return;
    }

    if (payload.type === "shove-roll-contexts") {
      // Contexts are deliberately broadcast to every connected client. Midi-QoL chooses
      // the rolling user internally via playerForActor; duplicating that ownership logic
      // here caused false negatives and aborted the contest before it could start.
      for (const entry of payload.contexts ?? []) {
        if (entry?.actorUuid && entry?.skill) {
          registerLocalShoveRollContext(payload.requestMessageId, entry.actorUuid, entry.skill, entry);
        }
      }
      return;
    }

    if (payload.type === "shove-roll-context-clear") {
      clearShoveRollContexts(payload.requestMessageId);
      return;
    }

    if (payload.type === "shove-defense-choice-response") {
      if (payload.sourceUserId !== game.user.id) return;
      const pending = pendingShoveSkillChoiceRequests.get(payload.requestMessageId);
      // The GM may be coordinating a player's Shove, so the chat message's initiator
      // is not necessarily the client waiting for this response. Validate against the
      // specific pending socket request rather than the replicated ChatMessage cache.
      if (!pending || pending.sourceUserId !== payload.sourceUserId || pending.targetUserId !== payload.targetUserId) return;
      clearTimeout(pending.timer);
      pendingShoveSkillChoiceRequests.delete(payload.requestMessageId);
      pending.resolve(payload.skill === "ath" || payload.skill === "acr" ? payload.skill : null);
      return;
    }

    if (payload.type === "shove-apply-outcome") {
      if (payload.targetUserId === game.user.id) void applyShoveOutcomeForRemoteRequest(payload);
      return;
    }

    if (payload.type === "shove-apply-outcome-response") {
      if (payload.sourceUserId !== game.user.id) return;
      const pending = pendingShoveOutcomeApplicationRequests.get(payload.requestMessageId);
      if (!pending || pending.targetUserId !== payload.targetUserId) return;
      clearTimeout(pending.timer);
      pendingShoveOutcomeApplicationRequests.delete(payload.requestMessageId);
      pending.resolve({ applied: Boolean(payload.applied), error: payload.error ?? "" });
    }
  });
}

async function startModernShoveSaveAsGM(requestMessageId, sourceUserId, rawRequest) {
  if (!game.user.isGM) return { accepted: false, reason: "Only a GM may coordinate a 2024 Shove save." };
  if (!requestMessageId || rawRequest?.rulesVersion !== "modern") {
    return { accepted: false, reason: "Invalid 2024 Shove request." };
  }
  const sourceUser = game.users.get(sourceUserId);
  if (!sourceUser?.active || sourceUserId !== rawRequest.initiatorUserId) {
    return { accepted: false, reason: "The initiating user is not active or does not match the request." };
  }

  try {
    const scene = game.scenes.get(rawRequest.sceneId);
    const sourceDocument = (await fromUuid(rawRequest.sourceTokenUuid))
      ?? scene?.tokens?.get(String(rawRequest.sourceTokenId ?? ""));
    const targetDocument = (await fromUuid(rawRequest.targetTokenUuid))
      ?? scene?.tokens?.get(String(rawRequest.targetTokenId ?? ""));
    const sourceActor = sourceDocument?.actor ?? (await fromUuid(rawRequest.sourceActorUuid));
    const targetActor = targetDocument?.actor ?? (await fromUuid(rawRequest.targetActorUuid));
    if (!sourceDocument || !targetDocument || !sourceActor || !targetActor) {
      throw new Error("Could not resolve the source or target token for the 2024 Shove.");
    }
    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? "OWNER";
    const sourceOwnsActor = sourceActor.testUserPermission?.(sourceUser, ownerLevel) === true;
    const sourceOwnsToken = sourceDocument.testUserPermission?.(sourceUser, ownerLevel) === true;
    if (!sourceUser.isGM && !sourceOwnsActor && !sourceOwnsToken) {
      throw new Error("The initiating player does not own the Shove source actor or token.");
    }

    // Recalculate on the GM client so the save DC and Monk's Martial Arts substitution
    // use the authoritative source actor data.
    const shoveSave = calculateShoveSaveDC(sourceActor);
    const request = {
      ...rawRequest,
      coordinatorUserId: game.user.id,
      defenderUserId: getShoveDefenseUserId(targetActor, targetDocument),
      saveDC: shoveSave.dc,
      saveAbility: shoveSave.ability,
      targetActorType: targetActor.type
    };
    if (!request.defenderUserId) throw new Error("No active controller is available for the Shove target.");
    pendingShoveRequests.set(requestMessageId, request);
    setTimeout(() => {
      pendingShoveRequests.delete(requestMessageId);
      clearShoveRollContexts(requestMessageId);
    }, 5 * 60 * 1000);

    const promptPayload = { requestMessageId, coordinatorUserId: game.user.id, targetUserId: request.defenderUserId, request };
    if (request.defenderUserId === game.user.id) {
      const result = openModernShoveSavePrompt(promptPayload);
      if (!result?.accepted) throw new Error(result?.reason ?? "Could not open the local Shove save prompt.");
    } else if (actionHudSocket?.executeAsUser) {
      try {
        const result = await actionHudSocket.executeAsUser("openModernShoveSavePrompt", request.defenderUserId, promptPayload);
        if (!result?.accepted) throw new Error(result?.reason ?? "The defender client rejected the prompt.");
      } catch (socketError) {
        console.warn(`${MODULE_ID} | Socketlib could not open the 2024 Shove save prompt; trying module socket fallback.`, socketError);
        game.socket.emit(`module.${MODULE_ID}`, {
          type: "modern-shove-save-prompt",
          requestMessageId,
          coordinatorUserId: game.user.id,
          targetUserId: request.defenderUserId,
          request
        });
      }
    } else {
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "modern-shove-save-prompt",
        requestMessageId,
        coordinatorUserId: game.user.id,
        targetUserId: request.defenderUserId,
        request
      });
    }

    console.debug(`${MODULE_ID} | Started 2024 Shove saving throw`, {
      requestMessageId,
      initiatorUserId: sourceUserId,
      coordinatorUserId: game.user.id,
      defenderUserId: request.defenderUserId,
      targetActorUuid: targetActor.uuid,
      saveDC: request.saveDC,
      outcome: request.outcome
    });
    return { accepted: true };
  } catch (error) {
    pendingShoveRequests.delete(requestMessageId);
    console.error(`${MODULE_ID} | Could not coordinate 2024 Shove save`, error);
    return { accepted: false, reason: error?.message ?? String(error) };
  }
}

function openModernShoveSavePrompt(payload) {
  if (!payload?.requestMessageId || payload.targetUserId !== game.user.id) {
    return { accepted: false, reason: "The 2024 Shove save prompt was delivered to the wrong client." };
  }
  const coordinator = game.users.get(payload.coordinatorUserId);
  if (!coordinator?.active || !coordinator.isGM || payload.request?.coordinatorUserId !== coordinator.id) {
    return { accepted: false, reason: "The 2024 Shove save prompt did not come from the active GM coordinator." };
  }
  if (payload.request?.rulesVersion !== "modern" || payload.request?.defenderUserId !== game.user.id) {
    return { accepted: false, reason: "The 2024 Shove save request is invalid for this client." };
  }

  // Return immediately to Socketlib. The roll itself and result handoff run asynchronously.
  void performModernShoveSavePrompt(payload).catch(error => {
    console.error(`${MODULE_ID} | Could not resolve 2024 Shove saving throw on defender client`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.shoveResolutionFailed"));
    if (game.user.isGM && game.user.id === payload.coordinatorUserId) {
      pendingShoveRequests.delete(payload.requestMessageId);
    } else {
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "modern-shove-save-error",
        requestMessageId: payload.requestMessageId,
        sourceUserId: payload.coordinatorUserId,
        targetUserId: game.user.id,
        error: error?.message ?? String(error)
      });
    }
  });
  return { accepted: true };
}

async function performModernShoveSavePrompt(payload) {
  const request = payload.request;
  const targetDocument = await fromUuid(request.targetTokenUuid);
  const targetActor = targetDocument?.actor ?? (await fromUuid(request.targetActorUuid));
  if (!targetActor || !targetDocument) throw new Error("The target actor or token is unavailable on the defender client.");
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? "OWNER";
  const ownsTargetActor = targetActor.testUserPermission?.(game.user, ownerLevel) === true || targetActor.isOwner;
  const ownsTargetToken = targetDocument.testUserPermission?.(game.user, ownerLevel) === true;
  if (!game.user.isGM && !ownsTargetActor && !ownsTargetToken) {
    throw new Error("This client does not own the Shove target actor or token.");
  }

  const ability = await chooseShoveSaveAbilityDialog(request.targetName, request.saveDC);
  if (ability !== "str" && ability !== "dex") throw new Error("No Strength or Dexterity saving throw was selected.");

  const actorType = targetActor.type ?? request.targetActorType ?? null;
  const contextSkill = `save:${ability}`;
  const context = {
    actorUuid: targetActor.uuid,
    skill: contextSkill,
    actorId: targetActor.id,
    tokenId: targetDocument.id,
    actorType
  };
  // The chat visibility guard runs on whichever client creates the roll card. Register the
  // NPC context locally before dispatch, and broadcast it for safe cross-client ordering.
  registerLocalShoveRollContext(payload.requestMessageId, context.actorUuid, context.skill, context);
  game.socket.emit(`module.${MODULE_ID}`, {
    type: "shove-roll-contexts",
    requestMessageId: payload.requestMessageId,
    initiatorUserId: request.initiatorUserId,
    contexts: [context]
  });

  let rollResult;
  try {
    const midi = globalThis.MidiQOL;
    if (game.modules.get("midi-qol")?.active && typeof midi?.socket === "function") {
      const midiSocket = midi.socket();
      if (!midiSocket?.executeAsUser) throw new Error("Midi-QoL rollAbility SocketLib API is unavailable.");
      rollResult = await midiSocket.executeAsUser("rollAbility", game.user.id, {
        saveDetails: {
          actorUuid: targetActor.uuid,
          advantage: undefined,
          disadvantage: undefined,
          modifierTracker: undefined,
          isFriendly: false,
          isMagicSave: false,
          isConcentrationCheck: undefined,
          rollDC: Number(request.saveDC),
          saveItemUuid: "",
          workflowId: "",
          itemCardUuid: "",
          workflowOptions: {},
          rollType: "save",
          rollAbilities: [ability],
          rollSkills: [],
          rollTools: [],
          itemId: ""
        },
        displayOptions: {
          fastForward: true,
          chatMessage: true,
          ...(actorType === "npc" ? { rollMode: "gmroll" } : {})
        }
      });
    } else {
      // Fallback still invokes the native D&D 5e save; Midi-QoL wraps this method when active.
      rollResult = await targetActor.rollSavingThrow(
        { ability, target: Number(request.saveDC), fastForward: true, midiOptions: { target: Number(request.saveDC) } },
        { configure: false },
        { create: true, ...(actorType === "npc" ? { rollMode: "gmroll" } : {}) }
      );
    }
  } finally {
    clearShoveRollContexts(payload.requestMessageId);
    game.socket.emit(`module.${MODULE_ID}`, { type: "shove-roll-context-clear", requestMessageId: payload.requestMessageId });
  }

  const total = extractShoveRollTotal(rollResult);
  if (!Number.isFinite(total)) throw new Error("Midi-QoL/D&D 5e did not return a numeric Shove saving throw total.");
  const resultPayload = { requestMessageId: payload.requestMessageId, targetUserId: game.user.id, ability, total };
  if (game.user.isGM && game.user.id === payload.coordinatorUserId) {
    const result = await submitModernShoveSaveAsGM(payload.requestMessageId, game.user.id, ability, total);
    if (!result?.accepted) throw new Error(result?.reason ?? "The GM could not resolve the Shove save result.");
  } else if (actionHudSocket?.executeAsGM) {
    const result = await actionHudSocket.executeAsGM("submitModernShoveSaveAsGM", payload.requestMessageId, game.user.id, ability, total);
    if (!result?.accepted) throw new Error(result?.reason ?? "The GM did not accept the Shove save result.");
  } else {
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "modern-shove-save-response",
      coordinatorUserId: payload.coordinatorUserId,
      ...resultPayload
    });
  }
}

function chooseShoveSaveAbilityDialog(targetName, dc) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; resolve(value); };
    const dialog = new Dialog({
      title: game.i18n.localize("ACTION_HUD.shoveSaveTitle2024"),
      content: `<form class="ahud-action-dialog"><p>${foundry.utils.escapeHTML(game.i18n.format("ACTION_HUD.shoveSavePrompt2024", { target: targetName ?? game.i18n.localize("ACTION_HUD.targetToken"), dc }))}</p></form>`,
      classes: ["ahud-dialog-window"],
      buttons: {
        str: { label: game.i18n.localize("ACTION_HUD.shoveSaveStrength2024"), callback: () => finish("str") },
        dex: { label: game.i18n.localize("ACTION_HUD.shoveSaveDexterity2024"), callback: () => finish("dex") }
      },
      default: "str",
      close: () => { hudDialogs.delete(dialog); finish("str"); },
      render: html => html?.[0]?.closest?.(".app.window-app")?.classList.add("ahud-dialog-window")
    });
    hudDialogs.add(dialog);
    dialog.render(true);
  });
}

async function submitModernShoveSaveAsGM(requestMessageId, targetUserId, ability, rawTotal) {
  if (!game.user.isGM) return { accepted: false, reason: "Only a GM may resolve the 2024 Shove result." };
  const request = pendingShoveRequests.get(requestMessageId);
  if (!request || request.rulesVersion !== "modern") return { accepted: false, reason: "The 2024 Shove request is no longer pending." };
  if (request.defenderUserId !== targetUserId) return { accepted: false, reason: "The saving throw came from an unexpected user." };
  if (ability !== "str" && ability !== "dex") return { accepted: false, reason: "The defender selected an invalid saving throw." };
  const saveTotal = Number(rawTotal);
  const saveDC = Number(request.saveDC);
  if (!Number.isFinite(saveTotal) || !Number.isFinite(saveDC)) return { accepted: false, reason: "The saving throw total or DC is invalid." };

  // A failed save means the Shove succeeds. Saving throws meet or beat their DC to succeed.
  const shoveSucceeded = saveTotal < saveDC;
  let applied = false;
  let applyError = "";
  if (shoveSucceeded) {
    try {
      const result = await applyShoveOutcomeFromRequest(request);
      applied = Boolean(result?.applied);
      applyError = result?.error ?? "";
    } catch (error) {
      applyError = error?.message ?? String(error);
      console.error(`${MODULE_ID} | Could not apply 2024 Shove outcome`, error);
    }
  }

  const sourceActor = (await fromUuid(request.sourceActorUuid).catch(() => null));
  const sourceTokenDocument = (await fromUuid(request.sourceTokenUuid).catch(() => null));
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: sourceActor, token: sourceTokenDocument }),
    content: buildShoveResultContent(shoveSucceeded),
    flags: {
      [MODULE_ID]: {
        combatAction: "shove",
        shoveResolutionFor: requestMessageId,
        shoveResolution: {
          rulesVersion: "modern",
          saveAbility: ability,
          saveTotal,
          saveDC,
          shoveSucceeded,
          outcome: request.outcome,
          applied
        }
      }
    }
  });

  if (shoveSucceeded && !applied) {
    console.warn(`${MODULE_ID} | 2024 Shove succeeded but outcome application was not confirmed.`, applyError || game.i18n.localize("ACTION_HUD.shoveApplyManually"));
  }
  pendingShoveRequests.delete(requestMessageId);
  clearShoveRollContexts(requestMessageId);
  game.socket.emit(`module.${MODULE_ID}`, { type: "shove-roll-context-clear", requestMessageId });
  console.debug(`${MODULE_ID} | Resolved 2024 Shove saving throw`, { requestMessageId, targetUserId, ability, saveTotal, saveDC, shoveSucceeded, applied });
  return { accepted: true, shoveSucceeded, applied };
}

async function runLegacyShoveContest(requestMessageId, rawRequest) {
  if (!game.user.isGM || !requestMessageId || activeShoveContestRequests.has(requestMessageId)) return;
  activeShoveContestRequests.add(requestMessageId);
  const request = { ...rawRequest, coordinatorUserId: rawRequest?.coordinatorUserId ?? game.user.id };
  pendingShoveRequests.set(requestMessageId, request);
  let defenseSkill = null;
  try {
    if (!request || request.rulesVersion !== "legacy") throw new Error("Invalid 2014 Shove request.");
    const midi = globalThis.MidiQOL;
    if (!game.modules.get("midi-qol")?.active || typeof midi?.contestedRoll !== "function") {
      throw new Error("Midi-QoL contestedRoll is unavailable on the GM client.");
    }

    // Resolve the defender from the GM's authoritative Actor/Token permissions.
    // Permission checks on the initiating player's client may not reflect token-level
    // ownership (or may inherit broad default ownership), routing the prompt incorrectly.
    const sceneForOwner = game.scenes.get(request.sceneId);
    const targetDocForOwner = (await fromUuid(request.targetTokenUuid))
      ?? sceneForOwner?.tokens?.get(String(request.targetTokenId ?? ""));
    const targetActorForOwner = targetDocForOwner?.actor ?? (await fromUuid(request.targetActorUuid));
    if (!targetActorForOwner) throw new Error("Could not resolve the Shove target actor on the GM client.");
    request.defenderUserId = getShoveDefenseUserId(targetActorForOwner, targetDocForOwner);
    request.coordinatorUserId = game.user.id;
    if (!request.defenderUserId) throw new Error("Could not find an active controller for the Shove target.");

    // The GM coordinates the contest. The target owner chooses Athletics/Acrobatics;
    // Midi-QoL then routes the two native rolls to the correct clients.
    defenseSkill = await requestShoveDefenseSkillChoice(
      requestMessageId,
      request.defenderUserId,
      request.targetName,
      request
    );
    if (!defenseSkill) return;

    const scene = game.scenes.get(request.sceneId);
    const sourceDocument = (await fromUuid(request.sourceTokenUuid))
      ?? scene?.tokens?.get(String(request.sourceTokenId ?? ""));
    const targetDocument = (await fromUuid(request.targetTokenUuid))
      ?? scene?.tokens?.get(String(request.targetTokenId ?? ""));
    const sourceToken = sourceDocument?.object
      ?? (canvas.scene?.id === scene?.id ? canvas.tokens.get(String(request.sourceTokenId ?? "")) : null);
    const targetToken = targetDocument?.object
      ?? (canvas.scene?.id === scene?.id ? canvas.tokens.get(String(request.targetTokenId ?? "")) : null);
    if (!sourceToken || !targetToken) {
      throw new Error(`Shove tokens are not placeable on the GM canvas (source=${Boolean(sourceToken)}, target=${Boolean(targetToken)}, scene=${scene?.id ?? "?"}).`);
    }

    await prepareShoveRollContexts(requestMessageId, request, defenseSkill);
    let contest;
    // NPC roll visibility is enforced by a context-aware preCreateChatMessage hook
    // on every client, including whichever client Midi-QoL selects to execute each roll.
    try {
      contest = await midi.contestedRoll({
        source: {
          token: sourceToken, rollType: "skill", ability: "Athletics",
          rollOptions: { fastForward: true, chatMessage: true }
        },
        target: {
          token: targetToken, rollType: "skill", ability: defenseSkill === "ath" ? "Athletics" : "Acrobatics",
          rollOptions: { fastForward: true, chatMessage: true }
        },
        // Only Action HUD's concise Success/Fail message should remain in chat.
        displayResults: false,
        flavor: game.i18n.localize("ACTION_HUD.shove"),
        rollOptions: { fastForward: true, chatMessage: true }
      });
    } finally {
      clearShoveRollContexts(requestMessageId);
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "shove-roll-context-clear", requestMessageId,
        initiatorUserId: request.initiatorUserId
      });
    }

    if (!contest) throw new Error("Midi-QoL returned no result for the contested Shove.");
    const contestRolls = Array.isArray(contest.rolls) ? contest.rolls : [];
    const sourceTotal = extractShoveRollTotal(contestRolls[0]);
    const targetTotal = extractShoveRollTotal(contestRolls[1]);
    const delta = Number(contest.result);
    const success = Number.isFinite(delta)
      ? delta > 0
      : Number.isFinite(sourceTotal) && Number.isFinite(targetTotal) && sourceTotal > targetTotal;
    if (!Number.isFinite(delta) && (!Number.isFinite(sourceTotal) || !Number.isFinite(targetTotal))) {
      throw new Error(`Midi-QoL contested Shove returned unrecognized totals (source=${sourceTotal}, target=${targetTotal}).`);
    }

    let applied = false;
    let applyNote = "";
    if (success) {
      try {
        const application = await requestShoveOutcomeApplication(requestMessageId, request);
        applied = Boolean(application?.applied);
        if (!applied) applyNote = application?.error || game.i18n.localize("ACTION_HUD.shoveApplyManually");
      } catch (error) {
        console.error(`${MODULE_ID} | Could not apply Midi-QoL Shove outcome`, error);
        applyNote = game.i18n.localize("ACTION_HUD.shoveApplyManually");
      }
    }

    if (success && !applied) {
      console.warn(`${MODULE_ID} | Shove contest succeeded, but its outcome was not confirmed as applied.`, applyNote || "No outcome-application confirmation was returned.");
    }
    const resultContent = buildShoveResultContent(success);
    const resultFlags = {
      combatAction: "shove",
      shoveResolutionFor: requestMessageId,
      shoveResolution: { sourceTotal, targetTotal, delta, skill: defenseSkill, success, outcome: request.outcome, applied, rulesVersion: "legacy", midiQol: true, coordinatedByGM: true }
    };
    // No pending chat card is ever created; the only Shove message is the final result.
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: sourceToken.actor, token: sourceToken.document }),
      content: resultContent,
      flags: { [MODULE_ID]: resultFlags }
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to resolve 2014 Shove contest as GM`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.shoveResolutionFailed"));
    // Errors are reported through the notification and console only; don't clutter chat.
  } finally {
    clearShoveRollContexts(requestMessageId);
    activeShoveContestRequests.delete(requestMessageId);
    pendingShoveRequests.delete(requestMessageId);
  }
}

function shoveRollContextKey(actorUuid, skill) {
  return `${actorUuid}::${skill}`;
}

function registerLocalShoveRollContext(requestMessageId, actorUuid, skill, metadata = {}) {
  const key = shoveRollContextKey(actorUuid, skill);
  const context = {
    requestMessageId, actorUuid, skill,
    actorId: metadata.actorId ?? null,
    tokenId: metadata.tokenId ?? null,
    actorType: metadata.actorType ?? null,
    expiresAt: Date.now() + 60000
  };
  shoveRollContexts.set(key, context);
  setTimeout(() => {
    if (shoveRollContexts.get(key) === context) shoveRollContexts.delete(key);
  }, 61000);
}

function clearShoveRollContexts(requestMessageId) {
  for (const [key, context] of shoveRollContexts) {
    if (context.requestMessageId === requestMessageId) shoveRollContexts.delete(key);
  }
}

async function prepareShoveRollContexts(requestMessageId, request, defenseSkill) {
  const sourceTokenDoc = request.sourceTokenUuid ? await fromUuid(request.sourceTokenUuid).catch(() => null) : null;
  const targetTokenDoc = request.targetTokenUuid ? await fromUuid(request.targetTokenUuid).catch(() => null) : null;
  const sourceActor = sourceTokenDoc?.actor ?? (request.sourceActorUuid ? await fromUuid(request.sourceActorUuid).catch(() => null) : null);
  const targetActor = targetTokenDoc?.actor ?? (request.targetActorUuid ? await fromUuid(request.targetActorUuid).catch(() => null) : null);
  const contexts = [
    {
      actorUuid: request.sourceActorUuid, skill: "ath",
      actorId: sourceActor?.id ?? null, tokenId: sourceTokenDoc?.id ?? request.sourceTokenId ?? null,
      actorType: sourceActor?.type ?? null
    },
    {
      actorUuid: request.targetActorUuid, skill: defenseSkill,
      actorId: targetActor?.id ?? null, tokenId: targetTokenDoc?.id ?? request.targetTokenId ?? null,
      actorType: targetActor?.type ?? null
    }
  ].filter(entry => entry.actorUuid && entry.skill);
  if (!contexts.length) return false;

  // Register on the coordinating GM and broadcast roll identity/actor type metadata to all
  // clients. The actual NPC chat message must be made private on whichever client Midi-QoL
  // selects to execute the roll, not only on the GM coordinator.
  for (const entry of contexts) {
    registerLocalShoveRollContext(requestMessageId, entry.actorUuid, entry.skill, entry);
  }
  game.socket.emit(`module.${MODULE_ID}`, {
    type: "shove-roll-contexts",
    requestMessageId,
    initiatorUserId: game.user.id,
    contexts
  });

  // Let the module socket event reach the actual rolling clients before Midi-QoL dispatches
  // its socketlib requests. This is a brief setup delay, never an acknowledgement gate.
  await new Promise(resolve => setTimeout(resolve, 350));
  return true;
}

function registerShoveRollFastForwardWrapper() {
  if (!game.modules.get("midi-qol")?.active) return;

  // Midi-QoL 14.6.4 creates each contested roll's chat message on the client selected
  // by its own SocketLib playerFor routing. Apply GM-only visibility at the creation point
  // on every client. ChatMessage.create(..., {messageMode: "publicroll"}) can re-apply the
  // supplied message mode after preCreate hooks, so override both creation data and options.
  Hooks.on("preCreateChatMessage", (message, data, options) => {
    const speaker = data?.speaker ?? message?.speaker ?? message?._source?.speaker;
    if (!speaker) return;
    const actorId = speaker.actor ?? null;
    const tokenId = speaker.token ?? null;
    const contexts = [...shoveRollContexts.values()].filter(context => context.expiresAt > Date.now() && context.actorType === "npc");
    const matchingContext = contexts.find(context =>
      (context.actorId && actorId === context.actorId) ||
      (context.tokenId && tokenId === context.tokenId)
    );
    if (!matchingContext) return;

    const gmIds = game.users.filter(user => user.isGM && user.active).map(user => user.id);
    if (!gmIds.length) return;
    if (data && typeof data === "object") {
      data.whisper = gmIds;
      data.blind = false;
      data.rollMode = "gmroll";
    }
    if (options && typeof options === "object") options.messageMode = "gmroll";
    if (typeof message?.updateSource === "function") {
      message.updateSource({ whisper: gmIds, blind: false, rollMode: "gmroll" });
    }
    console.debug(`${MODULE_ID} | Made active Shove NPC roll GM-only`, {
      requestMessageId: matchingContext.requestMessageId,
      actorId, tokenId, userId: game.user.id
    });
  });
  // Roll Director can pause the native Midi roll before it reaches the system. This hook
  // runs after that prompt is answered, so it is the final, order-independent guard that
  // prevents the normal D&D 5e roll-configuration dialog from appearing a second time.
  Hooks.on("dnd5e.preRollSkill", (rollConfig, dialogConfig) => {
    const marker = rollConfig?.midiOptions?.actionHudShoveFastForwardRequestId;
    const skill = rollConfig?.skill;
    const actorUuid = rollConfig?.subject?.uuid ?? rollConfig?.actor?.uuid;
    const context = actorUuid && skill ? shoveRollContexts.get(shoveRollContextKey(actorUuid, skill)) : null;
    const matchingContext = context
      && context.expiresAt > Date.now()
      && Array.isArray(rollConfig?.midiOptions?.rollSkills)
      && rollConfig.midiOptions.rollSkills.includes(skill)
      && rollConfig.midiOptions.recomputeAdvantage === true
      && !rollConfig.midiOptions.workflowId;
    if (!marker && !matchingContext) return;
    if (marker && context && context.requestMessageId !== marker) return;
    if (dialogConfig) dialogConfig.configure = false;
    rollConfig.fastForward = true;
  });
  if (!globalThis.libWrapper?.register) return;
  try {
    libWrapper.register(MODULE_ID, "CONFIG.Actor.documentClass.prototype.rollSkill", function(wrapped, ...args) {
      const config = args[0] ?? {};
      const skill = config.skill;
      const key = shoveRollContextKey(this.uuid, skill);
      const context = shoveRollContexts.get(key);
      const midiDetails = config.midiOptions;
      const isExpectedMidiContestRoll = context
        && context.expiresAt > Date.now()
        && Array.isArray(midiDetails?.rollSkills)
        && midiDetails.rollSkills.includes(skill)
        && midiDetails.recomputeAdvantage === true
        && !midiDetails.workflowId;
      if (isExpectedMidiContestRoll) {
        // Midi still computes advantage/disadvantage from its roll flags. Attach a
        // short-lived marker so the dnd5e.preRollSkill hook can enforce configure=false
        // after Roll Director has resumed the original native roll, independent of wrapper
        // ordering. Do not consume the context until the actual system roll begins.
        args[0] = {
          ...config,
          fastForward: true,
          midiOptions: { ...midiDetails, actionHudShoveFastForwardRequestId: context.requestMessageId }
        };
        args[1] = { ...(args[1] ?? {}), configure: false };
      }
      return wrapped(...args);
    }, "MIXED");
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not install fast-forward handling for Midi-QoL Shove contests.`, error);
  }
}

function requestShoveDefenseSkillChoice(requestMessageId, targetUserId, targetName, request) {
  if (targetUserId === game.user.id) return chooseShoveDefenseSkillDialog(targetName);

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingShoveSkillChoiceRequests.delete(requestMessageId);
      ui.notifications.warn(game.i18n.localize("ACTION_HUD.shoveDefenseChoiceTimedOut"));
      resolve(null);
    }, 120000);
    const pending = { resolve, timer, targetUserId, sourceUserId: game.user.id, promptAcknowledged: false };
    pendingShoveSkillChoiceRequests.set(requestMessageId, pending);

    const promptPayload = {
      requestMessageId,
      sourceUserId: game.user.id,
      coordinatorUserId: game.user.id,
      targetUserId,
      request: { ...request, coordinatorUserId: game.user.id, defenderUserId: targetUserId }
    };
    const sendModuleSocketFallback = () => {
      // Include the request payload so the receiving client doesn't depend on a ChatMessage
      // replicating before the prompt request arrives.
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "shove-defense-choice-prompt",
        requestMessageId,
        sourceUserId: game.user.id,
        targetUserId,
        request: promptPayload.request
      });
    };

    if (actionHudSocket?.executeAsUser) {
      // Socketlib targets the exact defender client. The remote handler immediately
      // acknowledges that the dialog was opened; its selection is sent back with a second
      // Socketlib call, so we don't keep an RPC open while the player thinks.
      actionHudSocket.executeAsUser("openShoveDefenseChoicePrompt", targetUserId, promptPayload)
        .then(result => {
          if (!result?.accepted && pendingShoveSkillChoiceRequests.has(requestMessageId)) {
            console.warn(`${MODULE_ID} | Socketlib did not open the Shove defense prompt; trying module-socket fallback.`, result);
            sendModuleSocketFallback();
          }
        })
        .catch(error => {
          console.warn(`${MODULE_ID} | Socketlib Shove prompt dispatch failed; trying module-socket fallback.`, error);
          if (pendingShoveSkillChoiceRequests.has(requestMessageId)) sendModuleSocketFallback();
        });
    } else {
      sendModuleSocketFallback();
    }
  });
}

function startLegacyShoveContestAsGM(requestMessageId, sourceUserId, request) {
  if (!game.user.isGM) throw new Error("Only a GM may coordinate a Midi-QoL Shove contest.");
  const sourceUser = game.users.get(sourceUserId);
  if (!sourceUser?.active || sourceUserId !== request?.initiatorUserId) {
    throw new Error("The player-initiated Shove request did not match an active initiating user.");
  }
  pendingShoveRequests.set(requestMessageId, { ...request, coordinatorUserId: game.user.id });
  console.debug(`${MODULE_ID} | Socketlib delivered player Shove request to GM`, {
    requestMessageId, sourceUserId, targetActorUuid: request?.targetActorUuid
  });
  void runLegacyShoveContest(requestMessageId, { ...request, coordinatorUserId: game.user.id });
  return { accepted: true };
}

function openShoveDefenseChoicePromptViaSocketlib(payload) {
  const coordinator = game.users.get(payload?.coordinatorUserId);
  if (!payload?.requestMessageId || payload.targetUserId !== game.user.id) {
    throw new Error("The Shove defense prompt was delivered to the wrong client.");
  }
  if (!coordinator?.active || !coordinator.isGM || payload.request?.coordinatorUserId !== coordinator.id) {
    throw new Error("The Shove defense prompt did not come from the active GM coordinator.");
  }
  if (payload.request?.rulesVersion !== "legacy") {
    throw new Error("The Shove defense prompt does not contain a valid 2014 Shove request.");
  }

  // Don't await the user's decision in the Socketlib RPC. Return an acknowledgement now;
  // when the defender chooses, send the response back to the GM in a separate targeted RPC.
  void chooseShoveDefenseSkillDialog(payload.request.targetName)
    .then(async skill => {
      const selectedSkill = skill === "ath" || skill === "acr" ? skill : null;
      if (actionHudSocket?.executeAsGM) {
        const result = await actionHudSocket.executeAsGM(
          "submitShoveDefenseChoiceAsGM",
          payload.requestMessageId,
          game.user.id,
          selectedSkill,
          payload.coordinatorUserId
        );
        if (result?.accepted) return;
        throw new Error(result?.reason ?? "The GM coordinator did not accept the defense choice.");
      }
      throw new Error("Socketlib is unavailable on the defender client.");
    })
    .catch(error => {
      console.error(`${MODULE_ID} | Could not return remote Shove defense choice to GM`, error);
      // Keep the module-socket reply as a fallback if Socketlib was interrupted after the
      // dialog had been displayed. The coordinator ignores duplicate/late replies safely.
      game.socket.emit(`module.${MODULE_ID}`, {
        type: "shove-defense-choice-response",
        requestMessageId: payload.requestMessageId,
        sourceUserId: payload.coordinatorUserId,
        targetUserId: game.user.id,
        skill: null
      });
    });

  console.debug(`${MODULE_ID} | Opened Shove defense choice on target controller`, {
    requestMessageId: payload.requestMessageId,
    coordinatorUserId: payload.coordinatorUserId,
    targetUserId: game.user.id,
    targetName: payload.request.targetName
  });
  return { accepted: true };
}

function submitShoveDefenseChoiceAsGM(requestMessageId, targetUserId, skill, coordinatorUserId) {
  if (!game.user.isGM || coordinatorUserId !== game.user.id) return { accepted: false };
  const pending = pendingShoveSkillChoiceRequests.get(requestMessageId);
  if (!pending || pending.sourceUserId !== game.user.id) return { accepted: false, reason: "no pending contest" };
  if (pending.targetUserId !== targetUserId) return { accepted: false, reason: "unexpected defender user" };
  clearTimeout(pending.timer);
  pendingShoveSkillChoiceRequests.delete(requestMessageId);
  pending.resolve(skill === "ath" || skill === "acr" ? skill : null);
  return { accepted: true };
}

async function promptShoveDefenseChoiceForRequest(requestMessageId, sourceUserId, requestPayload = null, targetedUserId = null) {
  const sendStatus = (accepted, reason = "") => game.socket.emit(`module.${MODULE_ID}`, {
    type: "shove-defense-choice-status",
    requestMessageId,
    sourceUserId,
    targetUserId: game.user.id,
    accepted,
    reason
  });

  let request = requestPayload;
  if (!request) {
    let requestMessage = game.messages.get(requestMessageId);
    for (let attempt = 0; !requestMessage && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      requestMessage = game.messages.get(requestMessageId);
    }
    request = requestMessage?.getFlag?.(MODULE_ID, "shoveRequest");
  }

  // The socket's targetUserId is authoritative for this targeted event. The replicated
  // chat flag may still contain the initiator client's preliminary owner guess, so a stale
  // defenderUserId must not silently discard a prompt sent to this client by the coordinator.
  if (targetedUserId && targetedUserId !== game.user.id) return;
  if (!request || request.rulesVersion !== "legacy") {
    sendStatus(false, "The Shove request was missing or was not a 2014 Shove.");
    console.warn(`${MODULE_ID} | Rejected Shove defense prompt: missing/invalid request`, { requestMessageId, sourceUserId });
    return;
  }

  const sourceUser = game.users.get(sourceUserId);
  const coordinatorUserId = request.coordinatorUserId;
  const validCoordinator = Boolean(sourceUser?.active && (
    sourceUser.isGM || sourceUserId === request.initiatorUserId
  ) && (!coordinatorUserId || coordinatorUserId === sourceUserId || sourceUser.isGM));
  if (!validCoordinator) {
    sendStatus(false, "The Shove defense prompt did not come from an active initiator or GM coordinator.");
    console.warn(`${MODULE_ID} | Rejected Shove defense prompt: invalid coordinator`, {
      requestMessageId, sourceUserId, coordinatorUserId, active: sourceUser?.active, isGM: sourceUser?.isGM
    });
    return;
  }

  if (request.defenderUserId && request.defenderUserId !== game.user.id) {
    console.warn(`${MODULE_ID} | Shove prompt target differed from cached request defender; honoring the targeted socket recipient`, {
      requestMessageId, cachedDefenderUserId: request.defenderUserId, recipientUserId: game.user.id
    });
  }
  sendStatus(true);
  try {
    const skill = await chooseShoveDefenseSkillDialog(request.targetName);
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "shove-defense-choice-response",
      requestMessageId,
      sourceUserId,
      targetUserId: game.user.id,
      skill: skill === "ath" || skill === "acr" ? skill : null
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Could not open Shove defense choice dialog`, error);
    sendStatus(false, error?.message ?? String(error));
  }
}

async function requestShoveOutcomeApplication(requestMessageId, request) {
  // The 2014 contest is coordinated by a GM, which has authority to apply the outcome.
  // Keep the target-owner socket fallback for legacy callers without a GM coordinator.
  if (game.user.isGM || request.defenderUserId === game.user.id) {
    return applyShoveOutcomeFromRequest(request);
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingShoveOutcomeApplicationRequests.delete(requestMessageId);
      resolve({ applied: false, error: game.i18n.localize("ACTION_HUD.shoveApplyManually") });
    }, 30000);
    pendingShoveOutcomeApplicationRequests.set(requestMessageId, { resolve, timer, targetUserId: request.defenderUserId });
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "shove-apply-outcome",
      requestMessageId,
      sourceUserId: game.user.id,
      targetUserId: request.defenderUserId,
      request
    });
  });
}

async function applyShoveOutcomeForRemoteRequest(payload) {
  const requestMessageId = payload.requestMessageId;
  let applied = false;
  let errorText = "";
  try {
    let request = payload.request ?? pendingShoveRequests.get(requestMessageId);
    // Older in-flight calls may not include the payload; retain a bounded compatibility fallback.
    if (!request) {
      let requestMessage = game.messages.get(requestMessageId);
      for (let attempt = 0; !requestMessage && attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        requestMessage = game.messages.get(requestMessageId);
      }
      request = requestMessage?.getFlag?.(MODULE_ID, "shoveRequest");
    }
    if (!request || request.initiatorUserId !== payload.sourceUserId || request.defenderUserId !== game.user.id) {
      throw new Error("Shove request validation failed on the target controller.");
    }
    if (processedShoveOutcomeApplications.has(requestMessageId)) {
      applied = true;
    } else {
      const result = await applyShoveOutcomeFromRequest(request);
      applied = Boolean(result?.applied);
      errorText = result?.error ?? "";
      if (applied) processedShoveOutcomeApplications.add(requestMessageId);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Could not apply Shove outcome on target controller`, error);
    errorText = error?.message || game.i18n.localize("ACTION_HUD.shoveApplyManually");
  }
  game.socket.emit(`module.${MODULE_ID}`, {
    type: "shove-apply-outcome-response",
    requestMessageId,
    sourceUserId: payload.sourceUserId,
    targetUserId: game.user.id,
    applied,
    error: errorText
  });
}

async function applyShoveOutcomeFromRequest(request) {
  const scene = game.scenes.get(request.sceneId);
  const sourceTokenDocument = (await fromUuid(request.sourceTokenUuid)) ?? scene?.tokens?.get(String(request.sourceTokenId ?? ""));
  const targetTokenDocument = (await fromUuid(request.targetTokenUuid)) ?? scene?.tokens?.get(request.targetTokenId);
  const targetActor = targetTokenDocument?.actor ?? (await fromUuid(request.targetActorUuid));
  if (!sourceTokenDocument || !targetTokenDocument || !targetActor) throw new Error("Shove source or target token is unavailable.");
  if (request.outcome === "prone") {
    await setConditionState(targetActor, "prone", true);
    return { applied: actorHasCondition(targetActor, "prone") };
  }
  if (request.outcome === "push") {
    await pushTokenAwayFiveFeet(sourceTokenDocument, targetTokenDocument);
    return { applied: true };
  }
  throw new Error(`Unsupported Shove outcome: ${request.outcome}`);
}

async function promptShoveDefenseForRequest(requestMessageId, requestPayload = null) {
  if (!requestMessageId || pendingShoveDefenseRequests.has(requestMessageId) || promptedShoveDefenseRequests.has(requestMessageId)) return;
  pendingShoveDefenseRequests.add(requestMessageId);
  try {
    const request = requestPayload ?? pendingShoveRequests.get(requestMessageId);
    if (!request || request.rulesVersion !== "legacy" || request.defenderUserId !== game.user.id) return;
    promptedShoveDefenseRequests.add(requestMessageId);
    await rollShoveDefenseForRequest(requestMessageId, request);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to open automatic Shove defense prompt`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.shoveResolutionFailed"));
  } finally {
    pendingShoveDefenseRequests.delete(requestMessageId);
  }
}

function getShoveDefenseUserId(targetActor, targetTokenDocument = null) {
  if (!targetActor) return null;
  const activeUsers = [...game.users].filter(user => user.active);
  const playerUsers = activeUsers.filter(user => !user.isGM);
  const ownerLevel = Number(CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);
  const levelFor = (document, user) => {
    const raw = document?.ownership?.[user.id];
    if (raw == null || raw === "") return null;
    if (typeof raw === "string" && raw.toUpperCase() === "OWNER") return ownerLevel;
    const level = Number(raw);
    return Number.isFinite(level) ? level : null;
  };
  const hasOwnerPermission = (document, user) => {
    if (!document) return false;
    try {
      if (document.testUserPermission?.(user, ownerLevel) === true) return true;
      if (document.testUserPermission?.(user, "OWNER") === true) return true;
    } catch (error) {
      // Fall through to explicit ownership checks below; document types differ.
    }
    return false;
  };

  // Foundry's assigned-character link is the strongest signal for an ordinary PC and
  // avoids depending on a client-specific ownership cache or Token ownership inheritance.
  const assignedCharacterOwner = playerUsers.find(user =>
    (Boolean(targetActor.id) && user.character?.id === targetActor.id)
    || (Boolean(targetActor.uuid) && user.character?.uuid === targetActor.uuid)
  );
  if (assignedCharacterOwner) return assignedCharacterOwner.id;

  // Prefer explicit per-user grants, which also support player-controlled NPC/minion tokens.
  const explicitlyOwnedPlayers = playerUsers.filter(user => {
    const actorLevel = levelFor(targetActor, user);
    const tokenLevel = levelFor(targetTokenDocument, user);
    return Math.max(actorLevel ?? -1, tokenLevel ?? -1) >= ownerLevel;
  });
  if (explicitlyOwnedPlayers.length) return explicitlyOwnedPlayers[0].id;

  // Effective ownership on a character handles inherited permissions. Check both Actor
  // and Token because worlds sometimes grant control through a placed token document.
  if (targetActor.type === "character") {
    const effectiveOwner = playerUsers.find(user =>
      hasOwnerPermission(targetActor, user) || hasOwnerPermission(targetTokenDocument, user)
    );
    if (effectiveOwner) return effectiveOwner.id;
  }

  // Don't assign an unowned NPC to an arbitrary player just because its default ownership
  // is broad. Unowned NPCs are adjudicated by the first active GM.
  const activeGM = activeUsers.find(user => user.isGM);
  if (activeGM) return activeGM.id;
  return playerUsers[0]?.id ?? null;
}

async function rollShoveDefenseForRequest(requestMessageId, requestPayload = null) {
  const request = requestPayload ?? pendingShoveRequests.get(requestMessageId);
  if (!request) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.shoveRequestNotFound"));
    return;
  }
  const existingResponse = [...game.messages].find(m => m.getFlag?.(MODULE_ID, "shoveDefenseFor") === requestMessageId);
  if (existingResponse) {
    ui.notifications.info(game.i18n.localize("ACTION_HUD.shoveDefenseAlreadyRolled"));
    return;
  }

  const scene = game.scenes.get(request.sceneId);
  const targetDocument = scene?.tokens?.get(request.targetTokenId);
  const targetToken = canvas.scene?.id === scene?.id
    ? (canvas.tokens.get(request.targetTokenId) ?? targetDocument?.object)
    : targetDocument?.object;
  const targetActor = targetDocument?.actor ?? targetToken?.actor;
  if (!targetActor || !targetDocument) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.shoveTargetUnavailable"));
    return;
  }
  if (!game.user.isGM && !targetActor.isOwner) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.shoveDefenseNotOwner"));
    return;
  }

  const skill = await chooseShoveDefenseSkillDialog(request.targetName);
  if (!skill) return;
  const rolls = await targetActor.rollSkill({ skill });
  if (!rolls || (Array.isArray(rolls) && rolls.length === 0)) return;
  const targetTotal = extractShoveRollTotal(rolls);
  if (!Number.isFinite(targetTotal)) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.shoveTargetRollUnavailable"));
    return;
  }

  // The attacker must beat the target's check; a tie does not succeed.
  const success = Number(request.sourceTotal) > targetTotal;
  let applied = false;
  let applyNote = "";
  if (success) {
    try {
      if (request.outcome === "prone") {
        await setConditionState(targetActor, "prone", true);
        applied = true;
      } else {
        const sourceTokenDocument = (await fromUuid(request.sourceTokenUuid))
          ?? canvas.tokens.get(String(request.sourceTokenUuid ?? "").split(".").pop())?.document;
        await pushTokenAwayFiveFeet(sourceTokenDocument, targetDocument);
        applied = true;
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Could not apply Shove outcome`, error);
      applyNote = game.i18n.localize("ACTION_HUD.shoveApplyManually");
    }
    if (!applied && !applyNote) applyNote = game.i18n.localize("ACTION_HUD.shoveApplyManually");
  }

  if (success && !applied) {
    console.warn(`${MODULE_ID} | Fallback Shove contest succeeded, but its outcome was not confirmed as applied.`, applyNote || "No outcome-application confirmation was returned.");
  }
  const defenseFlags = { sourceTotal: Number(request.sourceTotal), targetTotal, skill, success, outcome: request.outcome, applied };
  const resultContent = buildShoveResultContent(success);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: targetActor, token: targetToken?.document ?? targetDocument }),
    content: resultContent,
    flags: { [MODULE_ID]: { combatAction: "shove", shoveDefenseFor: requestMessageId, shoveDefense: defenseFlags } }
  });
}

function chooseShoveDefenseSkillDialog(targetName) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; resolve(value); };
    const dialog = new Dialog({
      title: game.i18n.localize("ACTION_HUD.shoveDefenseTitle"),
      content: `<form class="ahud-action-dialog"><p>${foundry.utils.escapeHTML(game.i18n.format("ACTION_HUD.shoveDefensePrompt", { target: targetName ?? game.i18n.localize("ACTION_HUD.targetToken") }))}</p></form>`,
      classes: ["ahud-dialog-window"],
      buttons: {
        athletics: { label: game.i18n.localize("ACTION_HUD.shoveDefenseAthletics"), callback: () => finish("ath") },
        acrobatics: { label: game.i18n.localize("ACTION_HUD.shoveDefenseAcrobatics"), callback: () => finish("acr") }
      },
      default: "athletics",
      // The defender cannot cancel the contest by closing the choice dialog. If they
      // dismiss it via the title-bar X or Escape, resolve with Athletics as the default.
      close: () => { hudDialogs.delete(dialog); finish("ath"); },
      render: html => html?.[0]?.closest?.(".app.window-app")?.classList.add("ahud-dialog-window")
    });
    hudDialogs.add(dialog);
    dialog.render(true);
  });
}

function buildShoveResultContent(success) {
  const label = game.i18n.localize(success ? "ACTION_HUD.shoveResultSuccess" : "ACTION_HUD.shoveResultFail");
  return `<div class="ahud-shove-resolution ahud-shove-result ${success ? "is-success" : "is-failure"}"><strong class="ahud-shove-result-label">${foundry.utils.escapeHTML(label)}</strong></div>`;
}

function extractShoveRollTotal(result) {
  const candidates = Array.isArray(result) ? result : [result];
  for (const candidate of candidates) {
    const total = Number(candidate?.total ?? candidate?.roll?.total);
    if (Number.isFinite(total)) return total;
  }
  return null;
}

async function pushTokenAwayFiveFeet(sourceTokenDocument, targetTokenDocument) {
  if (!sourceTokenDocument || !targetTokenDocument) throw new Error("Shove tokens are unavailable.");

  // Use the documents' scene rather than assuming the defender has that scene active.
  const scene = targetTokenDocument.parent ?? sourceTokenDocument.parent ?? canvas.scene;
  const gridData = scene?.grid ?? {};
  const sameCanvasScene = Boolean(canvas.scene?.id && scene?.id && canvas.scene.id === scene.id);
  const gridSize = Number((sameCanvasScene ? canvas.grid?.size : null) ?? gridData.size ?? 100);
  const gridDistance = Number(gridData.distance) || 5;
  const units = String(gridData.units ?? "ft").toLowerCase();
  const distanceInSceneUnits = units.includes("meter") || units === "m" ? 5 * 0.3048
    : units.includes("yard") || units === "yd" ? 5 / 3 : 5;
  const pixelsToMove = gridSize * distanceInSceneUnits / gridDistance;
  const centerOf = doc => ({
    x: Number(doc.x) + Number(doc.width ?? 1) * gridSize / 2,
    y: Number(doc.y) + Number(doc.height ?? 1) * gridSize / 2
  });
  const sourceCenter = centerOf(sourceTokenDocument);
  const targetCenter = centerOf(targetTokenDocument);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const magnitude = Math.hypot(dx, dy);
  if (!magnitude) throw new Error("Cannot determine a direction away from the source token.");

  let moveX;
  let moveY;
  if (gridData.type === CONST.GRID_TYPES?.SQUARE) {
    // On square grids, a 5-foot push moves one cell along each non-zero axis.
    moveX = Math.sign(dx) * (Math.abs(dx) > 0.001 ? pixelsToMove : 0);
    moveY = Math.sign(dy) * (Math.abs(dy) > 0.001 ? pixelsToMove : 0);
  } else {
    moveX = dx / magnitude * pixelsToMove;
    moveY = dy / magnitude * pixelsToMove;
  }

  const oldX = Number(targetTokenDocument.x);
  const oldY = Number(targetTokenDocument.y);
  const widthPx = Number(targetTokenDocument.width ?? 1) * gridSize;
  const heightPx = Number(targetTokenDocument.height ?? 1) * gridSize;
  const newX = Math.round(oldX + moveX);
  const newY = Math.round(oldY + moveY);
  if (!Number.isFinite(newX) || !Number.isFinite(newY) || (newX === oldX && newY === oldY)) {
    throw new Error(`Invalid Shove destination (${newX}, ${newY}) from (${oldX}, ${oldY}).`);
  }

  if (game.modules.get("midi-qol")?.active && typeof globalThis.MidiQOL?.moveToken === "function") {
    // Midi-QoL's helper routes movement through TokenDocument.move() and may resolve
    // before every client observes the updated coordinates. A resolved call is success;
    // checking the local document immediately afterward produced false errors even when
    // the token visibly moved. Pass the desired center as Midi-QoL expects.
    await globalThis.MidiQOL.moveToken(targetTokenDocument, {
      x: newX + widthPx / 2,
      y: newY + heightPx / 2
    }, { autoRotate: false });
    return;
  }

  // Without Midi-QoL, the awaited document update is the authoritative operation.
  await targetTokenDocument.update({ x: newX, y: newY });
}

// Grapple automation uses Midi-QoL for rolls, SocketLib for cross-client prompts,
// and Rideable's native grapple/rider flags for canvas linking and follow movement.
async function handleGrappleAction(token, actor) {
  const rulesVersion = getShoveRulesVersion();
  const currentLink = getGrappleLinkForToken(token.document);
  if (currentLink) {
    await startGrappleEscape(token, actor, currentLink, rulesVersion);
    return;
  }

  const targetToken = getSingleTargetedToken(token, "grapple");
  if (!targetToken) return;
  if (!game.combat?.started) {
    ui.notifications.info(game.i18n.localize("ACTION_HUD.combatMustBeStarted"));
    return;
  }
  if (!isRideableGrapplingAvailable()) return;
  // Grapple reach is based on the actor's unarmed reach in both rules versions.
  // The D&D 5e system exposes this as attributes.reach when a feature (such as a Bugbear's
  // Long-Limbed trait) modifies it; fall back to the usual 5 feet when it is unavailable.
  const reach = getActorUnarmedReachFeet(actor);
  if (!isTokenWithinFeet(token, targetToken, reach)) {
    ui.notifications.warn(game.i18n.format("ACTION_HUD.grappleOutOfReach", { reach }));
    return;
  }
  if (!canShoveTargetBySize(actor, targetToken.actor)) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.grappleTargetTooLarge"));
    return;
  }
  const rideableFlags = getRideableFlagsApi();
  if (rideableFlags?.isRider?.(targetToken.document)) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.grappleTargetAlreadyLinked"));
    return;
  }
  if (actorHasStatusId(targetToken.actor, "grappled") || getGrappleLinkForToken(targetToken.document)) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.grappleTargetAlreadyGrappled"));
    return;
  }

  const requestId = foundry.utils.randomID();
  const request = {
    rulesVersion,
    mode: "initiate",
    sourceActorUuid: actor.uuid,
    sourceTokenUuid: token.document.uuid,
    sourceTokenId: token.document.id,
    targetActorUuid: targetToken.actor.uuid,
    targetTokenUuid: targetToken.document.uuid,
    targetTokenId: targetToken.document.id,
    sceneId: token.document.parent?.id ?? canvas.scene?.id,
    sourceUserId: game.user.id,
    sourceName: token.name,
    targetName: targetToken.name
  };
  try {
    const result = game.user.isGM
      ? (rulesVersion === "modern"
        ? await startModernGrappleAsGM(requestId, game.user.id, request)
        : await startLegacyGrappleAsGM(requestId, game.user.id, request))
      : await actionHudSocket?.executeAsGM?.(rulesVersion === "modern" ? "startModernGrappleAsGM" : "startLegacyGrappleAsGM", requestId, game.user.id, request);
    if (!result?.accepted) throw new Error(result?.reason ?? "The GM did not accept the Grapple request.");
  } catch (error) {
    console.error(`${MODULE_ID} | Could not start Grapple`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.grappleFailedToStart"));
  }
}

function getRideableFlagsApi() {
  if (!game.modules.get("Rideable")?.active) return null;
  return game.modules.get("Rideable")?.api?.RideableFlags ?? null;
}

function isRideableGrapplingAvailableForGM() {
  const rideable = game.modules.get("Rideable");
  if (!rideable?.active || !rideable.api?.RideableFlags) return false;
  try {
    return game.settings.get("Rideable", "Grappling") === true;
  } catch (error) {
    return false;
  }
}

function isRideableGrapplingAvailable() {
  const rideable = game.modules.get("Rideable");
  if (!rideable?.active || !rideable.api?.RideableFlags) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.grappleRequiresRideable"));
    return false;
  }
  try {
    if (!game.settings.get("Rideable", "Grappling")) {
      ui.notifications.warn(game.i18n.localize("ACTION_HUD.grappleEnableRideable"));
      return false;
    }
  } catch (error) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.grappleEnableRideable"));
    return false;
  }
  if (!actionHudSocket?.executeAsGM || !actionHudSocket?.executeAsUser) {
    ui.notifications.error(game.i18n.localize("ACTION_HUD.grappleSocketUnavailable"));
    return false;
  }
  return true;
}

function getGrappleLinkForToken(tokenDocument) {
  const flags = getRideableFlagsApi();
  const actor = tokenDocument?.actor;
  const activeLinks = (actor?.effects?.contents ?? []).filter(effect =>
    effect.getFlag?.(MODULE_ID, "grappleLinkId") && effect.getFlag?.(MODULE_ID, "grappleRole") === "target"
  );
  const linkEffect = activeLinks[0];
  if (linkEffect) {
    const data = linkEffect.getFlag(MODULE_ID, "grappleLinkData") ?? {};
    return {
      linkId: linkEffect.getFlag(MODULE_ID, "grappleLinkId"),
      sourceActorUuid: data.sourceActorUuid,
      sourceTokenUuid: data.sourceTokenUuid,
      targetActorUuid: data.targetActorUuid ?? actor?.uuid,
      targetTokenUuid: data.targetTokenUuid ?? tokenDocument?.uuid,
      rulesVersion: data.rulesVersion ?? getShoveRulesVersion(),
      escapeDC: Number(data.escapeDC),
      targetEffectId: linkEffect.id,
      rideable: Boolean(flags?.isGrappled?.(tokenDocument))
    };
  }
  if (!flags?.isGrappled?.(tokenDocument)) return null;
  const sourceDoc = flags.RiddenToken?.(tokenDocument);
  if (!sourceDoc) return null;
  const fallback = (actor?.effects?.contents ?? []).find(effect => effect.getFlag?.(MODULE_ID, "combatAction") === "grappled");
  const data = fallback?.getFlag?.(MODULE_ID, "grappleLinkData") ?? {};
  return {
    linkId: fallback?.getFlag?.(MODULE_ID, "grappleLinkId") ?? null,
    sourceActorUuid: sourceDoc.actor?.uuid ?? data.sourceActorUuid,
    sourceTokenUuid: sourceDoc.uuid ?? data.sourceTokenUuid,
    targetActorUuid: actor?.uuid ?? data.targetActorUuid,
    targetTokenUuid: tokenDocument.uuid ?? data.targetTokenUuid,
    rulesVersion: data.rulesVersion ?? getShoveRulesVersion(),
    escapeDC: Number(data.escapeDC),
    targetEffectId: fallback?.id ?? null,
    rideable: true
  };
}

function actorHasStatusId(actor, statusId) {
  if (!actor || !statusId) return false;
  const statusIds = effect => {
    const values = effect?.statuses;
    return values instanceof Set ? [...values] : Array.isArray(values) ? values : [...(values ?? [])];
  };
  if ([...(actor.statuses ?? [])].includes(statusId)) return true;
  return (actor.effects?.contents ?? []).some(effect => statusIds(effect).includes(statusId) && effect.disabled !== true);
}

function getGrappleSizeRank(actor) {
  const size = String(actor?.system?.traits?.size ?? "").toLowerCase();
  return ({ tiny: 0, sm: 1, med: 2, lg: 3, huge: 4, grg: 5 })[size] ?? null;
}

function isIncapacitatedForGrapple(actor) {
  return actorHasStatusId(actor, "incapacitated");
}

function calculateGrappleEscapeDC(actor) {
  return calculateShoveSaveDC(actor).dc;
}

async function startLegacyGrappleAsGM(requestId, sourceUserId, rawRequest) {
  if (!game.user.isGM) return { accepted: false, reason: "Only a GM may coordinate Grapple checks." };
  if (!requestId || rawRequest?.rulesVersion !== "legacy") return { accepted: false, reason: "Invalid 2014 Grapple request." };
  const sourceUser = game.users.get(sourceUserId);
  if (!sourceUser?.active || sourceUserId !== rawRequest.sourceUserId) return { accepted: false, reason: "The initiating user is not active or does not match the request." };
  pendingGrappleRequests.set(requestId, { ...rawRequest, coordinatorUserId: game.user.id });
  void runLegacyGrappleContest(requestId, { ...rawRequest, coordinatorUserId: game.user.id });
  return { accepted: true };
}

async function runLegacyGrappleContest(requestId, rawRequest) {
  if (!game.user.isGM || activeGrappleRequests.has(requestId)) return;
  activeGrappleRequests.add(requestId);
  const request = { ...rawRequest, coordinatorUserId: game.user.id };
  let sourceDoc, targetDoc, sourceActor, targetActor;
  try {
    sourceDoc = await fromUuid(request.sourceTokenUuid);
    targetDoc = await fromUuid(request.targetTokenUuid);
    sourceActor = sourceDoc?.actor ?? await fromUuid(request.sourceActorUuid);
    targetActor = targetDoc?.actor ?? await fromUuid(request.targetActorUuid);
    if (!sourceDoc || !targetDoc || !sourceActor || !targetActor) throw new Error("The Grapple source or target is unavailable.");
    const sourceUser = game.users.get(request.sourceUserId);
    if (!sourceUser?.active || (!sourceUser.isGM && !sourceActor.testUserPermission?.(sourceUser, CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3) && !sourceDoc.testUserPermission?.(sourceUser, CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3))) {
      throw new Error("The initiating user does not own the Grapple source.");
    }
    if (request.mode === "initiate" && isIncapacitatedForGrapple(targetActor)) {
      await applyGrappleLinkAndEffects(request, sourceDoc, targetDoc, sourceActor, targetActor);
      await postGrappleResult(requestId, request, true, "legacy", { automatic: true });
      return;
    }

    let sourceSkill = request.mode === "escape" ? request.sourceSkill : "ath";
    let targetSkill = request.mode === "escape" ? "ath" : null;
    if (request.mode === "initiate") {
      const targetUserId = getShoveDefenseUserId(targetActor, targetDoc);
      if (!targetUserId) throw new Error("No active controller is available for the Grapple target.");
      targetSkill = await requestGrappleChoice(requestId, targetUserId, request.targetName, "legacy-defense");
      if (!targetSkill) throw new Error("The target's Grapple defense choice was not received.");
    }
    if (!(["ath", "acr"].includes(sourceSkill)) || !(["ath", "acr"].includes(targetSkill))) throw new Error("Invalid Grapple contest skill.");

    const midi = globalThis.MidiQOL;
    if (!game.modules.get("midi-qol")?.active || typeof midi?.contestedRoll !== "function") throw new Error("Midi-QoL contestedRoll is unavailable on the GM client.");
    const sourcePlaceable = sourceDoc.object ?? canvas.tokens.get(sourceDoc.id);
    const targetPlaceable = targetDoc.object ?? canvas.tokens.get(targetDoc.id);
    if (!sourcePlaceable || !targetPlaceable) throw new Error("Grapple tokens are not available on the active GM canvas.");

    await prepareGrappleRollContexts(requestId, [
      { actorUuid: sourceActor.uuid, skill: sourceSkill, actorId: sourceActor.id, tokenId: sourceDoc.id, actorType: sourceActor.type },
      { actorUuid: targetActor.uuid, skill: targetSkill, actorId: targetActor.id, tokenId: targetDoc.id, actorType: targetActor.type }
    ]);
    let contest;
    try {
      contest = await midi.contestedRoll({
        source: { token: sourcePlaceable, rollType: "skill", ability: sourceSkill, rollOptions: { fastForward: true, chatMessage: true } },
        target: { token: targetPlaceable, rollType: "skill", ability: targetSkill, rollOptions: { fastForward: true, chatMessage: true } },
        displayResults: false,
        flavor: game.i18n.localize(request.mode === "escape" ? "ACTION_HUD.grappleEscape" : "ACTION_HUD.grapple"),
        rollOptions: { fastForward: true, chatMessage: true }
      });
    } finally {
      clearShoveRollContexts(requestId);
      game.socket.emit(`module.${MODULE_ID}`, { type: "shove-roll-context-clear", requestMessageId: requestId });
    }
    const rolls = Array.isArray(contest?.rolls) ? contest.rolls : [];
    const sourceTotal = extractShoveRollTotal(rolls[0]);
    const targetTotal = extractShoveRollTotal(rolls[1]);
    const delta = Number(contest?.result);
    const success = Number.isFinite(delta) ? delta > 0 : Number.isFinite(sourceTotal) && Number.isFinite(targetTotal) && sourceTotal > targetTotal;
    if (!Number.isFinite(delta) && (!Number.isFinite(sourceTotal) || !Number.isFinite(targetTotal))) throw new Error("Midi-QoL returned unrecognized Grapple totals.");

    if (success) {
      if (request.mode === "initiate") await applyGrappleLinkAndEffects(request, sourceDoc, targetDoc, sourceActor, targetActor);
      else await endGrappleLink(request.grappleLinkId, request.grappleLinkData);
    }
    await postGrappleResult(requestId, request, success, "legacy", { sourceTotal, targetTotal, delta, sourceSkill, targetSkill });
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to resolve 2014 Grapple`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.grappleResolutionFailed"));
  } finally {
    clearShoveRollContexts(requestId);
    pendingGrappleRequests.delete(requestId);
    activeGrappleRequests.delete(requestId);
  }
}

async function startModernGrappleAsGM(requestId, sourceUserId, rawRequest) {
  if (!game.user.isGM) return { accepted: false, reason: "Only a GM may coordinate modern Grapple saves." };
  if (!requestId || rawRequest?.rulesVersion !== "modern") return { accepted: false, reason: "Invalid 2024 Grapple request." };
  const sourceUser = game.users.get(sourceUserId);
  if (!sourceUser?.active || sourceUserId !== rawRequest.sourceUserId) return { accepted: false, reason: "The initiating user is not active or does not match the request." };
  pendingGrappleRequests.set(requestId, { ...rawRequest, coordinatorUserId: game.user.id });
  void runModernGrappleRequest(requestId, { ...rawRequest, coordinatorUserId: game.user.id });
  return { accepted: true };
}

async function runModernGrappleRequest(requestId, request) {
  if (!game.user.isGM || activeGrappleRequests.has(requestId)) return;
  activeGrappleRequests.add(requestId);
  try {
    const sourceDoc = await fromUuid(request.sourceTokenUuid);
    const targetDoc = await fromUuid(request.targetTokenUuid);
    const sourceActor = sourceDoc?.actor ?? await fromUuid(request.sourceActorUuid);
    const targetActor = targetDoc?.actor ?? await fromUuid(request.targetActorUuid);
    if (!sourceDoc || !targetDoc || !sourceActor || !targetActor) throw new Error("The Grapple source or target is unavailable.");
    if (request.mode === "escape") {
      const escapeDC = Number(request.escapeDC);
      if (!Number.isFinite(escapeDC) || !["ath", "acr"].includes(request.sourceSkill)) throw new Error("The Grapple escape DC or skill is invalid.");
      const sourceUserId = request.sourceUserId;
      const contextSkill = request.sourceSkill;
      await prepareGrappleRollContexts(requestId, [{ actorUuid: sourceActor.uuid, skill: contextSkill, actorId: sourceActor.id, tokenId: sourceDoc.id, actorType: sourceActor.type }]);
      let result;
      try {
        result = await requestMidiGrappleRoll(sourceUserId, {
          actorUuid: sourceActor.uuid, rollType: "skill", skill: contextSkill, dc: escapeDC,
          actorType: sourceActor.type, tokenId: sourceDoc.id
        });
      } finally {
        clearShoveRollContexts(requestId);
        game.socket.emit(`module.${MODULE_ID}`, { type: "shove-roll-context-clear", requestMessageId: requestId });
      }
      const total = extractShoveRollTotal(result);
      if (!Number.isFinite(total)) throw new Error("Midi-QoL did not return the Grapple escape check total.");
      const success = total >= escapeDC;
      if (success) await endGrappleLink(request.grappleLinkId, request.grappleLinkData);
      await postGrappleResult(requestId, request, success, "modern", { total, escapeDC, sourceSkill: contextSkill });
      return;
    }

    const targetUserId = getShoveDefenseUserId(targetActor, targetDoc);
    if (!targetUserId) throw new Error("No active controller is available for the Grapple target.");
    const dcData = calculateGrappleDC(sourceActor);
    const saveAbility = await requestGrappleChoice(requestId, targetUserId, request.targetName, "modern-save");
    if (!saveAbility) throw new Error("The target's Grapple saving throw choice was not received.");
    const context = { actorUuid: targetActor.uuid, skill: `save:${saveAbility}`, actorId: targetActor.id, tokenId: targetDoc.id, actorType: targetActor.type };
    await prepareGrappleRollContexts(requestId, [context]);
    let result;
    try {
      result = await requestMidiGrappleRoll(targetUserId, {
        actorUuid: targetActor.uuid, rollType: "save", ability: saveAbility, dc: dcData.dc,
        actorType: targetActor.type, tokenId: targetDoc.id
      });
    } finally {
      clearShoveRollContexts(requestId);
      game.socket.emit(`module.${MODULE_ID}`, { type: "shove-roll-context-clear", requestMessageId: requestId });
    }
    const total = extractShoveRollTotal(result);
    if (!Number.isFinite(total)) throw new Error("Midi-QoL did not return the Grapple saving throw total.");
    // A failed Strength/Dexterity save means the Grapple succeeds.
    const success = total < dcData.dc;
    if (success) await applyGrappleLinkAndEffects(request, sourceDoc, targetDoc, sourceActor, targetActor, dcData.dc);
    await postGrappleResult(requestId, request, success, "modern", { total, saveDC: dcData.dc, saveAbility });
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to resolve 2024 Grapple`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.grappleResolutionFailed"));
  } finally {
    clearShoveRollContexts(requestId);
    pendingGrappleRequests.delete(requestId);
    activeGrappleRequests.delete(requestId);
  }
}

function calculateGrappleDC(actor) {
  return calculateShoveSaveDC(actor);
}

async function requestMidiGrappleRoll(userId, { actorUuid, rollType, ability = null, skill = null, dc, actorType, tokenId }) {
  const midi = globalThis.MidiQOL;
  if (!game.modules.get("midi-qol")?.active || typeof midi?.socket !== "function") throw new Error("Midi-QoL SocketLib roll API is unavailable.");
  const midiSocket = midi.socket();
  if (!midiSocket?.executeAsUser) throw new Error("Midi-QoL executeAsUser API is unavailable.");
  const saveDetails = {
    actorUuid,
    advantage: undefined,
    disadvantage: undefined,
    modifierTracker: undefined,
    isFriendly: false,
    isMagicSave: false,
    isConcentrationCheck: undefined,
    rollDC: Number(dc) || 0,
    saveItemUuid: "",
    workflowId: "",
    itemCardUuid: "",
    workflowOptions: {},
    rollType,
    rollAbilities: ability ? [ability] : [],
    rollSkills: skill ? [skill] : [],
    rollTools: [],
    itemId: ""
  };
  return midiSocket.executeAsUser("rollAbility", userId, {
    saveDetails,
    displayOptions: { fastForward: true, chatMessage: true, ...(actorType === "npc" ? { rollMode: "gmroll" } : {}) }
  });
}

async function requestGrappleChoice(requestId, userId, targetName, choiceType) {
  if (userId === game.user.id) return chooseGrappleChoiceDialog(targetName, choiceType);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingGrappleChoiceRequests.delete(requestId);
      reject(new Error("The Grapple choice prompt timed out."));
    }, 120000);
    pendingGrappleChoiceRequests.set(requestId, { resolve, reject, timer, userId, choiceType, coordinatorUserId: game.user.id });
    actionHudSocket.executeAsUser("openGrappleChoicePrompt", userId, {
      requestId, targetUserId: userId, coordinatorUserId: game.user.id,
      targetName, choiceType
    }).then(result => {
      if (!result?.accepted && pendingGrappleChoiceRequests.has(requestId)) {
        clearTimeout(timer); pendingGrappleChoiceRequests.delete(requestId);
        reject(new Error(result?.reason ?? "The defender rejected the Grapple choice prompt."));
      }
    }).catch(error => {
      if (!pendingGrappleChoiceRequests.has(requestId)) return;
      clearTimeout(timer); pendingGrappleChoiceRequests.delete(requestId); reject(error);
    });
  });
}

function openGrappleChoicePrompt(payload) {
  const coordinator = game.users.get(payload?.coordinatorUserId);
  if (!payload?.requestId || payload.targetUserId !== game.user.id || !coordinator?.isGM || !coordinator.active) {
    return { accepted: false, reason: "The Grapple choice prompt was not sent by an active GM coordinator." };
  }
  void chooseGrappleChoiceDialog(payload.targetName, payload.choiceType).then(choice => {
    if (!choice) return;
    return actionHudSocket.executeAsGM("submitGrappleChoiceAsGM", payload.requestId, game.user.id, payload.choiceType, choice);
  }).catch(error => console.error(`${MODULE_ID} | Failed to submit Grapple choice`, error));
  return { accepted: true };
}

function submitGrappleChoiceAsGM(requestId, userId, choiceType, choice) {
  if (!game.user.isGM) return { accepted: false, reason: "Only the GM can receive Grapple choices." };
  const pending = pendingGrappleChoiceRequests.get(requestId);
  if (!pending || pending.userId !== userId || pending.choiceType !== choiceType) return { accepted: false, reason: "The Grapple choice request is no longer pending." };
  const valid = choiceType === "modern-save" ? ["str", "dex"].includes(choice) : ["ath", "acr"].includes(choice);
  if (!valid) return { accepted: false, reason: "An invalid Grapple choice was submitted." };
  clearTimeout(pending.timer);
  pendingGrappleChoiceRequests.delete(requestId);
  pending.resolve(choice);
  return { accepted: true };
}

function chooseGrappleChoiceDialog(targetName, choiceType) {
  const titleKey = choiceType === "modern-save" ? "ACTION_HUD.grappleSaveTitle" : choiceType === "escape-skill" ? "ACTION_HUD.grappleEscapeTitle" : "ACTION_HUD.grappleDefenseTitle";
  const promptKey = choiceType === "modern-save" ? "ACTION_HUD.grappleSavePrompt" : choiceType === "escape-skill" ? "ACTION_HUD.grappleEscapePrompt" : "ACTION_HUD.grappleDefensePrompt";
  return new Promise(resolve => {
    let settled = false;
    const defaultChoice = choiceType === "modern-save" ? "str" : "ath";
    const finish = value => { if (settled) return; settled = true; resolve(value); };
    // Define the button callbacks in the same lexical scope as finish().
    // Previously, the callbacks were created outside this Promise executor,
    // so clicking Athletics/Acrobatics threw a ReferenceError.
    const buttons = choiceType === "modern-save"
      ? { str: { label: game.i18n.localize("ACTION_HUD.shoveSaveStrength2024"), callback: () => finish("str") }, dex: { label: game.i18n.localize("ACTION_HUD.shoveSaveDexterity2024"), callback: () => finish("dex") } }
      : { athletics: { label: game.i18n.localize("ACTION_HUD.shoveDefenseAthletics"), callback: () => finish("ath") }, acrobatics: { label: game.i18n.localize("ACTION_HUD.shoveDefenseAcrobatics"), callback: () => finish("acr") } };
    const dialog = new Dialog({
      title: game.i18n.localize(titleKey),
      content: `<form class="ahud-action-dialog"><p>${foundry.utils.escapeHTML(game.i18n.format(promptKey, { target: targetName ?? game.i18n.localize("ACTION_HUD.targetToken") }))}</p></form>`,
      classes: ["ahud-dialog-window"],
      buttons,
      default: Object.keys(buttons)[0],
      close: () => { hudDialogs.delete(dialog); finish(defaultChoice); },
      render: html => html?.[0]?.closest?.(".app.window-app")?.classList.add("ahud-dialog-window")
    });
    hudDialogs.add(dialog); dialog.render(true);
  });
}

async function startGrappleEscape(token, actor, link, currentRulesVersion) {
  if (!game.combat?.started) {
    ui.notifications.info(game.i18n.localize("ACTION_HUD.combatMustBeStarted"));
    return;
  }
  const sourceDoc = token.document;
  const sourceActor = actor;
  const targetDoc = await fromUuid(link.sourceTokenUuid).catch(() => null);
  const targetActor = targetDoc?.actor ?? (link.sourceActorUuid ? await fromUuid(link.sourceActorUuid).catch(() => null) : null);
  if (!targetDoc || !targetActor) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.grappleTargetUnavailable"));
    return;
  }
  const confirmed = await confirmHudDialog(
    game.i18n.localize("ACTION_HUD.grappleEscapeConfirmTitle"),
    `<p>${game.i18n.localize("ACTION_HUD.grappleEscapeConsumesAction")}</p>`
  );
  if (!confirmed) return;
  if (isIncapacitatedForGrapple(targetActor)) {
    if (game.user.isGM) await endGrappleLink(link.linkId, link);
    else await actionHudSocket.executeAsGM("endGrappleLinkAsGM", link.linkId, link);
    await postGrappleResult(foundry.utils.randomID(), { sourceActorUuid: sourceActor.uuid, sourceTokenUuid: sourceDoc.uuid }, true, currentRulesVersion, { escaped: true, automatic: true });
    return;
  }
  const skill = await chooseGrappleChoiceDialog(targetActor.name, "escape-skill");
  if (!skill) return;
  const requestId = foundry.utils.randomID();
  const request = {
    rulesVersion: link.rulesVersion ?? currentRulesVersion,
    mode: "escape",
    sourceActorUuid: sourceActor.uuid,
    sourceTokenUuid: sourceDoc.uuid,
    sourceTokenId: sourceDoc.id,
    targetActorUuid: targetActor.uuid,
    targetTokenUuid: targetDoc.uuid,
    targetTokenId: targetDoc.id,
    sceneId: sourceDoc.parent?.id ?? canvas.scene?.id,
    sourceUserId: game.user.id,
    sourceName: token.name,
    targetName: targetDoc.name,
    sourceSkill: skill,
    grappleLinkId: link.linkId,
    grappleLinkData: link,
    escapeDC: Number.isFinite(Number(link.escapeDC)) ? Number(link.escapeDC) : calculateGrappleEscapeDC(targetActor)
  };
  try {
    const method = request.rulesVersion === "modern" ? "startModernGrappleAsGM" : "startLegacyGrappleAsGM";
    const result = game.user.isGM ? (request.rulesVersion === "modern"
      ? await startModernGrappleAsGM(requestId, game.user.id, request)
      : await startLegacyGrappleAsGM(requestId, game.user.id, request))
      : await actionHudSocket.executeAsGM(method, requestId, game.user.id, request);
    if (!result?.accepted) throw new Error(result?.reason ?? "The GM did not accept the Escape request.");
  } catch (error) {
    console.error(`${MODULE_ID} | Could not start Escape from Grapple`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.grappleResolutionFailed"));
  }
}

async function prepareGrappleRollContexts(requestId, contexts) {
  const entries = [];
  for (const entry of contexts) {
    let actor = null;
    if (entry.actorUuid) actor = await fromUuid(entry.actorUuid).catch(() => null);
    entries.push({ ...entry, actorId: entry.actorId ?? actor?.id ?? null, actorType: entry.actorType ?? actor?.type ?? null });
  }
  const valid = entries.filter(entry => entry.actorUuid && entry.skill);
  for (const entry of valid) registerLocalShoveRollContext(requestId, entry.actorUuid, entry.skill, entry);
  game.socket.emit(`module.${MODULE_ID}`, { type: "shove-roll-contexts", requestMessageId: requestId, contexts: valid });
  await new Promise(resolve => setTimeout(resolve, 350));
}

async function applyGrappleLinkAndEffects(request, sourceDoc, targetDoc, sourceActor, targetActor, suppliedEscapeDC = null) {
  if (!game.user.isGM) throw new Error("Only the GM can apply a Rideable Grapple link.");
  if (!isRideableGrapplingAvailableForGM()) throw new Error("Rideable Grappling is not enabled. Enable Rideable > Grappling in Module Settings.");
  const flags = getRideableFlagsApi();
  const existingLink = getGrappleLinkForToken(targetDoc);
  if (existingLink) throw new Error("The target is already grappled.");
  if (flags?.isRider?.(targetDoc)) throw new Error("The target is already linked to another Rideable token.");
  const linkId = foundry.utils.randomID();
  const rulesVersion = request.rulesVersion;
  const escapeDC = Number(suppliedEscapeDC ?? calculateGrappleEscapeDC(sourceActor));
  const linkData = {
    rulesVersion,
    sourceActorUuid: sourceActor.uuid, sourceTokenUuid: sourceDoc.uuid,
    targetActorUuid: targetActor.uuid, targetTokenUuid: targetDoc.uuid,
    escapeDC, sourceName: sourceDoc.name, targetName: targetDoc.name
  };

  await requestRideableGrappleChange("mount", sourceDoc, targetDoc);
  const linked = await waitForGrappleState(() => flags?.isGrappledby?.(targetDoc, sourceDoc) === true, 5000);
  if (!linked) throw new Error("Rideable did not confirm the Grapple link. Check that Rideable's Grappling setting is enabled.");

  try {
    const changeMode = CONST.ACTIVE_EFFECT_MODES?.OVERRIDE ?? 5;
    const customMode = CONST.ACTIVE_EFFECT_MODES?.CUSTOM ?? 0;
    const movementKeys = ["walk", "fly", "swim", "climb", "burrow"];
    const targetChanges = movementKeys.map(key => ({ key: `system.attributes.movement.${key}`, mode: changeMode, value: "0", priority: 20 }));
    if (rulesVersion === "modern") {
      targetChanges.push({
        key: "flags.midi-qol.disadvantage.attack.all", mode: customMode,
        value: `targetActorUuid !== ${JSON.stringify(sourceActor.uuid)}`, priority: 20
      });
    }
    const targetStatus = CONFIG.statusEffects?.find(status => status.id === "grappled");
    const baseFlags = { grappleLinkId: linkId, grappleLinkData: linkData, sourceActorUuid: sourceActor.uuid, sourceTokenUuid: sourceDoc.uuid, targetActorUuid: targetActor.uuid, targetTokenUuid: targetDoc.uuid, rulesVersion, escapeDC };
    const grappleCombatId = game.combat?.started ? game.combat.id : null;
    await sourceActor.createEmbeddedDocuments("ActiveEffect", [{
      name: game.i18n.format("ACTION_HUD.grapplingEffect", { target: targetDoc.name }),
      img: "systems/dnd5e/icons/svg/statuses/grappled.svg",
      origin: targetActor.uuid,
      disabled: false,
      changes: [],
      duration: {},
      flags: {
        dae: { specialDuration: ["combatEnd"] },
        [MODULE_ID]: { ...baseFlags, combatAction: "grappling", grappleRole: "grappler", grappleCombatId }
      }
    }]);
    await targetActor.createEmbeddedDocuments("ActiveEffect", [{
      name: game.i18n.format("ACTION_HUD.grappledEffect", { source: sourceDoc.name }),
      img: targetStatus?.icon ?? targetStatus?.img ?? "systems/dnd5e/icons/svg/statuses/grappled.svg",
      origin: sourceActor.uuid,
      disabled: false,
      statuses: ["grappled"],
      changes: targetChanges,
      flags: { [MODULE_ID]: { ...baseFlags, combatAction: "grappled", grappleRole: "target" } }
    }]);

    const sourceRank = getGrappleSizeRank(sourceActor);
    const targetRank = getGrappleSizeRank(targetActor);
    const noSlowdown = rulesVersion === "modern"
      ? (targetRank === 0 || (sourceRank !== null && targetRank !== null && sourceRank - targetRank >= 2))
      : (sourceRank !== null && targetRank !== null && sourceRank - targetRank >= 2);
    if (!noSlowdown) await addGrappleSpeedPenalty(sourceActor, linkId, linkData, movementKeys);
  } catch (error) {
    await endGrappleLink(linkId, linkData).catch(() => {});
    throw error;
  }
  queueRefresh();
}

async function addGrappleSpeedPenalty(actor, linkId, linkData, movementKeys) {
  const existing = (actor.effects?.contents ?? []).find(effect => effect.getFlag?.(MODULE_ID, "combatAction") === "grapple-speed");
  if (existing) {
    const links = existing.getFlag(MODULE_ID, "grappleLinkIds") ?? [];
    const data = existing.getFlag(MODULE_ID, "grappleLinkDataById") ?? {};
    if (!links.includes(linkId)) links.push(linkId);
    data[linkId] = linkData;
    await existing.update({ [`flags.${MODULE_ID}.grappleLinkIds`]: links, [`flags.${MODULE_ID}.grappleLinkDataById`]: data });
    return;
  }
  const multiplyMode = CONST.ACTIVE_EFFECT_MODES?.MULTIPLY ?? 2;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: game.i18n.localize("ACTION_HUD.grappleSpeedPenalty"),
    img: "systems/dnd5e/icons/svg/statuses/grappled.svg",
    disabled: false,
    changes: movementKeys.map(key => ({ key: `system.attributes.movement.${key}`, mode: multiplyMode, value: "0.5", priority: 20 })),
    flags: { [MODULE_ID]: { combatAction: "grapple-speed", grappleLinkIds: [linkId], grappleLinkDataById: { [linkId]: linkData } } }
  }]);
}

async function requestRideableGrappleChange(action, sourceDoc, targetDoc) {
  const sceneId = sourceDoc.parent?.id ?? targetDoc.parent?.id ?? canvas.scene?.id;
  const payload = {
    action, coordinatorUserId: game.user.id, sceneId,
    sourceTokenId: sourceDoc.id, targetTokenId: targetDoc.id
  };
  // Rideable's own MountRequest/UnMountRequest socket handlers perform the position, flag,
  // and movement-follow setup. Ask a player client to relay the native Rideable request so the
  // GM receives it through Rideable's documented module socket channel.
  const relayUser = [...game.users].find(user => user.active && !user.isGM);
  if (relayUser && actionHudSocket?.executeAsUser) {
    const result = await actionHudSocket.executeAsUser("relayRideableGrappleRequest", relayUser.id, payload);
    if (!result?.accepted) throw new Error(result?.reason ?? "No client relayed the Rideable Grapple request.");
    return;
  }
  // In a GM-only session, use the installed Rideable API directly as a safe fallback.
  const flags = getRideableFlagsApi();
  if (!flags) throw new Error("Rideable's API is unavailable.");
  if (action === "mount") await flags.addRiderTokens(sourceDoc, [targetDoc], { Familiar: false, Grappled: true }, true);
  else await flags.stopRiding([targetDoc], true);
}

function relayRideableGrappleRequest(payload) {
  const coordinator = game.users.get(payload?.coordinatorUserId);
  if (!coordinator?.active || !coordinator.isGM) return { accepted: false, reason: "Only an active GM may request Rideable Grapple links." };
  if (!game.modules.get("Rideable")?.active || !payload?.sceneId || !payload?.sourceTokenId || !payload?.targetTokenId) {
    return { accepted: false, reason: "The Rideable Grapple request is missing required data." };
  }
  if (payload.action === "mount") {
    game.socket.emit("module.Rideable", {
      pFunction: "MountRequest",
      pData: { pTargetID: payload.sourceTokenId, pselectedTokensID: [payload.targetTokenId], pSceneID: payload.sceneId, pRidingOptions: { Familiar: false, Grappled: true, isGM: true } }
    });
  } else {
    game.socket.emit("module.Rideable", {
      pFunction: "UnMountRequest",
      pData: { pselectedTokenIDs: [payload.targetTokenId], pSceneID: payload.sceneId, pfromRidden: true }
    });
  }
  return { accepted: true };
}

async function waitForGrappleState(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (predicate()) return true; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try { return Boolean(predicate()); } catch (_) { return false; }
}

async function endGrappleLink(linkId, suppliedData = null) {
  if (!game.user.isGM) throw new Error("Only the GM can end a Rideable Grapple link.");
  if (!linkId) {
    // Also support escaping a Grapple created directly through Rideable rather than Action HUD.
    // Such a link has no Action HUD link ID/effects, but the Rideable Grappled flag still gives
    // us the two token documents needed to remove the native canvas relationship.
    const sourceDoc = suppliedData?.sourceTokenUuid ? await fromUuid(suppliedData.sourceTokenUuid).catch(() => null) : null;
    const targetDoc = suppliedData?.targetTokenUuid ? await fromUuid(suppliedData.targetTokenUuid).catch(() => null) : null;
    if (!sourceDoc || !targetDoc) return false;
    const flags = getRideableFlagsApi();
    if (flags?.isGrappledby?.(targetDoc, sourceDoc)) {
      await requestRideableGrappleChange("unmount", sourceDoc, targetDoc);
      let unlinked = await waitForGrappleState(() =>
        !flags?.isGrappledby?.(targetDoc, sourceDoc) && !flags?.isRiddenby?.(sourceDoc, targetDoc), 4000);
      if (!unlinked && typeof flags?.stopRiding === "function") {
        await flags.stopRiding([targetDoc], true);
        unlinked = await waitForGrappleState(() =>
          !flags?.isGrappledby?.(targetDoc, sourceDoc) && !flags?.isRiddenby?.(sourceDoc, targetDoc), 2500);
      }
      if (!unlinked) console.warn(`${MODULE_ID} | Rideable did not confirm removal of an external Grapple link`, { sourceToken: sourceDoc.name, targetToken: targetDoc.name });
    }
    queueRefresh();
    return true;
  }
  if (activeGrappleCleanupIds.has(linkId)) return true;
  activeGrappleCleanupIds.add(linkId);
  try {
    const actorMap = new Map();
    const addActor = actor => {
      if (!actor?.effects) return;
      const key = actor.uuid ?? actor.id ?? `actor-${actorMap.size}`;
      actorMap.set(key, actor);
    };
    for (const actor of game.actors ?? []) addActor(actor);

    // A token can use a synthetic, unlinked Actor. Include the token's Actor documents
    // as well as world Actors so manual removal cleans both sides of the link reliably.
    let sourceDoc = null;
    let targetDoc = null;
    let data = suppliedData ?? null;
    if (!data) {
      for (const actor of actorMap.values()) {
        const effect = (actor.effects?.contents ?? []).find(candidate => candidate.getFlag?.(MODULE_ID, "grappleLinkId") === linkId);
        if (effect) {
          data = effect.getFlag?.(MODULE_ID, "grappleLinkData") ?? {};
          break;
        }
      }
    }
    data ??= {};
    sourceDoc = data.sourceTokenUuid ? await fromUuid(data.sourceTokenUuid).catch(() => null) : null;
    targetDoc = data.targetTokenUuid ? await fromUuid(data.targetTokenUuid).catch(() => null) : null;
    const sourceActor = sourceDoc?.actor ?? (data.sourceActorUuid ? await fromUuid(data.sourceActorUuid).catch(() => null) : null);
    const targetActor = targetDoc?.actor ?? (data.targetActorUuid ? await fromUuid(data.targetActorUuid).catch(() => null) : null);
    addActor(sourceActor);
    addActor(targetActor);

    if (sourceDoc && targetDoc) {
      const flags = getRideableFlagsApi();
      const isLinked = flags?.isRiddenby?.(sourceDoc, targetDoc) || flags?.isGrappledby?.(targetDoc, sourceDoc);
      if (isLinked) {
        await requestRideableGrappleChange("unmount", sourceDoc, targetDoc);
        let unlinked = await waitForGrappleState(() =>
          !flags?.isGrappledby?.(targetDoc, sourceDoc) && !flags?.isRiddenby?.(sourceDoc, targetDoc), 4000);
        if (!unlinked && typeof flags?.stopRiding === "function") {
          // Rideable's native socket request is preferred, but use its public API as a
          // fallback if the relay is late or the native request was rejected silently.
          await flags.stopRiding([targetDoc], true);
          unlinked = await waitForGrappleState(() =>
            !flags?.isGrappledby?.(targetDoc, sourceDoc) && !flags?.isRiddenby?.(sourceDoc, targetDoc), 2500);
        }
        if (!unlinked) console.warn(`${MODULE_ID} | Rideable did not confirm removal of the Grapple link`, { linkId, sourceToken: sourceDoc.name, targetToken: targetDoc.name });
      }
    }

    const effects = [];
    for (const actor of actorMap.values()) {
      for (const effect of actor.effects?.contents ?? []) {
        if (effect.getFlag?.(MODULE_ID, "grappleLinkId") === linkId) effects.push({ actor, effect });
      }
    }

    // The grappler's movement penalty can aggregate more than one target. Remove only
    // this link's contribution, retaining the penalty while any other grapple remains.
    for (const actor of actorMap.values()) {
      const speed = (actor.effects?.contents ?? []).find(effect => effect.getFlag?.(MODULE_ID, "combatAction") === "grapple-speed");
      if (speed) {
        const links = (speed.getFlag(MODULE_ID, "grappleLinkIds") ?? []).filter(id => id !== linkId);
        const dataById = { ...(speed.getFlag(MODULE_ID, "grappleLinkDataById") ?? {}) };
        delete dataById[linkId];
        if (!links.length) await actor.deleteEmbeddedDocuments("ActiveEffect", [speed.id]);
        else await speed.update({ [`flags.${MODULE_ID}.grappleLinkIds`]: links, [`flags.${MODULE_ID}.grappleLinkDataById`]: dataById });
      }
    }
    for (const { actor, effect } of effects) {
      if (actor.effects?.get(effect.id)) await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id]);
    }
    queueRefresh();
    return true;
  } finally {
    activeGrappleCleanupIds.delete(linkId);
  }
}

function endGrappleLinkAsGM(linkId, data) {
  if (!game.user.isGM) return { accepted: false, reason: "Only the GM can remove a Grapple link." };
  void endGrappleLink(linkId, data).catch(error => console.error(`${MODULE_ID} | Could not remove Grapple link`, error));
  return { accepted: true };
}

async function expireGrapplerEffectsForCombat(combat) {
  if (!game.user.isGM || !combat?.id) return;
  const effects = [];
  for (const actor of game.actors) {
    for (const effect of actor.effects?.contents ?? []) {
      if (effect.getFlag?.(MODULE_ID, "grappleRole") !== "grappler") continue;
      if (String(effect.getFlag?.(MODULE_ID, "grappleCombatId") ?? "") !== String(combat.id)) continue;
      effects.push(effect);
    }
  }
  for (const effect of effects) {
    try { await effect.delete(); }
    catch (error) { console.warn(`${MODULE_ID} | Could not expire Grapple link effect at combat end`, error); }
  }
}

async function onGrappleEffectDeleted(effect) {
  const linkId = effect?.getFlag?.(MODULE_ID, "grappleLinkId");
  if (!linkId || activeGrappleCleanupIds.has(linkId)) return;
  const role = effect.getFlag?.(MODULE_ID, "grappleRole");
  if (!role || !["grappler", "target"].includes(role)) return;
  const data = effect.getFlag?.(MODULE_ID, "grappleLinkData") ?? {};
  if (game.user.isGM) {
    void endGrappleLink(linkId, data).catch(error => console.error(`${MODULE_ID} | Could not synchronize manual Grapple effect removal`, error));
  } else if (actionHudSocket?.executeAsGM) {
    try { await actionHudSocket.executeAsGM("endGrappleLinkAsGM", linkId, data); }
    catch (error) { console.warn(`${MODULE_ID} | Could not ask GM to synchronize Grapple effect removal`, error); }
  }
}

async function checkGrapplesOnIncapacitation(actor) {
  if (!game.user.isGM || !actor || !isIncapacitatedForGrapple(actor)) return;
  const links = (actor.effects?.contents ?? []).filter(effect => effect.getFlag?.(MODULE_ID, "grappleRole") === "grappler");
  const unique = new Map();
  for (const effect of links) unique.set(effect.getFlag(MODULE_ID, "grappleLinkId"), effect.getFlag(MODULE_ID, "grappleLinkData"));
  for (const [linkId, data] of unique) if (linkId) await endGrappleLink(linkId, data);
}

async function postGrappleResult(requestId, request, success, rulesVersion, details = {}) {
  const sourceActor = request.sourceActorUuid ? await fromUuid(request.sourceActorUuid).catch(() => null) : null;
  const sourceTokenDoc = request.sourceTokenUuid ? await fromUuid(request.sourceTokenUuid).catch(() => null) : null;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: sourceActor ?? undefined, token: sourceTokenDoc ?? undefined }),
    content: buildShoveResultContent(success),
    flags: { [MODULE_ID]: { combatAction: "grapple", grappleResolutionFor: requestId, grappleResolution: { success, rulesVersion, mode: request.mode, ...details } } }
  });
}

function isActionHudGrappledToken(tokenDocument) {
  if (!tokenDocument) return false;
  const api = getRideableFlagsApi();
  if (api?.isGrappled?.(tokenDocument)) return true;
  return (tokenDocument.actor?.effects?.contents ?? []).some(effect =>
    effect.getFlag?.(MODULE_ID, "grappleRole") === "target" && Boolean(effect.getFlag?.(MODULE_ID, "grappleLinkId"))
  );
}

function getShoveRulesVersion() {
  // D&D 5e supports both legacy (2014) and modern (2024) rules in the same system.
  // Read the system's Rules Version setting rather than infer the rules from its package version.
  try {
    const version = game.settings.get("dnd5e", "rulesVersion");
    if (version === "modern" || version === "legacy") return version;
  } catch (error) {
    // Older D&D 5e system versions do not expose the rules-version setting and use 2014 rules.
  }
  return "legacy";
}

function getActorUnarmedReachFeet(actor) {
  const reach = Number(actor?.system?.attributes?.reach);
  return Number.isFinite(reach) && reach > 0 ? reach : 5;
}

function getLegacyShoveReachFeet(actor) {
  // 2014 rules use the creature's reach. Most actors have a 5-foot reach; honor an explicit
  // reach value when a module or system feature exposes one.
  const reach = Number(actor?.system?.attributes?.reach);
  return Number.isFinite(reach) && reach > 0 ? reach : 5;
}

function actorUsesModernMonkMartialArts(actor) {
  if (getShoveRulesVersion() !== "modern" || !actor) return false;
  const items = actor.items?.contents ?? [...(actor.items ?? [])];
  const normalize = value => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const isMonkClass = items.some(item => item.type === "class" && (
    normalize(item.system?.identifier) === "monk" || normalize(item.name) === "monk"
  ));
  if (!isMonkClass) return false;

  const martialArts = items.find(item => {
    const identifier = normalize(item.system?.identifier ?? item.identifier);
    const name = normalize(item.name);
    return identifier === "martialarts" || name === "martialarts";
  });
  if (!martialArts) return false;

  // Embedded Items can retain their own legacy/modern rules-version flag. If this is explicitly
  // a legacy Martial Arts feature, do not apply the 2024 Dexterity substitution to it.
  const featureRulesVersion = martialArts.getFlag?.("dnd5e", "rulesVersion")
    ?? martialArts.flags?.dnd5e?.rulesVersion
    ?? martialArts.system?.rulesVersion;
  return featureRulesVersion !== "legacy";
}

function getActorAbilityModifier(actor, ability) {
  const data = actor?.system?.abilities?.[ability];
  const modifier = Number(data?.mod);
  if (Number.isFinite(modifier)) return modifier;
  const score = Number(data?.value);
  return Number.isFinite(score) ? Math.floor((score - 10) / 2) : 0;
}

function calculateShoveSaveDC(actor) {
  const ability = actorUsesModernMonkMartialArts(actor) ? "dex" : "str";
  const abilityMod = getActorAbilityModifier(actor, ability);
  const proficiencyBonus = Number(actor?.system?.attributes?.prof ?? 0) || 0;
  return { ability, dc: 8 + abilityMod + proficiencyBonus };
}

function canShoveTargetBySize(sourceActor, targetActor) {
  const rank = { tiny: 0, sm: 1, med: 2, lg: 3, huge: 4, grg: 5 };
  const sourceSize = String(sourceActor?.system?.traits?.size ?? "").toLowerCase();
  const targetSize = String(targetActor?.system?.traits?.size ?? "").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(rank, sourceSize) || !Object.prototype.hasOwnProperty.call(rank, targetSize)) return true;
  return rank[targetSize] <= rank[sourceSize] + 1;
}

function getSingleTargetedToken(sourceToken, action = "help") {
  const targets = [...(game.user.targets ?? [])]
    .map(target => target?.object ?? target)
    .filter(target => target?.actor && target?.document?.id);
  if (!targets.length) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.targetTokenWithT"));
    return null;
  }
  if (targets.length !== 1) {
    ui.notifications.warn(game.i18n.localize("ACTION_HUD.targetExactlyOneToken"));
    return null;
  }
  if (String(targets[0].document.id) === String(sourceToken?.document?.id)) {
    const messageKey = action === "shove" ? "ACTION_HUD.cannotShoveSelf"
      : action === "grapple" ? "ACTION_HUD.cannotGrappleSelf"
      : "ACTION_HUD.cannotHelpSelf";
    ui.notifications.warn(game.i18n.localize(messageKey));
    return null;
  }
  return targets[0];
}

function isTokenWithinFeet(sourceToken, targetToken, maxFeet) {
  try {
    const source = sourceToken?.document;
    const target = targetToken?.document;
    const grid = canvas.grid;
    const sceneGrid = canvas.scene?.grid ?? {};
    const gridSize = Number(grid?.size);
    const gridDistance = Number(sceneGrid.distance) || 5;
    const units = String(sceneGrid.units ?? "ft").toLowerCase();
    const maxDistance = units.includes("meter") || units === "m" ? maxFeet * 0.3048
      : units.includes("yard") || units === "yd" ? maxFeet / 3 : maxFeet;

    // Prefer Midi-QoL's public distance API so range checks agree with its configured
    // measurement mode (center, grid-square centers, or token perimeters) and fudge factor.
    // Midi-QoL returns distance in the scene's grid units, matching maxDistance above.
    const midiGetDistance = globalThis.MidiQOL?.getDistance;
    if (typeof midiGetDistance === "function") {
      try {
        const measuredDistance = Number(midiGetDistance(sourceToken, targetToken));
        if (Number.isFinite(measuredDistance)) {
          // Midi-QoL uses -1 when a valid measurement cannot be produced; fail closed in that case.
          return measuredDistance >= 0 && measuredDistance <= maxDistance + 1e-6;
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | Midi-QoL distance measurement failed; using the Action HUD fallback`, error);
      }
    }

    // Fallback for when Midi-QoL is not active, its distance API is unavailable, or the API throws.
    // On square grids, measure the closest occupied grid spaces rather than token centres,
    // so Large and larger creatures can Help creatures adjacent to their footprint.
    const squareGrid = CONST.GRID_TYPES?.SQUARE;
    if (source && target && gridSize > 0 && squareGrid !== undefined && sceneGrid.type === squareGrid) {
      const rect = doc => ({
        left: Number(doc.x), top: Number(doc.y),
        right: Number(doc.x) + Number(doc.width ?? 1) * gridSize,
        bottom: Number(doc.y) + Number(doc.height ?? 1) * gridSize
      });
      const a = rect(source), b = rect(target);
      const gapSpaces = (aStart, aEnd, bStart, bEnd) => {
        if (aStart < bEnd && aEnd > bStart) return 0;
        const pixels = Math.max(aStart - bEnd, bStart - aEnd, 0);
        return Math.max(1, Math.ceil(pixels / gridSize));
      };
      const xSpaces = gapSpaces(a.left, a.right, b.left, b.right);
      const ySpaces = gapSpaces(a.top, a.bottom, b.top, b.bottom);
      return Math.max(xSpaces, ySpaces) * gridDistance <= maxDistance + 1e-6;
    }

    // Fallback for gridless and non-square scenes.
    const origin = sourceToken?.center;
    const destination = targetToken?.center;
    if (!origin || !destination || !grid?.measurePath) return true;
    const measurement = grid.measurePath([{ x: origin.x, y: origin.y }, { x: destination.x, y: destination.y }]);
    return Number(measurement?.distance) <= maxDistance + 1e-6;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not measure Help range; allowing the action`, error);
    return true;
  }
}

function actorIsIncapacitatedOrImmobile(actor) {
  const statuses = actor?.statuses;
  const incapacitated = statuses?.has?.("incapacitated") || (actor?.effects?.contents ?? []).some(effect => !effect.disabled && (effect.statuses?.has?.("incapacitated") || effect.getFlag?.("core", "statusId") === "incapacitated"));
  const movement = actor?.system?.attributes?.movement ?? {};
  const speeds = Object.entries(movement).filter(([key, value]) => !["hover", "units"].includes(key) && typeof value === "number");
  const immobile = speeds.length > 0 && speeds.every(([, value]) => value <= 0);
  return Boolean(incapacitated || immobile);
}

async function removeInvalidDodgeEffects(actor) {
  if (!actor?.effects?.contents?.length || !actorIsIncapacitatedOrImmobile(actor)) return;
  const dodges = actor.effects.contents.filter(effect => !effect.disabled && effect.getFlag?.(MODULE_ID, "combatAction") === "dodge");
  if (!dodges.length) return;
  try { await actor.deleteEmbeddedDocuments("ActiveEffect", dodges.map(effect => effect.id)); }
  catch (error) { console.warn(`${MODULE_ID} | Could not end Dodge after incapacitation or Speed 0`, error); }
}

async function consumeHelpAttackBenefit(workflow) {
  try {
    const attackerUuid = workflow?.actor?.uuid;
    if (!attackerUuid) return;
    const tokens = [...(workflow.targets ?? [])];
    const toRemove = [];
    for (const targetToken of tokens) {
      const targetActor = targetToken?.actor ?? targetToken?.document?.actor;
      if (!targetActor) continue;
      for (const effect of targetActor.effects?.contents ?? []) {
        const metadata = effect.getFlag?.(MODULE_ID, "combatAction") === "help-attack"
          ? { sourceActorUuid: effect.getFlag?.(MODULE_ID, "sourceActorUuid") } : null;
        if (metadata && metadata.sourceActorUuid !== attackerUuid) toRemove.push({ actor: targetActor, effect });
      }
    }
    const grouped = new Map();
    for (const item of toRemove) {
      const list = grouped.get(item.actor) ?? [];
      list.push(item.effect.id); grouped.set(item.actor, list);
    }
    for (const [actor, ids] of grouped) {
      if (game.user.isGM || actor.isOwner) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
      else if (globalThis.MidiQOL?.socket) await globalThis.MidiQOL.socket().executeAsGM("removeEffects", { actorUuid: actor.uuid, effects: ids });
    }
  } catch (error) { console.warn(`${MODULE_ID} | Could not consume Help attack benefit`, error); }
}

function extractHelpSkillRollContext(args) {
  const skillIds = Object.keys(CONFIG.DND5E.skills ?? {});
  let actor = null;
  let skill = null;
  const seen = new Set();
  const inspect = (value, depth = 0) => {
    if (value == null || depth > 3 || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!actor && value.documentName === "Actor" && value.effects) actor = value;
    if (!actor && value.actor?.documentName === "Actor" && value.actor?.effects) actor = value.actor;
    if (!skill) {
      for (const key of ["skill", "skillId", "skillKey", "skillIdentifier"]) {
        if (typeof value[key] === "string" && skillIds.includes(value[key])) { skill = value[key]; break; }
      }
    }
    for (const key of ["options", "config", "rollOptions", "data", "context"]) inspect(value[key], depth + 1);
  };
  for (const value of args) {
    if (!skill && typeof value === "string" && skillIds.includes(value)) skill = value;
    inspect(value);
  }
  return { actor, skill };
}

async function consumeHelpSkillBenefitFromHook(args) {
  try {
    const { actor, skill } = extractHelpSkillRollContext(args);
    if (!actor || !skill) return;
    const effects = (actor.effects?.contents ?? []).filter(effect =>
      effect.getFlag?.(MODULE_ID, "combatAction") === "help-skill" &&
      effect.getFlag?.(MODULE_ID, "targetActorUuid") === actor.uuid &&
      effect.getFlag?.(MODULE_ID, "skill") === skill &&
      !effect.disabled
    );
    if (!effects.length) return;
    const ids = effects.map(effect => effect.id);
    if (game.user.isGM || actor.isOwner) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
    else if (globalThis.MidiQOL?.socket) await globalThis.MidiQOL.socket().executeAsGM("removeEffects", { actorUuid: actor.uuid, effects: ids });
  } catch (error) { console.warn(`${MODULE_ID} | Could not consume Help skill benefit`, error); }
}

async function replaceActorActionEffects(actor, actionIds, sourceActorUuid = null) {
  const existing = (actor?.effects?.contents ?? []).filter(effect => {
    const action = effect.getFlag?.(MODULE_ID, "combatAction");
    if (!actionIds.includes(action)) return false;
    const existingSource = effect.getFlag?.(MODULE_ID, "sourceActorUuid");
    return sourceActorUuid === null || existingSource === sourceActorUuid;
  });
  if (!existing.length) return;
  if (game.user.isGM || actor.isOwner) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(effect => effect.id));
  else if (globalThis.MidiQOL?.socket) await globalThis.MidiQOL.socket().executeAsGM("removeEffects", { actorUuid: actor.uuid, effects: existing.map(effect => effect.id) });
}

async function createActionEffect(actor, data) {
  if (game.user.isGM || actor.isOwner) return actor.createEmbeddedDocuments("ActiveEffect", [data]);
  if (globalThis.MidiQOL?.socket && game.modules.get("midi-qol")?.active) {
    return globalThis.MidiQOL.socket().executeAsGM("createEffects", { actorUuid: actor.uuid, effects: [data] });
  }
  throw new Error(`No permission to apply an Active Effect to ${actor.name} and Midi-QoL GM socket is unavailable.`);
}

function sceneTokenOptions(excludeTokenId) {
  return [...(canvas.tokens?.placeables ?? [])]
    .filter(token => token.actor && token.document.id !== excludeTokenId)
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang || undefined, { sensitivity: "base" }));
}

function chooseSkillDialog({ title, description, submitLabel }) {
  const skills = Object.entries(CONFIG.DND5E.skills ?? {}).map(([id, config]) => ({ id, label: configLabel(config, id) }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang || undefined, { sensitivity: "base" }));
  if (!skills.length) { ui.notifications.warn(game.i18n.localize("ACTION_HUD.noSkillsAvailable")); return Promise.resolve(null); }
  const skillOptions = skills.map(skill => `<option value="${foundry.utils.escapeHTML(skill.id)}">${foundry.utils.escapeHTML(skill.label)}</option>`).join("");
  const content = `<form class="ahud-action-dialog"><p>${foundry.utils.escapeHTML(description)}</p><label>${game.i18n.localize("ACTION_HUD.helpSkillLabel")}<select name="skill">${skillOptions}</select></label></form>`;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; resolve(value); };
    const dialog = new Dialog({ title, content, classes: ["ahud-dialog-window"], buttons: {
      apply: { label: submitLabel, callback: html => { const root = html?.[0] ?? html; const skillId = root?.querySelector?.('[name="skill"]')?.value; const skill = skills.find(entry => entry.id === skillId); finish(skill ? { skill: skill.id, skillLabel: skill.label } : null); } },
      cancel: { label: game.i18n.localize("ACTION_HUD.cancel"), callback: () => finish(null) }
    }, default: "apply", close: () => { hudDialogs.delete(dialog); finish(null); }, render: html => html?.[0]?.closest?.(".app.window-app")?.classList.add("ahud-dialog-window") });
    hudDialogs.add(dialog); dialog.render(true);
  });
}
function selectSceneToken(tokenId) {
  if (!game.user.isGM) return;
  const token = (canvas.tokens?.placeables ?? []).find(entry => String(entry.document.id) === String(tokenId));
  if (!token) return ui.notifications.warn(game.i18n.localize("ACTION_HUD.tokenNoLongerOnScene"));
  gmMode = false;
  token.control({ releaseOthers: true });
  refreshContext();
}

function getSceneCombat() {
  const sceneId = canvas.scene?.id;
  if (!sceneId) return null;
  const combats = [...(game.combats ?? [])];
  return combats.find(combat => (combat.scene?.id ?? combat.sceneId) === sceneId)
    ?? (game.combat && !(game.combat.scene?.id ?? game.combat.sceneId) ? game.combat : null);
}

async function getOrCreateSceneCombat() {
  let combat = getSceneCombat();
  if (combat && (combat.scene?.id == null || combat.scene.id === canvas.scene?.id)) return combat;
  const CombatDocument = CONFIG.Combat?.documentClass ?? Combat;
  combat = await CombatDocument.create({ scene: canvas.scene?.id, active: true });
  return combat;
}

async function handleGMEncounterAction(action, tokenId = null) {
  if (!game.user.isGM || !gmMode) return;
  try {
    if (action === "tracker") {
      const sidebar = ui.sidebar;
      if (sidebar) {
        sidebar.expand?.();
        // Foundry V14 hosts the Combat Tracker as a Sidebar tab; ui.combat is a legacy alias.
        if (typeof sidebar.changeTab === "function") {
          sidebar.changeTab("combat", "primary");
          const tracker = [...(sidebar.children?.values?.() ?? [])].find(child => child?.tabName === "combat" || child?.id === "combat");
          tracker?.activate?.();
          return;
        }
      }
      const tracker = ui.combat;
      if (tracker?.activate) { tracker.activate(); return; }
      if (tracker?.render) { await tracker.render(true); tracker.activate?.(); return; }
      ui.notifications.warn(game.i18n.localize("ACTION_HUD.combatTrackerUnavailable"));
      return;
    }
    if (action === "start") {
      const combat = await getOrCreateSceneCombat();
      if (combat.started) ui.notifications.info(game.i18n.localize("ACTION_HUD.combatAlreadyStarted"));
      else await combat.startCombat();
      refreshGMEncounterPanel();
      return;
    }
    if (action === "end") {
      const combat = getSceneCombat();
      if (combat?.started) await combat.endCombat();
      else ui.notifications.info(game.i18n.localize("ACTION_HUD.noActiveCombat"));
      refreshGMEncounterPanel();
      return;
    }
    if (action === "add-token" || action === "remove-token") {
      const token = (canvas.tokens?.placeables ?? []).find(entry => String(entry.document.id) === String(tokenId));
      if (!token?.actor) { ui.notifications.warn(game.i18n.localize("ACTION_HUD.tokenNoLongerOnScene")); return; }
      if (action === "add-token") {
        const combat = await getOrCreateSceneCombat();
        const existing = (combat.combatants?.contents ?? []).some(combatant => String(combatant.tokenId ?? combatant.token?.id ?? "") === String(token.document.id));
        if (existing) ui.notifications.info(game.i18n.localize("ACTION_HUD.tokensAlreadyInCombat"));
        else await combat.createEmbeddedDocuments("Combatant", [{ tokenId: token.document.id, actorId: token.actor.id, sceneId: canvas.scene.id }]);
        refreshGMEncounterPanel();
        return;
      }
      const combat = getSceneCombat();
      const combatant = (combat?.combatants?.contents ?? []).find(entry => String(entry.tokenId ?? entry.token?.id ?? "") === String(token.document.id));
      if (!combat || !combatant) ui.notifications.info(game.i18n.localize("ACTION_HUD.tokenNotInCombat"));
      else await combat.deleteEmbeddedDocuments("Combatant", [combatant.id]);
      refreshGMEncounterPanel();
      return;
    }
    if (action === "add-all" || action === "add-selected") {
      const sceneTokens = [...(canvas.tokens?.placeables ?? [])].filter(token => token.actor);
      const selectedIds = action === "add-selected" ? new Set(gmEncounterSelectedTokenIds) : null;
      const candidates = action === "add-selected"
        ? sceneTokens.filter(token => selectedIds.has(String(token.document.id)))
        : sceneTokens;
      if (!candidates.length) {
        ui.notifications.info(game.i18n.localize(action === "add-selected" ? "ACTION_HUD.selectSceneTokensToAdd" : "ACTION_HUD.noSceneTokens"));
        return;
      }
      const combat = await getOrCreateSceneCombat();
      const existingTokenIds = new Set((combat.combatants?.contents ?? []).map(combatant => String(combatant.tokenId ?? combatant.token?.id ?? "")));
      const createData = candidates.filter(token => !existingTokenIds.has(String(token.document.id))).map(token => ({
        tokenId: token.document.id, actorId: token.actor.id, sceneId: canvas.scene.id
      }));
      if (!createData.length) {
        ui.notifications.info(game.i18n.localize("ACTION_HUD.tokensAlreadyInCombat"));
      } else {
        await combat.createEmbeddedDocuments("Combatant", createData);
        if (action === "add-selected") {
          for (const token of candidates) gmEncounterSelectedTokenIds.delete(String(token.document.id));
        }
      }
      refreshGMEncounterPanel();
      return;
    }
    if (action === "remove-fallen") {
      const combat = getSceneCombat();
      const fallen = getFallenCombatants(combat);
      if (!combat || !fallen.length) {
        ui.notifications.info(game.i18n.localize("ACTION_HUD.noFallenCombatants"));
        return;
      }
      const confirmed = await Dialog.confirm({
        title: game.i18n.localize("ACTION_HUD.removeFallenConfirmTitle"),
        content: `<p>${game.i18n.format("ACTION_HUD.removeFallenConfirm", { count: fallen.length })}</p>`
      });
      if (!confirmed) return;
      await combat.deleteEmbeddedDocuments("Combatant", fallen.map(combatant => combatant.id));
      refreshGMEncounterPanel();
      return;
    }
    if (action === "add-controlled") {
      const tokens = [...(canvas.tokens?.controlled ?? [])].filter(token => token.actor);
      if (!tokens.length) { ui.notifications.info(game.i18n.localize("ACTION_HUD.selectTokensToAddCombat")); return; }
      const combat = await getOrCreateSceneCombat();
      const existing = new Set((combat.combatants?.contents ?? []).map(combatant => `${combatant.sceneId ?? combatant.scene?.id ?? ""}:${combatant.tokenId ?? combatant.token?.id ?? ""}`));
      const createData = tokens.filter(token => !existing.has(`${canvas.scene.id}:${token.document.id}`)).map(token => ({
        tokenId: token.document.id, actorId: token.actor.id, sceneId: canvas.scene.id
      }));
      if (!createData.length) ui.notifications.info(game.i18n.localize("ACTION_HUD.tokensAlreadyInCombat"));
      else await combat.createEmbeddedDocuments("Combatant", createData);
      refreshGMEncounterPanel();
      return;
    }
    const combat = getSceneCombat();
    if (!combat?.started) { ui.notifications.info(game.i18n.localize("ACTION_HUD.noActiveCombat")); return; }
    if (action === "previous") await combat.previousTurn();
    else if (action === "next") await combat.nextTurn();
    refreshGMEncounterPanel();
  } catch (error) {
    console.error(`${MODULE_ID} | Encounter control failed (${action})`, error);
    ui.notifications.error(game.i18n.localize("ACTION_HUD.encounterControlFailed"));
    refreshGMEncounterPanel();
  }
}
function numericProficiencyLevel(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(2, value));
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Math.max(0, Math.min(2, Number(value)));
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

function actorHasJackOfAllTrades(actor) {
  return Array.from(actor?.items ?? []).some(item => {
    if (item.type !== "class") return false;
    const identifier = String(item.system?.identifier ?? "").toLowerCase();
    const name = String(item.name ?? "").toLowerCase();
    const levels = Number(item.system?.levels ?? item.system?.level ?? 0);
    return (identifier === "bard" || name === "bard") && levels >= 2;
  });
}

function getCheckProficiencyLevel(actor, row, rollData = null, includeJackOfAllTrades = true) {
  const data = rollData ?? actor?.getRollData?.() ?? {};
  const system = actor?.system ?? {};
  const abilityData = data.abilities?.[row.key] ?? {};
  const systemAbility = system.abilities?.[row.key] ?? {};
  const candidates = [];
  if (row.kind === "skill") {
    const skillData = data.skills?.[row.key] ?? {};
    const systemSkill = system.skills?.[row.key] ?? {};
    candidates.push(
      numericProficiencyLevel(skillData.prof?.multiplier),
      numericProficiencyLevel(skillData.proficient),
      numericProficiencyLevel(systemSkill.value),
      numericProficiencyLevel(systemSkill.proficient),
      numericProficiencyLevel(systemSkill.prof?.multiplier)
    );
  } else {
    const detail = row.kind === "save"
      ? (abilityData.saveProf ?? systemAbility.saveProf ?? systemAbility.saveProficiency)
      : (abilityData.checkProf ?? systemAbility.checkProf ?? systemAbility.checkProficiency);
    candidates.push(
      numericProficiencyLevel(detail?.multiplier),
      numericProficiencyLevel(detail?.level),
      numericProficiencyLevel(row.kind === "save" ? systemAbility.saveProficient : systemAbility.checkProficient)
    );
  }
  const level = Math.max(0, ...candidates.filter(value => value !== null));
  // Bard's 2014/2024 Jack of All Trades grants half proficiency to ability checks
  // the actor does not already add proficiency to. It does not affect saving throws.
  if (includeJackOfAllTrades && level === 0 && row.kind !== "save" && actorHasJackOfAllTrades(actor)) return 0.5;
  return level;
}

function isDiceFormula(value) {
  return typeof value === "string" && /\d*d\d+/i.test(value);
}

function compactDiceFormula(value) {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

function proficiencyDiceIsEnabled(rollData) {
  // D&D 5e exposes `prof.term` as the active proficiency contribution:
  // a fixed number in normal mode, or a dice formula when Proficiency Dice is on.
  return isDiceFormula(rollData?.prof?.term);
}

function fallbackProficiencyDiceTerm(rollData, proficiencyLevel) {
  const baseDice = rollData?.prof?.dice;
  if (!isDiceFormula(baseDice) || !(proficiencyLevel > 0)) return null;
  const compactBase = compactDiceFormula(baseDice);
  if (proficiencyLevel === 0.5) return `floor(${compactBase}/2)`;
  const match = compactBase.match(/^(\d*)d(\d+)$/i);
  if (!match) return compactBase;
  const count = Math.max(1, Number(match[1] || 1));
  const totalDice = Math.max(1, Math.round(count * proficiencyLevel));
  return `${totalDice === 1 ? "" : totalDice}d${match[2]}`;
}

function getCheckModifier(actor, row, rollData = null) {
  const data = rollData ?? actor?.getRollData?.() ?? {};
  const system = actor?.system ?? {};
  const abilities = data.abilities ?? {};
  const abilityData = abilities[row.key] ?? {};
  const systemAbility = system.abilities?.[row.key] ?? {};
  const proficiencyDiceEnabled = proficiencyDiceIsEnabled(data);
  const proficiencyLevel = getCheckProficiencyLevel(actor, row, data);
  // Prefer the row's effective `term`, which accounts for proficiency level
  // (including expertise and half proficiency). The `.dice` field is the base
  // die regardless of context, so it is used only by the fallback below.
  const termCandidates = row.kind === "skill"
    ? [data.skills?.[row.key]?.prof?.term]
    : row.kind === "save"
      ? [abilityData.saveProf?.term]
      : [abilityData.checkProf?.term];
  const rowDiceTerm = termCandidates.find(isDiceFormula);
  const diceTerm = proficiencyDiceEnabled && proficiencyLevel > 0
    ? compactDiceFormula(rowDiceTerm ?? fallbackProficiencyDiceTerm(data, proficiencyLevel))
    : null;

  let total;
  let abilityMod;
  if (row.kind === "skill") {
    const skill = data.skills?.[row.key] ?? system.skills?.[row.key] ?? {};
    abilityMod = Number(skill.mod ?? 0) || 0;
    total = Number(skill.total);
    if (!Number.isFinite(total)) {
      const bonus = Number(skill.bonus ?? 0) || 0;
      const profFlat = Number(data.prof?.flat ?? system.attributes?.prof ?? system.prof ?? 0) || 0;
      total = abilityMod + bonus + (diceTerm ? 0 : Math.floor(profFlat * proficiencyLevel));
    }
  } else if (row.kind === "save") {
    const save = abilityData.save ?? systemAbility.save ?? {};
    const saveValue = typeof save === "number" ? save : Number(save.value);
    const saveBonus = Number(abilityData.saveBonus ?? systemAbility.saveBonus ?? 0) || 0;
    abilityMod = Number(abilityData.mod ?? systemAbility.mod ?? 0) || 0;
    // In D&D 5e 6.x the prepared save.value can already include applied item/effect
    // bonuses. Treat it as authoritative when available; adding saveBonus again can
    // double-count an equipped item's bonus (for example, +1 to all saving throws).
    // Only assemble a value from components when no finite prepared save value exists.
    if (Number.isFinite(saveValue)) total = saveValue;
    else {
      const profFlat = Number(data.prof?.flat ?? system.attributes?.prof ?? system.prof ?? 0) || 0;
      total = abilityMod + saveBonus + (diceTerm ? 0 : Math.floor(profFlat * proficiencyLevel));
    }
  } else {
    abilityMod = Number(abilityData.mod ?? systemAbility.mod ?? 0) || 0;
    const checkBonus = Number(abilityData.checkBonus ?? systemAbility.checkBonus ?? 0) || 0;
    const profFlat = Number(data.prof?.flat ?? system.attributes?.prof ?? system.prof ?? 0) || 0;
    total = abilityMod + checkBonus + (diceTerm ? 0 : Math.floor(profFlat * proficiencyLevel));
  }
  return { total, diceTerm, abilityMod, usesProficiencyDice: Boolean(diceTerm) };
}

function formatCheckModifier(modifier) {
  if (modifier?.usesProficiencyDice && modifier.diceTerm) {
    const abilityMod = Math.round(Number(modifier.abilityMod) || 0);
    const abilitySuffix = abilityMod > 0 ? `+${abilityMod}` : abilityMod < 0 ? `${abilityMod}` : "";
    return `${modifier.diceTerm}${abilitySuffix}`;
  }
  if (!Number.isFinite(modifier?.total)) return "";
  const total = Math.round(modifier.total);
  return total >= 0 ? `+${total}` : `${total}`;
}

function proficiencyMarkerInfo(level) {
  if (level >= 2) return { type: "expertise", label: "Expertise" };
  if (level >= 1) return { type: "proficient", label: "Proficient" };
  if (level > 0) return { type: "half", label: "Half proficiency" };
  return { type: "none", label: "" };
}

function renderChecksPanel(panel) {
  const actor = activeActor;
  const rollData = actor?.getRollData?.() ?? {};
  const abilities = Object.entries(CONFIG.DND5E.abilities ?? {}).map(([key, config]) => ({
    key, label: configLabel(config, key.toUpperCase()), kind: "ability"
  }));
  const skills = Object.entries(CONFIG.DND5E.skills ?? {}).map(([key, config]) => ({
    key, label: configLabel(config, key), kind: "skill"
  }));
  const groups = [
    [game.i18n.localize("ACTION_HUD.abilityChecks"), abilities],
    [game.i18n.localize("ACTION_HUD.savingThrows"), abilities.map(row => ({ ...row, kind: "save" }))],
    [game.i18n.localize("ACTION_HUD.skills"), skills]
  ];
  const canRoll = Boolean(actor && (game.user.isGM || actor.testUserPermission(game.user, "OWNER")));
  for (const [heading, rows] of groups) {
    const section = document.createElement("section"); section.className = "ahud-check-section";
    const h = document.createElement("h4"); h.textContent = heading; section.appendChild(h);
    const grid = document.createElement("div"); grid.className = "ahud-check-grid";
    for (const row of rows) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ahud-check-button";
      button.disabled = !canRoll;
      const modifier = canRoll ? getCheckModifier(actor, row, rollData) : null;
      const modifierLabel = modifier ? formatCheckModifier(modifier) : "";
      const marker = canRoll ? proficiencyMarkerInfo(getCheckProficiencyLevel(actor, row, rollData)) : { type: "none", label: "" };
      button.title = canRoll
        ? `${row.label} · ${game.i18n.localize("ACTION_HUD.rollModifier")}: ${modifierLabel}${marker.label ? ` · ${marker.label}` : ""}`
        : game.i18n.localize("ACTION_HUD.noActorSubtitle");
      const content = document.createElement("span"); content.className = "ahud-check-content";
      const proficiency = document.createElement("span");
      proficiency.className = `ahud-proficiency-marker ahud-proficiency-${marker.type}`;
      proficiency.setAttribute("aria-hidden", "true");
      if (marker.label) proficiency.title = marker.label;
      const label = document.createElement("span"); label.className = "ahud-check-label"; label.textContent = row.label;
      const bonus = document.createElement("span"); bonus.className = "ahud-check-bonus"; bonus.textContent = modifierLabel;
      content.append(proficiency, label, bonus); button.appendChild(content);
      button.addEventListener("click", async () => {
        // These are actor rolls, not token actions: intentionally available when the
        // assigned character has no token currently selected or on-screen.
        if (!actor || !(game.user.isGM || actor.testUserPermission(game.user, "OWNER"))) return;
        try {
          if (row.kind === "ability") {
            // D&D 5e 4.5+ renamed rollAbilityTest to rollAbilityCheck and removed
            // the legacy alias. Prefer the current API while retaining a fallback
            // for older systems that still expose the previous method.
            const rollAbilityCheck = actor.rollAbilityCheck ?? actor.rollAbilityTest;
            if (typeof rollAbilityCheck !== "function") {
              throw new Error("This D&D 5e actor does not expose an ability-check roll method.");
            }
            await rollAbilityCheck.call(actor, { ability: row.key });
          }
          else if (row.kind === "save") await actor.rollSavingThrow({ ability: row.key });
          else if (row.kind === "skill") await actor.rollSkill({ skill: row.key });
        } catch (error) {
          console.error(`${MODULE_ID} | Failed to roll ${row.kind}`, error);
          ui.notifications.error(game.i18n.localize("ACTION_HUD.rollFailed"));
        }
      });
      grid.appendChild(button);
    }
    section.appendChild(grid); panel.appendChild(section);
  }
}

function renderConditionsPanel(panel) {
  const conditions = document.createElement("div");
  conditions.className = "ahud-condition-list";
  panel.appendChild(conditions);
  const selected = [...(canvas.tokens?.controlled ?? [])].filter(token => token.actor);
  const conditionEntries = Object.entries(CONFIG.DND5E.conditionTypes ?? {}).sort(([, a], [, b]) => {
    const nameA = configLabel(a.name ?? a.label ?? a);
    const nameB = configLabel(b.name ?? b.label ?? b);
    return nameA.localeCompare(nameB, game.i18n.lang || undefined, { sensitivity: "base" });
  });
  for (const [id, condition] of conditionEntries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ahud-condition-button";
    button.dataset.conditionId = id;
    const icon = document.createElement("img");
    icon.src = condition.img ?? CONFIG.statusEffects?.[id]?.img ?? "icons/svg/aura.svg";
    icon.alt = "";
    icon.loading = "lazy";
    const label = document.createElement("span");
    label.textContent = configLabel(condition.name ?? condition.label ?? condition, id);
    button.append(icon, label);
    button.disabled = selected.length === 0;
    const allActive = selected.length > 0 && selected.every(token => actorHasCondition(token.actor, id));
    const anyActive = selected.some(token => actorHasCondition(token.actor, id));
    button.classList.toggle("is-active", allActive);
    button.classList.toggle("is-mixed", anyActive && !allActive);
    button.title = label.textContent;
    button.addEventListener("click", async () => {
      const tokens = [...(canvas.tokens?.controlled ?? [])].filter(token => token.actor);
      if (!tokens.length) return;
      // When several selected tokens share a linked actor, toggling that actor more than
      // once would cancel itself out. Operate once per distinct actor.
      const actors = [...new Map(tokens.map(token => [token.actor.uuid ?? token.actor.id, token.actor])).values()];
      try {
        for (const actor of actors) {
          const active = actorHasCondition(actor, id);
          await setConditionState(actor, id, !active);
        }
      } catch (error) {
        console.error(`${MODULE_ID} | Failed to toggle condition ${id}`, error);
        ui.notifications.error(game.i18n.localize("ACTION_HUD.conditionChangeFailed"));
      }
      if (!panel.hidden && panel.dataset.currentDrawer === "conditions") openDrawer("conditions", true);
    });
    conditions.appendChild(button);
  }
}
function actorHasCondition(actor, id) {
  if (!actor) return false;
  if (actor.statuses?.has?.(id)) return true;
  return (actor.effects?.contents ?? []).some(effect => effect.statuses?.has?.(id) || effect.statuses?.includes?.(id));
}
async function setConditionState(actor, id, active) {
  const levels = Number(CONFIG.DND5E.conditionTypes?.[id]?.levels);
  // D&D 5e represents levelled conditions (notably Exhaustion) with a levelled effect.
  // A negative delta of the condition's maximum level removes the condition completely.
  const options = !active && Number.isFinite(levels) && levels > 0 ? { active: false, levels: -levels } : { active };
  await actor.toggleStatusEffect(id, options);
}
function isTemporaryEffect(effect) {
  if (!effect) return false;
  // Foundry V14 exposes the canonical isTemporary getter on ActiveEffect. It also
  // recognizes native expiry events (for example start/end of a turn or rest) that
  // do not necessarily have a conventional seconds/rounds duration. Prefer that
  // signal while retaining the legacy D&D 5e/DAE fallbacks below.
  try {
    if (effect.isTemporary === true) return true;
  } catch (_) { /* Use compatibility fallbacks if the getter is unavailable. */ }
  const duration = effect.duration ?? {};
  const dnd5eTemporary = effect.getFlag?.("dnd5e", "isTemporary") ?? effect.flags?.dnd5e?.isTemporary;
  const daeDuration = effect.getFlag?.("dae", "duration") ?? effect.flags?.dae?.duration;
  const daeSpecial = effect.getFlag?.("dae", "specialDuration") ?? effect.flags?.dae?.specialDuration;
  const hasTimedDuration = [duration.seconds, duration.rounds, duration.turns, duration.remaining]
    .some(value => Number.isFinite(Number(value)) && Number(value) > 0);
  const hasDaeDuration = Number.isFinite(Number(daeDuration)) && Number(daeDuration) > 0;
  const expiresOnEvent = Array.isArray(daeSpecial) ? daeSpecial.length > 0 : typeof daeSpecial === "string" && daeSpecial.length > 0;
  return dnd5eTemporary === true || String(dnd5eTemporary).toLowerCase() === "true" || hasTimedDuration || hasDaeDuration || expiresOnEvent;
}

function renderEffectsStrip() {
  const strip = hudRoot?.querySelector("[data-effect-strip]");
  if (!strip) return;
  if (hoverTooltipState?.anchor?.closest?.("[data-effect-strip]")) closeSpellTooltip(true);
  strip.replaceChildren();
  const actor = activeActor;
  const effects = actor?.effects?.contents ?? [];
  // Permanent/passive effects are deliberately excluded. Disabled temporary effects remain
  // visible in a subdued style so users can turn them back on.
  const visible = effects.filter(isTemporaryEffect);
  strip.hidden = collapsed || !visible.length || (game.user.isGM && gmMode);
  for (const effect of visible) {
    const button = document.createElement("button"); button.type = "button"; button.className = "ahud-effect-icon";
    button.dataset.effectId = effect.id;
    button.setAttribute("aria-label", `${effect.name}${effect.disabled ? ` (${game.i18n.localize("ACTION_HUD.disabled")})` : ""}`);
    const img = document.createElement("img"); img.src = effect.img ?? "icons/svg/aura.svg"; img.alt = effect.name; button.appendChild(img);
    button.classList.toggle("is-disabled-effect", Boolean(effect.disabled));
    attachDocumentTooltip(button, effect, "effect");
    button.addEventListener("click", () => void toggleEffect(effect.id));
    strip.appendChild(button);
  }
}
async function toggleEffect(id) {
  const effect = activeActor?.effects.get(id);
  if (!effect) return;
  if (effect.disabled) await effect.update({ disabled: false });
  else await effect.update({ disabled: true });
  renderEffectsStrip();
}
async function deleteEffect(id) {
  const effect = activeActor?.effects.get(id);
  if (!effect) return;
  const confirmed = await confirmHudDialog("Remove effect?", `<p>Really remove <strong>${foundry.utils.escapeHTML(effect.name)}</strong> from ${foundry.utils.escapeHTML(activeActor.name)}?</p>`);
  if (confirmed) {
    await effect.delete();
    renderEffectsStrip();
  }
}
async function confirmHudDialog(title, content) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; resolve(value); };
    const dialog = new Dialog({
      title,
      content,
      classes: ["ahud-dialog-window"],
      buttons: {
        confirm: { label: "Confirm", callback: () => finish(true) },
        cancel: { label: "Cancel", callback: () => finish(false) }
      },
      default: "cancel",
      close: () => { hudDialogs.delete(dialog); finish(false); },
      render: html => html?.[0]?.closest?.(".app.window-app")?.classList.add("ahud-dialog-window")
    });
    hudDialogs.add(dialog);
    dialog.render(true);
  });
}
async function resetFavorites() {
  const confirmed = await confirmHudDialog("Reset favorites?", `<p>${game.i18n.localize("ACTION_HUD.resetConfirm")}</p>`);
  if (!confirmed) return;
  const doc = getConfigDocument();
  if (doc) await doc.unsetFlag(MODULE_ID, "favorites");
  renderFavorites();
}
function openSettings() {
  if (settingsDialog) {
    const existing = settingsDialog;
    settingsDialog = null;
    hudDialogs.delete(existing);
    try { existing.close(); } catch (error) { console.warn(`${MODULE_ID} | Could not close settings`, error); }
    return;
  }
  const current = Number(game.settings.get(MODULE_ID, "scale") ?? 1);
  const content = `<form class="ahud-settings"><label for="ahud-scale">${game.i18n.localize("ACTION_HUD.scale")}: <output>${Math.round(current * 100)}%</output></label><input id="ahud-scale" name="scale" type="range" min="0.7" max="1.2" step="0.05" value="${current}"><p>${game.i18n.localize("ACTION_HUD.scaleHint")}</p><button type="button" data-reset>${game.i18n.localize("ACTION_HUD.resetFavorites")}</button></form>`;
  const dialog = new Dialog({ title: "Action HUD Settings", content, classes: ["ahud-dialog-window"], buttons: { close: { label: "Close" } }, close: () => {
    hudDialogs.delete(dialog);
    if (settingsDialog === dialog) settingsDialog = null;
  }, render: html => {
    const appRoot = html?.[0]?.closest?.(".app.window-app");
    appRoot?.classList.add("ahud-dialog-window");
    const input = html[0].querySelector("input[name=scale]"); const output = html[0].querySelector("output");
    input.addEventListener("input", () => {
      const value = Number(input.value);
      output.value = `${Math.round(value * 100)}%`;
      hudRoot.style.setProperty("--ahud-scale", String(value));
      applyTooltipScale(value);
    });
    input.addEventListener("change", () => void game.settings.set(MODULE_ID, "scale", Number(input.value)));
    html[0].querySelector("[data-reset]").addEventListener("click", () => void resetFavorites());
  } });
  settingsDialog = dialog;
  hudDialogs.add(dialog);
  dialog.render(true);
}
