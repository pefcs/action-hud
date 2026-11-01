## 0.1.86
- Reduced the white Inventory backpack SVG to 14×14 px and centered it so its visual size matches the neighboring Font Awesome toolbar icons.

## 0.1.85
- Corrected the bottom toolbar to use the D&D 5e character-sheet icons for Spells (`fa-book`), Features (`fa-list`), and Skills (`fa-briefcase`).
- Kept Inventory on the requested white D&D 5e `backpack.svg` asset.
- Corrected the toolbar order so Skills appears before Core Combat Actions.

## 0.1.84
- Replaced the bottom toolbar's Spells, Inventory, Features, and Skills icons with the corresponding D&D 5e system SVG artwork, displayed in white.
- Swapped the Skills and Core Combat Actions buttons so Core Combat Actions appears before Skills.

## 0.1.83
- Added Midi-QoL 14.6.5 `hasUsedAction(actor)` support to the item availability check. Action-activation items are now marked unavailable after Midi-QoL records the actor's Action as used, while existing bonus-action/reaction checks and compatibility fallbacks remain intact.

# Changelog

## 0.1.82
- Range checks now prefer `MidiQOL.getDistance()` when available, honoring Midi-QoL's configured distance measurement mode and fudge factor for Grapple, Help, and Shove. The previous Action HUD measurement remains as a fallback when Midi-QoL is unavailable or its API throws.

## 0.1.81
- Grapple initiation now checks the actor's unarmed reach in both 2014 and 2024 rules, using the D&D 5e actor reach value when available and falling back to 5 feet. Out-of-range attempts show the existing warning and do not start the Grapple.

## 0.1.80
- Added an Escape confirmation dialog warning that attempting to escape a Grapple consumes the character's Action. Cancelling exits without attempting Escape.
- The grappler-side Rideable-link Active Effect is now marked to expire at combat end and is explicitly removed when its combat ends.

## 0.1.79
- Removed the approximate free-hand/equipped-item eligibility check from Grapple initiation.
- Fixed the 2014/2024 Grapple defense-choice dialog callbacks resolving an out-of-scope `finish` function.

## 0.1.78
- Implemented Grapple and Escape for both 2014 and 2024 D&D 5e rules.
- Integrated Rideable grapple linking, linked Grappled effects, movement-speed handling, cleanup, and NPC GM-only roll visibility.
- Added Grapple localization strings and hardened cleanup for synthetic/unlinked token Actors.
- Corrected free-hand detection so shields occupy one hand and two-handed weapons may be held one-handed for the Grapple attempt.

## 0.1.77
- Use D&D 5e's native `systems/dnd5e/icons/svg/statuses/concentrating.svg` icon for the Ready Spell concentration parent; retain the hourglass icon for the Ready Spell marker.

## 0.1.76
- Fix localization paths for Grapple, Ready Spell, and its concentration replacement dialog.
- Represent Ready Spell as a D&D 5e-style concentrating effect plus a linked Ready Spell marker using `flags.dnd5e.dependentOn`.
- Ensure ending concentration removes the linked Ready Spell marker through the system's dependent-effect lifecycle.

## 0.1.75
- Add Ready Spell action, applying a D&D 5e concentrating status even for spells that normally do not require concentration.
- Prompt before replacing an existing concentration and use the system concentration API to end it.
- Add Grapple as a non-functional layout placeholder to the right of Shove.
- Compact Core Combat Actions tiles into five columns.

## 0.1.74
- Implemented the 2024 Shove saving throw workflow: target chooses Strength or Dexterity, rolls through Midi-QoL/native D&D 5e, and a failed save automatically applies Push or Prone.
- Coordinated modern Shove through the GM using SocketLib, with Roll Director-compatible native save handling and GM-only NPC roll visibility.

## 0.1.73
- Make NPC Shove contest rolls GM-only on whichever client Midi-QoL selects to create the roll message.
- Apply the GM whisper mode through both ChatMessage creation data and messageMode options so public roll mode cannot override it.

## 0.1.72
- Shove-related NPC roll messages are whispered to GMs only; player character rolls remain visible according to normal roll settings.
- Trust successful Midi-QoL token movement calls instead of reporting false failures from stale local coordinates.

- Stop creating a temporary public chat card for 2014 Shove coordination; carry the request through in-memory state and SocketLib/module socket payloads.
- Keep chat output limited to the final colored Success/Fail message.

## 0.1.70
- Suppress Midi-QoL's verbose contested-roll result card for 2014 Shove.
- Remove the temporary Shove request card after resolution and post only the concise colored Success/Fail result.

