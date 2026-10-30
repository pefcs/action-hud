# Action HUD

A compact, customizable action HUD for Foundry VTT V14 and D&D 5e 6.x, using a blue-charcoal and teal visual style designed to complement Roll Director.

## Current stable build: 0.1.83

Spellbook, Features, and Inventory extensions now show a single horizontally scrollable row of item tiles. Hover cards align to the extension top and cap their height at the combined extension-plus-HUD height, scrolling internally when descriptions are longer.


This is the current in-world tested baseline with the Midi-QoL 14.6.5 action-usage compatibility update.

### Implemented
- Movable, lockable, collapsible HUD with persisted position and configurable 70–120% scale.
- A left-side scene-control button toggles the HUD for each client, available to both players and the GM. The Ctrl+Shift+H keybinding remains available.
- Player actor fallback when no token is selected, with favorite actions disabled until an owned token is selected.
- GM bar automatically changes to the selected token's bar on canvas selection and returns to the GM bar when the selection is cleared.
- Twelve favorite slots in two rows, including drag-and-drop from item sheets and HUD drawers, rearrangement between slots, and visible drop-target highlighting. Favorite badges show item-level limited uses and recharge state as well as D&D 5e 6.x Activity Uses pools, where configured. A brand-new empty NPC bar is auto-filled once with up to 12 prioritized combat items; existing or customized bars are never overwritten, and player-character bars are unchanged.
- Inventory Weapon Sets: three main-hand/off-hand pairs by default, with optional additional sets up to nine; drag weapons/shields to assign, click a pair to equip, and right-click a slot to remove after confirmation. Two-handed weapons visually occupy both slots, while non-weapon gear and Unarmed Strike are never changed.
- Quick Dice drawer on both player and GM bars: click d4/d6/d8/d10/d12/d20 to add or increment that die in an editable formula, choose Normal/Advantage/Disadvantage, and post the result to chat using the current chat roll visibility setting. Advantage/disadvantage applies to the first d20 term in the formula.
- Distinctive left-to-right HUD sections for HP, character statistics, favorites/tools, and spell resources.
- Circular HP globe with current/max and temporary HP, plus PC death-save pips and native death-save rolls at 0 HP.
- Class-based hit-die details grouped by die type, showing remaining/total dice per type where class data is available.
- Dynamic spell-resource globe: Spell DC in the center, Pact Magic in the inner ring, and one labelled, color-coded slot segment per regular spell slot.
- Optional Indy Dice Chronicle integration: while a recording session is active, the globe center shows a faceted d20 graphic with the latest privacy-visible natural face printed directly on it; if the module is inactive or the GM chooses No recording, Spell DC is shown instead.
- GM can click individual spell-slot segments to expend a slot or restore a used slot.
- Current Foundry token movement action is displayed; click the movement selector to change it.
- Checks and saves, feature/inventory drawers, and a compact icon-tab Spellbook with Cantrip/level/Ritual/At-Will/Innate/Additional categories, alphabetical tile layout, search, and dimming Action/Bonus Action/Reaction filters.
- Spellbook excludes explicitly unprepared leveled spells, while retaining cantrips and non-slot spellcasting methods; clicking a spell delegates to the native D&D 5e item-use workflow.
- GM Conditions popup extends upward from the bar and lists condition icons plus names; clicking toggles each condition on or off per selected actor, handling mixed states and linked actors.
- GM bar contains only Conditions, persistent settings/lock/collapse controls, token/GM switch when a token is selected, and team Short Rest / Long Rest buttons using the primary D&D 5e Party actor workflow.
- GM bar portrait uses the assigned GM character image when available, then the GM user profile image, then Foundry’s generic fallback portrait.
- A prominent Next Turn button appears to the right of the HUD during combat, with the icon and label visible together.
- Rich D&D-style description cards are available for spells, favorites, features, inventory entries, and temporary effects. Transient hover cards prefer the left side of the overall HUD; the pin button appears on the hovered item/effect tile. Multiple pinned cards may remain visible, draggable and independently closable until unpinned or the page reloads.
- The left effect strip filters out permanent/passive effects, shows temporary effects with description/duration cards, and hides while the HUD is collapsed.
- Clicking HUD Settings a second time closes the existing settings window rather than duplicating it.
- Consistent themed styling for HUD panels and settings/confirmation dialogs.
- Center-anchored movement and saved position so GM and actor bars share a center point as their widths change.
- Conditions popup spans the full HUD width and sorts localized condition names alphabetically.
- Missing non-walking movement speeds are not misreported as walking speed; no-token notices no longer affect bar width.

### Known follow-up work
- Live Foundry runtime validation of D&D 5e 6.0.6 APIs, death saves, class-specific spell DC display, hit-die summaries, movement actions, GM spell-slot adjustment, and the optional Indy Dice Chronicle session switch.
- Live Foundry validation of Spellbook tab classification and filtering, including unusual source-item and activity data.
- Configurable weapon-set labeling and further live testing of two-handed equipment and shield interactions.
- Dedicated GM macro slots, expanded bulk effect removal, and explicit Roll Director/Midi-QoL integration validation.
- Automated browser-based visual checks at Full HD and 1440p.