- Simplified the 2014 Shove result message to a single colored “Success” or “Fail” label.
- Reused the initial Shove request chat message for the final result, avoiding an extra detailed Action HUD result card.
- Removed the Cancel button from the defender’s Athletics/Acrobatics choice; dismissing that dialog defaults to Athletics rather than cancelling the Shove. The Push/Prone outcome dialog still retains Cancel.

## 0.1.68
- Declare `"socket": true` in the module manifest so SocketLib can register the Action HUD module socket.
- No Shove flow changes; this build fixes the SocketLib manifest registration error reported in 0.1.67.

## 0.1.67
- Route player-initiated 2014 Shove contests to the GM via targeted Socketlib RPC, independent of whether Midi-QoL exposes `contestedRoll` on the player client.
- Open the defender's Athletics/Acrobatics choice on the exact target controller via Socketlib and return the choice directly to the GM coordinator. The module socket remains as a fallback.
- Prefer Foundry's assigned-character link when resolving a player defender, then check explicit ownership and effective character permissions.
- Add concise routing diagnostics at the GM coordinator and defense-prompt client to aid cross-client testing.

## 0.1.66
- Fixed 2014 Shove defense prompts not reaching the target controller. The GM now resolves the defender from authoritative Actor/Token ownership before issuing the prompt, instead of trusting the initiator client's permission view.
- Explicit player ownership is honored for characters and player-controlled NPC/minion tokens; unowned NPCs route to an active GM.
- Targeted defense prompts now acknowledge delivery, and stale defender IDs in a replicated chat flag no longer silently discard a prompt sent to the correct client. Rejected prompts report a reason instead of failing silently.

## 0.1.66
- Fixed 2014 Shove defense prompts not reaching the actual target controller. The GM now recalculates the defender from authoritative Actor/Token ownership before sending the prompt, rather than trusting the initiator client's permission view.
- Prompt delivery is targeted directly to the resolved user; a stale defender ID in a replicated ChatMessage no longer silently rejects the prompt. The receiving client sends a status acknowledgement and logs any rejected request with a concrete reason.
- Explicit player ownership is honored for character and player-controlled NPC/minion tokens; unowned NPCs route to an active GM.

## 0.1.65
- Routed player-initiated 2014 Shove contests to an active GM coordinator. The GM prompts the target owner (or chooses for an NPC), then Midi-QoL routes each native roll to its appropriate user; this avoids a player client owning the cross-client contest lifecycle.
- Removed ChatMessage replication from the defense-choice response validation; responses are matched against the active socket request, preventing a race when the request message has not yet replicated.
- Added a post-Roll-Director `dnd5e.preRollSkill` safeguard that disables only the native roll-config dialog for the tagged Shove rolls while leaving Midi-QoL's advantage/disadvantage calculation and Roll Director interception intact.
- Corrected MidiQOL.moveToken usage to pass destination center coordinates rather than top-left token coordinates. Movement verification now confirms that the token moved instead of requiring a possibly incorrect exact coordinate match.

## 0.1.64
- Fixed a regression where the 2014 Shove contest could abort before Midi-QoL began rolling because one client did not acknowledge a temporary fast-forward context.
- Roll-config suppression contexts are now broadcast to connected clients without duplicating Midi-QoL's owner-routing logic or blocking the contest on a context acknowledgement.
- Kept Midi-QoL's `contestedRoll` API and Roll Director's native-roll interception in the roll path; the context remains narrow to the Shove's specific actor/skill pair and expires automatically.

## 0.1.63
- Fixed player-initiated 2014 Shove prompts by including the full request in the targeted defender-choice socket message, avoiding a race where the ChatMessage had not yet replicated.
- Added a short-lived per-actor/per-skill context on the actual rolling clients. It suppresses the D&D 5e roll-configuration dialog for Shove's Midi-QoL contested rolls while retaining Midi's roll/modifier calculation and Roll Director interception.
- Passed fast-forward options at the top-level and per side of contestedRoll, with chat diagnostics retained during testing.

## 0.1.62
- Reworked the 2014 Shove contest to use Midi-QoL's `contestedRoll` API whenever available, so source and target skill rolls are routed through their respective clients instead of relying on the initiating client's direct roll return.
- The target's controller chooses Athletics or Acrobatics automatically via a targeted prompt, then Midi-QoL handles both rolls and reports the contest result.
- Successful Shove outcomes are applied by the target's controller (or the GM for NPCs); token movement uses `MidiQOL.moveToken` when available to avoid player ownership errors.
- Kept the prior native-roll/socket path as a fallback for worlds without the Midi-QoL contested-roll API.

## 0.1.61
- The 2014 Shove defense is now prompted automatically for one active owner of the target, or for the GM when the target has no active player owner. This works even when the Chat sidebar is closed; the chat-button workflow has been removed.
- Fixed the undefined `targetTokenDocument` reference in the Shove result card, which could throw after resolving the outcome.
- Hardened the 5-foot push update and checks that the target position actually changes.

## 0.1.60
- Completed the 2014 Shove flow: the initiator rolls Strength (Athletics), then the target's owner or GM chooses Athletics or Acrobatics and rolls the defense from the chat card.
- Compares the contested results (ties favor the defender) and automatically applies Prone or pushes the target one 5-foot step away when the Shove succeeds. If permissions or the scene prevent an automatic result, the chat card reports that it must be applied manually.

## 0.1.59
- Implemented edition-aware Shove behavior using the D&D 5e Rules Version setting: 2014 uses a Strength (Athletics) check contested by the target's choice of Athletics or Acrobatics; 2024 uses the target's Strength or Dexterity saving throw against DC 8 + the actor's Strength modifier + proficiency bonus.
- For a modern-rules Monk with the Martial Arts feature, Shove DC uses Dexterity instead of Strength; explicitly legacy Martial Arts feature items do not grant the 2024 substitution.
- Updated Shove help text and range validation for the active rules version. The 2024 flow posts the save DC and outcome instructions without rolling an Athletics check; the 2014 flow retains the native Athletics roll.

## 0.1.58
- Combined Help: Attack and Help: Skill into a single Help action. Hostile targets automatically use Help: Attack, Friendly targets use Help: Skill, and Neutral/Secret targets prompt for a choice.
- Help now requires exactly one targeted creature and validates the 5-foot range for both Help modes; Help: Skill remains available outside combat.
- Added a Shove action in the freed-up tile. It requires combat, exactly one target within 5 feet, and a target no more than one size larger; it rolls the actor's native Athletics check and posts instructions for resolving the contested check and applying the selected outcome.

## 0.1.57
- Active-effect tooltips now follow the mouse cursor instead of being positioned relative to the overall HUD, preventing them from covering the active-effect strip.
- Active-effect tooltips are transient, non-interactive, and cannot be pinned; item and spell tooltips retain their existing placement and pinning behavior.

## 0.1.56
- Darkened the HUD surfaces and shifted the primary teal accent to match Roll Director's dark-mode palette.
- Uses Roll Director's `#3f7c70` accent, `#80c1b2` highlight, `#1c2427` panel, and `#252f32` raised surface colors; underlying HUD behavior is unchanged.

## 0.1.55
- Fixed the left-side HUD visibility toggle registration so it is registered early enough to appear reliably for player clients as well as the GM.
- Updated the control tool to Foundry V14's `onChange` API and added a fallback control group for clients where the Token controls group is unavailable.

## 0.1.54
- Made the Indy Dice Chronicle D20 in the mana globe interactive: left-click toggles the Stats Monitor, and right-click toggles Stats Analysis.
- Added keyboard-accessible activation and contextual tooltip guidance for both actions.

## 0.1.53
- Tightened GM Encounter token rows: scene token thumbnails are clipped in fixed 24px containers, row/button content is constrained to the available width, and darker row backplates prevent portraits from visually bleeding across adjacent controls.

## 0.1.52
- Removed the redundant actor-name subtitle from GM Encounter token rows; only the on-scene token name is shown.
- Fixed Open Tracker to activate Foundry V14's Combat Tracker sidebar tab instead of relying on the legacy ui.combat alias.
- Added bulk Add All and Add Selected operations using a separate token selection control, while preserving each token's individual add/remove button.
- Added Remove Fallen with confirmation. NPCs at 0 HP or explicitly defeated combatants are included; player characters at 0 HP are preserved unless explicitly marked defeated, allowing death-save turns to continue.

## 0.1.50
- Fixed saving-throw modifier display double-counting for some equipped item/effect bonuses. D&D 5e 6.x's prepared `save.value` is now treated as authoritative when present; `saveBonus` is only included when a prepared value is unavailable. Roll behavior is unchanged.

## 0.1.49
- Checks & Saves modifiers now reflect whether D&D 5e Proficiency Dice is enabled: normal mode shows a plain signed numeric modifier; proficiency-dice mode shows the effective proficiency dice formula plus the row's base ability modifier (for example, `1d6+2`, `2d6+3`, or `floor(1d6/2)+2` for half proficiency). Actual Foundry roll workflows are unchanged.