## Install for testing
1. Extract the `action-hud` directory into `FoundryVTT/Data/modules/`.
2. Enable **Action HUD** in the world's Manage Modules screen.
3. Reload and use the added token control or `Ctrl+Shift+H` to toggle the HUD.
4. Use the HUD settings icon to adjust scale.
5. Open Quick Dice from the dice icon beneath the favorites. Add dice with the d4/d6/d8/d10/d12/d20 buttons, edit the formula if needed, choose a d20 mode, and press Roll. The chat visibility follows Foundry's current chat roll mode.
6. As GM, select a token to switch to its actor bar. Clear the canvas selection to return to the GM bar. Click spell-slot segments to adjust remaining uses.

## Test notes
The JavaScript can be syntax-checked with `node --check src/main.js`, and the module/localization JSON can be validated with a JSON parser. Runtime behavior, D&D 5e APIs, active token switching, spell-slot updates, drag-and-drop in rendered actor sheets, and screen layout still need confirmation inside Foundry itself.


## Spellbook categories (0.1.9)

The Spellbook uses a `C` tab for cantrips, numbered tabs for spell levels, a pentagram tab for rituals, and separate At-Will, Innate, and Additional tabs. Cantrips stay in the Cantrips category even when granted by another source. Additional Spells is reserved for spells linked to non-class/subclass items or features with limited uses/charges. Always-prepared class and subclass spells remain sorted by their normal spell level. Active-effect icons are displayed in a vertical strip to the left of the HUD.


## Spellbook action indicators (0.1.10)
- Green circle: Action. Orange triangle: Bonus Action. Purple four-pointed star: Reaction. Active filters highlight matching spells rather than dimming other spells.
- Used bonus actions and reactions visually dim items whose available activities are all in a spent action category. The HUD reads Midi-QoL action tracking where available and falls back to actor flags/status effects. Clicking remains delegated to the native D&D 5e item workflow.
- Hovering an item opens an enriched D&D-style description card. Pinning keeps it visible and allows dragging; multiple cards can coexist and stay visible until individually unpinned/closed or the page reloads.


### Core Combat Actions and GM Encounter Controls (0.1.31; dropdown theme fix in 0.1.32)

The actor HUD now provides a Core Combat Actions drawer. Dodge applies Midi-QoL disadvantage on attacks against the dodging actor and D&D 5e advantage on Dexterity saves; it ends at the actor's next turn and is removed early if the actor becomes incapacitated or has no positive movement speed. Help: Attack applies Midi-QoL's `flags.midi-qol.grants.advantage.attack.all` to the selected target and consumes the mark after the first non-helper Midi-QoL attack roll against that target; otherwise it expires at the helper's next turn. Help: Skill grants advantage to one selected skill on a chosen ally, is consumed after the first matching D&D 5e skill roll, and otherwise expires at the helper's next turn. Dash, Disengage, Ready, and Search add visible temporary markers only; no movement or readied-reaction automation is attempted.

The GM bar's Encounter Controls drawer can search and select tokens on the current scene without canvas clicking, start or end combat, add currently controlled tokens, advance/rewind the turn order, and open the Combat Tracker. Favorite slots display item-level limited-use counters and recharge state, plus D&D 5e 6.x Activity Uses pools when an activity consumes that pool. These changes do not replace native item use or Midi-QoL roll workflows.
Effect icons use supplied Foundry assets for Dodge (`icons/skills/melee/shield-block-gray-orange.webp`), Help (`icons/skills/social/diplomacy-handshake.webp`), Dash (`icons/skills/movement/figure-running-gray.webp`), Disengage (`icons/skills/movement/feet-winged-boots-brown.webp`), Ready (`icons/tools/navigation/hourglass.webp`), and Search (`icons/tools/scribal/magnifying-glass.webp`). Hide rolls Stealth without creating a separate Action HUD effect, allowing existing Stealth automation to handle its marker.


### Resource counters and Features categories (0.1.36)
- Supported item uses, activity uses, and recharge indicators appear in Favorites and also on Spellbook, Features, and Inventory tiles. When an open drawer's underlying resource changes, visible counters refresh in place without resetting the current search or category.
- Features tabs are based on the actor's actual class/subclass/race/species/background items and use their images and names. Multiclass subclasses are placed next to matching classes when their D&D 5e `classIdentifier` is available. Empty categories are omitted; Other is last.
- The main HUD controls are ordered Spellbook, Inventory, Features, Combat Actions, Checks, Settings, Lock, Quick Dice, GM-only tools, and GM/token switch. Collapse is at the expanded HUD's top-left corner.


### GM Encounter Controls improvements (0.1.51)
- The GM Encounter panel shows the current scene's combat status and combatant count. Start/end and turn-navigation controls are disabled when they are not applicable.
- Scene-token list can be filtered to all tokens, combatants, or tokens not yet in combat, while search text and filter selection persist through combat changes.
- Each token row has a selection action to switch directly to that token's HUD and a separate add/remove control to manage that token in the Combat Tracker without canvas selection. Existing Add Controlled behavior remains available for bulk addition.


### GM Encounter Controls (0.1.52)
- Token rows display only the scene token name. The Open Tracker control activates the Foundry V14 Combat Tracker sidebar tab.
- Added Add All and checkbox-driven Add Selected bulk operations, plus a confirmed Remove Fallen operation. NPCs at 0 HP and explicitly defeated combatants are removed; player characters at 0 HP are preserved unless explicitly marked defeated.