## 0.1.48
- Simplified Checks panel modifiers to show only the plain numeric bonus (for example, +3 or -1). Proficiency-die formulas remain part of the actual Foundry roll but are no longer appended to the HUD label.

## 0.1.47
- Fixed ability-check rolls in the Checks panel for D&D 5e 6.x by using `Actor5e.rollAbilityCheck` instead of the removed `rollAbilityTest` API. Skill checks and saving throws are unchanged; a guarded fallback remains for older systems.

## 0.1.46
- Checks & Saves now display proficiency markers using Foundry-style visual cues: filled circle for proficiency, star for expertise, and half-filled circle for half proficiency (including Bard Jack of All Trades where the system exposes it). Unproficient rows have no visible marker.
- Added the current roll modifier beside each ability check, saving throw, and skill, including numeric proficiency/bonuses and proficiency-die notation when enabled.

## 0.1.45
- Slightly enlarged the spell-slot level badges and moved them toward the start of each level section, making the level easier to associate with its slot group while preserving the ring layout and Pact Magic spacing.

## 0.1.44
- Improved spell-slot level labels with larger high-contrast circular badges, keeping them in their existing positions between the regular slot ring and outer HUD edge.
- Removed the confusing per-slot index from spell-slot hover labels; tooltips now identify the level and show available/expended status plus the remaining/max count.

## 0.1.42
- Removed the redundant "Inventory" heading from the Inventory extension so its height matches the icon-only Spellbook and Features extensions. Inventory category icons and weapon sets are unchanged.

## 0.1.41
- Spellbook, Features, and Inventory item grids now stay at one icon-row height and scroll horizontally when more items are available, instead of growing taller with the list.
- Rich hover cards for items in those extensions align their top edge with the extension top and use the combined extension-plus-HUD height as their maximum height. Short cards remain content-sized; longer cards scroll internally.

## 0.1.40
- Narrowed rich item/effect tooltip cards to about 80% of their previous default width.
- Added a lower maximum height to keep long descriptions from making cards excessively tall; metadata and description now scroll together inside the content region.
- Kept short cards content-sized so they do not stretch to fill the maximum height. Existing left-side placement, pin control, and the updated Inventory armor icon remain unchanged.

## 0.1.43
- Features and Inventory grids now sort resource-bearing items (limited uses, charges, activity-use pools, and recharge abilities) first, alphabetically within that group; items with activities but no resource pool come next; passive/ordinary entries come last.
- Spellbook ordering is unchanged.

## 0.1.39
- Moved the hover-card pin affordance to the bottom-right corner of the hovered tile, avoiding overlap with Inventory's top-right equip control.
- Updated the Inventory Equipment/Armor category icon to `icons/equipment/chest/breastplate-cuirass-steel-grey.webp` for improved readability at small sizes.

## 0.1.38
- Moved transient rich item/effect hover cards to the left side of the overall HUD when there is usable space, keeping the details away from the cursor and menu tiles. Narrow layouts fall back to a safely clamped placement.
- Moved the pin affordance out of the transient hover card and onto the item/effect tile currently being hovered. The card's own pin control remains available while pinned so it can be unpinned later; using the pin never activates the underlying item.

## 0.1.37
- Inventory consumable tiles now show a separate stack-quantity badge when quantity is greater than one, independent of the item's own uses/charges. The quantity badge is intentionally not shown on Favorites.
- Moved the Inventory tile equip toggle to the top-right corner so it no longer overlaps use/recharge indicators. Action-economy markers were shifted to the lower-left to avoid collisions with the equip and quantity badges.
- Updated Inventory category icons for Weapons, Equipment/Armor, Consumables, and Other to the supplied Foundry artwork; changed Features → Other to the supplied gold cog icon.

## 0.1.36
- Resource counters and recharge indicators are now visible in Spellbook, Features, and Inventory item tiles as well as Favorites; open drawers refresh badge values after item/resource updates without resetting search or category selection.
- Features tabs now use the actual class, subclass, race/species, and background item images and names. Multiclass tabs pair each subclass next to its class when D&D 5e's classIdentifier relationship is available; empty categories are hidden and Other remains last.
- Moved Collapse to a small button at the top-left corner of the expanded HUD and reordered the main controls: Spellbook, Inventory, Features, Combat Actions, Checks, Settings, Lock, Quick Dice, then GM-only tools and the GM/token switch.
- Kept the existing teal/charcoal styling and weapon-set toolbar behavior.

## 0.1.35
- Expanded Smarter Favorites indicators to support D&D 5e 6.x Activity Uses pools, including each pool's remaining/max count and recharge information in its tooltip.
- Item-level uses and recharge are now shown independently instead of one hiding the other.
- Stacked compact resource badges in the favorite slot; additional badges are summarized in a +N badge with a tooltip listing the remaining resources.
- The unavailable visual state now dims a slot only when all displayed resource pools are unavailable. Native item/activity use and Midi-QoL workflows remain unchanged.

## 0.1.34
- Added Inventory Weapon Sets: three paired main-hand/off-hand sets by default, with a + button to add up to nine sets.
- Drag weapons and shields from the actor sheet or Inventory drawer to assign them; right-click an assigned slot to remove it after confirmation. A two-handed weapon occupies both slots visually, including a ghost image in the off-hand.
- Clicking either slot equips the whole set, equipping its assigned weapon/shield and unequipping only other eligible weapons and shields. Unarmed Strike, focus-tagged weapons, foci, rods, rings, trinkets, armor, and other gear are not changed.
- Kept the set selector alongside Inventory category tabs, with a compact horizontally scrolling layout for additional sets and small screens.

## 0.1.33
- Updated the Dash temporary marker to `icons/skills/movement/figure-running-gray.webp` and Disengage to `icons/skills/movement/feet-winged-boots-brown.webp`.

## 0.1.32
- Fixed the Help: Skill selector dropdown contrast by explicitly styling native option/optgroup colors and enabling the dark color scheme, so the expanded list remains readable in Foundry's themed dialog.

## 0.1.31

- Updated the Dodge temporary effect icon to Foundry's shield-block artwork.
- Updated Help effects to use Foundry's diplomacy-handshake artwork.
- Updated Ready and Search marker effects to use the supplied Foundry hourglass and magnifying-glass assets.
- Hide continues to roll Stealth without creating a separate Action HUD effect; the existing Stealth automation can apply its own marker.

## 0.1.30
- Reworked Core Combat Actions into one compact 4×2 icon-and-name grid; descriptions are now shown on hover.
- Added Hide, which rolls the actor's native D&D 5e Stealth check. Search now uses a valid perception-themed effect image instead of a missing magnifying-glass SVG.
- Help: Attack and Help: Skill now use the token targeted with T on the canvas; missing, multiple, or self-targets show a warning. Help: Skill asks only which skill to assist.
- Help: Attack is combat-only and uses the target-side DAE `isAttacked` expiry with source-turn fallback; Help: Skill uses `isSkill.<skill>` expiry and can be used outside combat.
- Dodge and Disengage are combat-only. Dash, Help: Skill, Ready, Search, and Hide remain available outside combat.

## 0.1.29
- Added a Core Combat Actions drawer with Dodge (Midi-QoL incoming attack disadvantage and Dexterity-save advantage), Help: Attack, Help: Skill, and visible Ready/Search/Dash/Disengage markers.
- Help: Attack applies the corrected `flags.midi-qol.grants.advantage.attack.all` flag to the selected target, with the source helper tracked and the benefit removed after the first non-helper Midi-QoL attack roll against that target. Its DAE special duration also expires at the helper's next turn if unused.
- Help: Skill grants advantage to the chosen ally's selected skill, is consumed after the first matching D&D 5e skill roll when that hook is emitted, and otherwise expires at the helper's next turn. Dodge ends at the actor's next turn and is removed early if the actor becomes incapacitated or has no positive movement speed.
- Added GM-only Encounter Controls: search and select a token from the current scene without clicking the canvas, start/end combat, add controlled tokens to combat, step turns, and open the Combat Tracker.
- Favorites now show compact remaining-use counters and recharge indicators for supported limited-use/recharge items. Uncharged recharge abilities are dimmed and blocked from activation.
- Core-action markers apply effects to the HUD/effect strip without posting extra chat messages; Help benefits are visible through the target/ally effects.

## 0.1.28
- Added one-time NPC favorites auto-fill for a brand-new empty bar, prioritizing weapons, activated features, eligible spells, and other usable combat items up to the 12-slot limit.
- Existing or partially customized NPC bars are left unchanged; a per-actor or unlinked-token flag prevents later refreshes from repopulating a deliberately emptied bar.
- Container contents, passive traits, ordinary inventory, and non-combat items are excluded from the automatic selection. Player-character favorite behavior is unchanged.

## 0.1.27
- Fixed temporary Active Effects missing from the left-side HUD strip when they use Foundry V14's native expiry-event model. The strip now recognizes the core `ActiveEffect.isTemporary` property while retaining existing D&D 5e and DAE compatibility fallbacks.

## 0.1.26
- In GM-bar mode, show the GM’s assigned character portrait when available; otherwise use the GM user profile image, then fall back to Foundry’s generic mystery-man portrait. Actor/token portrait behavior is unchanged.

## 0.1.25
- Clear the Quick Dice formula field after a roll is successfully posted to chat, allowing the next formula to start fresh while retaining the selected Normal / Advantage / Disadvantage mode.

## 0.1.24
- Removed d100 from the Quick Dice shortcut buttons; the editable formula field remains available for custom formulas.
- Tightened the Quick Dice button sizing and kept the six standard dice buttons in a single row on wider layouts, leaving more room for the roll mode and Roll controls.

## 0.1.23
- Added a full-width Quick Dice drawer available from both player and GM HUD toolbars, including when the GM bar has no active actor.
- Added d4, d6, d8, d10, d12, d20, and d100 formula buttons; clicking a die increments its existing positive formula term or adds a new term.
- Added an editable roll formula, Normal / Advantage / Disadvantage selection, and a Roll button that posts a standard Foundry Roll to chat using the current core roll visibility setting and current actor as speaker when available.
- Advantage/disadvantage modifies only the first d20 term; all other bonus dice and modifiers are preserved.

## 0.1.22
- Refined the Indy Dice Chronicle display into a larger, faceted d20 silhouette with the rolled natural value placed directly on its central face.
- Removed the separate “Latest D20” heading from the orb to give the die more room; session gating, roll selection, tooltips, spell-slot rings, and Spell DC fallback are unchanged.

## 0.1.21
- Added optional Indy Dice Chronicle integration: during an active recording session, the mana globe center shows the latest privacy-visible d20 face on a custom die graphic; outside a running session, Spell DC display is unchanged.
- Kept the existing spell-slot rings, Pact Magic ring, and resource interactions unchanged.

## 0.1.20

- Hide items stored inside containers from the Inventory drawer, while keeping top-level containers visible. Inventory category counts now reflect only top-level items.

## 0.1.19

- Prevent unequipped weapons and equipment from being activated from the favorites bar. The slot remains draggable and its item sheet remains accessible by right-click; equipping the item restores normal use.

## 0.1.18
- Fixed actor-sheet item drag sources to use D&D 5e's draggable row (`.item-row` or `.item-name`) rather than forcing the outer `[data-item-id]` container to be draggable, which could cause Foundry's drag handler to cancel the operation.
- Preserved Foundry-compatible item drag data while also providing Action HUD's private item payload; normalized HUD drawer tiles so their child images do not start competing native image drags.
- Tooltip cards now hide temporarily during dragging without prematurely destroying the active hover state. Drag end, drop, pointer-up, Escape, and window blur reliably clear the hidden state.

## 0.1.17
- Fixed item drag-and-drop from actor sheets and HUD drawers by writing a dedicated Action HUD drag payload alongside Foundry-compatible item data, and by ensuring owned actor-sheet item rows are draggable.
- Hotbar slots can be dragged onto another slot to move or swap favorites; dragging a favorite and dropping it outside the 12-slot grid removes it.
- Added an explicit slot-drag MIME type so Foundry's canvas drop handler does not consume a drag intended to remove a favorite.

## 0.1.16
- Apply HUD scaling to tooltip cards.
- Hide cards during item dragging.
- Use compact native tooltips on favorites.

## 0.1.15
- Highlighted item images on pinned rich-description cards when the item has one or more D&D 5e activities.
- Pinned item images are clickable and invoke the native `item.use()` workflow, matching the actor sheet path for activity selection, targeting, resource consumption, and Midi-QoL integration. Unpinned cards remain informational only.
- Added localized accessible instructions for pin-to-use behavior.

## 0.1.14
- Added a compact, full-width Inventory drawer matching Spellbook and Features, with icon tabs ordered Weapons, Equipment, Consumables, Other.
- Added search and Action / Bonus Action / Reaction highlight filters to inventory tiles.
- Added equip/unequip toggles to weapons and equippable gear; the button reflects current state and updates the HUD after toggling.
- Unequipped weapons/equipment are visibly dimmed in inventory and on the favorites bar.
- Added distinct category accent colors to Class, Subclass, Racial, and Other feature tabs to harmonize with the Spellbook color language.

## 0.1.13
- Rebuilt the Features drawer as a compact, full-width, row-major icon grid matching the Spellbook and Conditions panels.
- Added icon tabs for Class, Subclass, Racial, and Other; empty categories are hidden and tabs are ordered consistently.
- Added searchable feature tiles and Action / Bonus Action / Reaction marker filters that highlight matching activities using the shared colored markers.
- Class, subclass, and racial features are categorized from item types and D&D 5e advancement-origin flags; unassociated feats and other features appear under Other.
- Preserved rich tooltips, action-use availability states, item sheet access, native item-use delegation, and drag-and-drop from feature tiles.

## 0.1.12
- Next Turn is shown only when the displayed actor is the current combatant; when a token is selected, its token ID must match the active combatant as well. Hidden on non-turns, outside combat, while collapsed, and in GM-bar mode.
- Reworked Checks & Saves into a compact, bar-width popup matching the Conditions/Spellbook layouts, with row-major grids and grouped section headings.
- Ability checks, saving throws, and skills can be rolled from the assigned/owned actor even when no token is selected or on-screen, using the native D&D 5e actor roll methods.

## 0.1.11
- Generalized the D&D-style floating description card to favorites, spell tiles, feature/inventory rows, and temporary active effects. Cards include applicable metadata and enriched descriptions; multiple pinned cards can coexist, be dragged, brought to the foreground, and individually closed/unpinned. Pinned cards remain until unpinned/closed or reload.
- Added temporary-effect filtering to the left-side effect strip, excluding passive/permanent effects while retaining disabled temporary effects so they can be re-enabled. Effect cards display descriptions, statuses, and the best available remaining-duration estimate.
- Settings now toggle: clicking the settings icon again closes the already-open window instead of opening duplicates.
- Hid active-effect icons while the HUD is collapsed, and enlarged effect icons for better visibility.
- Moved Next Turn out of the small toolbar into a prominent square button to the right of the HUD, aligned to the bottom edge and showing both icon and label during combat.
- Added localization for effect-duration metadata and Next Turn; retained Short/Long Rest, Conditions, spellbook, HP globe, movement, lock, scaling, and position behavior.

## 0.1.10
- Replaced spell action filter icons with green circle, orange triangle, and purple four-pointed star markers. Matching spells are highlighted rather than dimming non-matches.
- Detect and visually dim bonus-action/reaction items when that resource is already used, using Midi-QoL APIs, flags, and status-effect fallbacks. Applied to favorites, feature/inventory lists, and spell tiles without blocking the native roll workflow.
- Added D&D-styled spell description cards with spell level/school, casting time, range, duration, components, concentration/ritual tags, enriched description text, pin/unpin, and draggable positioning while pinned. Cards close with actor/token context changes and are not persisted across reloads.

- Changed Spellbook category marks: Cantrips use a clear `C`, spell-level tabs use simple numbers 1–9, and Rituals use a custom pentagram SVG that does not require a premium icon font.
- Reclassified cantrips into the Cantrips tab regardless of source; charge/uses-based cantrips can also appear in Additional Spells, but are never duplicated into leveled spell tabs.
- Additional Spells now only includes spells linked to a non-class/subclass item or feature with configured uses/charges (or the spell itself has uses); these limited-use leveled spells do not also appear in a spell-slot level tab. Class/subclass spells, including always-prepared subclass spells, remain in their normal spell-level tab.
- Moved active-effect icons from above the HUD to a vertical strip on the left side, leaving the top of the HUD available for future panels.

## 0.1.8
- Rebuilt the Spellbook as a compact, bar-width popup with icon tabs ordered Cantrips, available spell levels, Rituals, At-Will, Innate Spellcasting, and Additional Spells. Empty categories are hidden and tab tooltips show their full names.
- Added alphabetical, row-major spell tiles, spell search, and Action / Bonus Action / Reaction filters that dim non-matching spells without hiding them.
- Fixed spell availability for D&D 5e 6.x: unprepared leveled spells are omitted while cantrips and non-slot methods (At-Will, Innate, Ritual) remain visible.
- Spell tile clicks invoke the native Item use workflow so activity selection, targeting, resource consumption, and Midi-QoL integrations stay in the existing pipeline. Without an active token, clicking opens the spell sheet instead.

## 0.1.7
- Restored true horizontal centering for the GM Short Rest and Long Rest icon/label groups, preventing the labels from appearing left-heavy inside their buttons.
- All HUD popups now close when the selected actor/token set or GM-vs-actor context changes, including drawers, movement selection, settings, and confirmation dialogs.
- Fixed HP globe fill geometry: the liquid now uses a full-size clipped layer so its fill level follows current/max HP cleanly inside the circular boundary.

## 0.1.6
- Fixed the GM team-rest button labels by placing Short Rest and Long Rest localization keys in the correct namespace; constrained button label flex sizing so the readable labels fit beside their icons.
- Made the Conditions popup content-height rather than viewport-height, with a compact four-column grid on desktop and three/two columns on smaller viewports.
- Reduced condition row height, icon size, and spacing while retaining localized alphabetical row-major order and per-token toggle state.

## 0.1.5
- Fixed GM team-rest button overflow by using compact visible labels and constraining button text to the available width.
- Expanded the GM Conditions popup to exactly match the HUD bar width and sorted conditions alphabetically by their localized names in row-major order.
- Changed drag positioning and persistence to use the horizontal center anchor, so GM and actor bars share the same screen center even when their widths differ. Migrates existing saved top-left positions.
- Prevented the no-token notice from participating in the HUD's flex sizing, so it wraps above the bar without making the player HUD excessively wide.
- Movement speed display no longer falls back to walking speed for absent specific movement speeds such as flying; missing speeds are left blank in the menu and shown as an em dash in the selected-mode badge.

## 0.1.4
- Positioned the movement-action menu above the character panel so it remains visible when the HUD is anchored at the bottom of the screen.
- Rotated the movement selector caret while the menu is open.

## 0.1.3
- Removed Active Effects from the player action toolbar; active effects remain accessible through the effect icon strip above the HUD.
- Replaced the GM Effects tool with a Conditions popup that extends upward from the HUD to the top of the viewport. Conditions display only their icon and name.
- Condition clicks now toggle each selected actor independently, including mixed states; linked actors are only toggled once, and levelled conditions such as Exhaustion are removed fully when toggled off.
- The GM toolbar hides actor-only tools and keeps Conditions plus Settings, Lock, and Collapse. The GM/token mode switch appears only while a token is selected.
- Added Team Short Rest and Team Long Rest buttons in the right-hand resource section, invoking the primary D&D 5e Party actor's native rest workflow/dialog.

## 0.1.2
- Reworked the character bar into distinct left-to-right sections: HP globe, character/movement information, favorites with tools beneath, and spell-slot globe.
- Added an HP globe with current/max HP, temporary HP, and PC death-save success/failure pips when at 0 HP; clicking rolls a death save through the native D&D 5e method.
- Added class-based hit-die summaries by die size, showing remaining/total for each type.
- Added the circular spell-slot display with a blue Spell DC center, an inner Pact Magic ring, and an outer level-colored ring divided into individual spell slots.
- GM can click an available slot to expend it or an expended slot to restore it. Each spell level is separated and labelled on the ring.
- Added a movement-action selector to the character panel, showing the token's actual selected Foundry movement action and an estimated matching movement speed.
- GM HUD now automatically switches to a selected token's actor HUD and returns to the GM bar when the canvas selection is cleared.
- Preserved configurable scaling, locking, position persistence, favorites and Roll Director-compatible styling.

## 0.1.1
- Reworked HUD and popup styling to match Roll Director’s blue-charcoal and teal palette.
- Moved HUD tools into a compact horizontal row beneath the character panel and favorites.
- Clarified the player state when an owned/assigned character exists but no token is selected.
- Fixed D&D 5e configuration-object labels in ability checks and saving throws.
- Added category filters and grouped headings for spells, features, and inventory.
- Added highlighted favorite drop targets during drag-and-drop.
- Added compact active-effect icons above the HUD; left-click toggles effects and right-click requests removal confirmation.
- Restricted condition controls to the GM status-effect panel and added bulk application to selected tokens.
- Added shared styling to the HUD settings popup.
- Improved no-results and disabled-action hints.

## 0.1.0
- Initial foundation build with a movable, lockable, scalable HUD and 12 favorite slots.
- Added initial actor context, GM mode, drawers, and character resource display.

## 0.1.51
- Improved GM Encounter Controls with live combat status, context-aware control states, and All / In Combat / Not in Combat filters.
- Added per-token add/remove controls so the GM can manage combatants directly from the scene-token list without selecting tokens on the canvas. Search and filter state survive panel refreshes.


## 0.1.87
- Added an external actor-readout slot below Hit Dice in the character identity area.
- Added a refresh hook for third-party readout providers.
- Exposed `api.refreshExternalReadouts()` for integrations such as Stealth Observer.
