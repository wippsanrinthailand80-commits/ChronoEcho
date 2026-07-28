import {
  world,
  system,
  Player,
  ItemStack,
  EnchantmentType,
  MinecraftEffectTypes,
  GameMode,
} from "@minecraft/server";

/*══════════════════════════════════════════════════════════════
  RETURN BY DEATH — Re:Zero Style Time Rewind System
  ─────────────────────────────────────────────────────────────
  When a player would die, time rewinds to a safe snapshot.
  Fall deaths = perfect rewind (all items kept).
  Other deaths = imperfect rewind (4 random items lost).
  After 10 rewinds, escalating debuffs stack on each rewind.
══════════════════════════════════════════════════════════════*/

// ─── CONFIGURATION ───────────────────────────────────────────
const CONFIG = {
  MAX_SNAPSHOTS: 600,              // Ring buffer capacity (~30s at 20 tps)
  NORMAL_INTERVAL: 10,             // Snapshot every 10 ticks (0.5s) normally
  FAST_INTERVAL: 2,                // Snapshot every 2 ticks while falling fast
  FALL_VELOCITY_Y: -0.5,           // Downward velocity threshold to detect steep falls
  REWIND_SAFE_LIMIT: 10,           // Rewinds before debuffs begin
  DEBUFF_SECONDS_MIN: 20,          // Minimum random debuff duration (seconds)
  DEBUFF_SECONDS_MAX: 30,          // Maximum random debuff duration (seconds)
  TIME_STRAIN_DAMAGE: 1,           // HP removed on over-rewind penalty
  ITEMS_LOST_IMPERFECT: 4,         // Random items removed on non-fall death
  REWIND_COOLDOWN: 40,             // Ticks before another rewind can trigger
  BLINDNESS_TICKS: 20,             // Blindness duration on rewind flash (1s)
};

// ─── NEGATIVE EFFECTS POOL ──────────────────────────────────
// Every vanilla negative status effect. One is chosen at random
// when the over-rewind penalty activates (rewind count > 10).
const NEGATIVE_EFFECTS = [
  MinecraftEffectTypes.badOmen,
  MinecraftEffectTypes.blindness,
  MinecraftEffectTypes.darkness,
  MinecraftEffectTypes.fatalPoison,
  MinecraftEffectTypes.glowing,
  MinecraftEffectTypes.hunger,
  MinecraftEffectTypes.levitation,
  MinecraftEffectTypes.miningFatigue,
  MinecraftEffectTypes.nausea,
  MinecraftEffectTypes.poison,
  MinecraftEffectTypes.slowness,
  MinecraftEffectTypes.unluck,
  MinecraftEffectTypes.weakness,
  MinecraftEffectTypes.wither,
];

// ─── PER-PLAYER STATE ────────────────────────────────────────
// Keyed by player.name (gamertag, stable across sessions).
const playerStates = new Map();

function getPlayerState(name) {
  if (!playerStates.has(name)) {
    playerStates.set(name, {
      snapshots: [],             // Snapshot ring buffer
      rewindCount: 0,            // Total rewinds for this player
      lastSnapshotTick: -9999,   // Tick of last snapshot taken
      isRewinding: false,        // Mutex: prevents double-trigger
      lastHealth: 20,            // Previous tick health for backup detection
    });
  }
  return playerStates.get(name);
}

/*══════════════════════════════════════════════════════════════
  SNAPSHOT SYSTEM
  ─────────────────────────────────────────────────────────────
  Records player state at configurable intervals. During steep
  falls the sampling rate increases to capture the exact safe
  position before the player went over the edge.
══════════════════════════════════════════════════════════════*/

/** Deep-clone a single inventory slot into a plain object. */
function snapshotItem(item) {
  if (!item) return null;
  const snap = {
    typeId: item.typeId,
    amount: item.amount,
    nameTag: item.nameTag ?? null,
    enchantments: [],
  };
  try {
    const ench = item.getComponent("minecraft:enchantable");
    if (ench) {
      for (const e of ench.getEnchantments()) {
        snap.enchantments.push({ id: e.type.id, level: e.level });
      }
    }
  } catch (_) { /* item doesn't support enchantments */ }
  return snap;
}

/** Clone the entire inventory container into an array. */
function snapshotInventory(container) {
  const slots = [];
  for (let i = 0; i < container.size; i++) {
    slots.push(snapshotItem(container.getItem(i)));
  }
  return slots;
}

/** Build a full state snapshot of the player right now. */
function createSnapshot(player) {
  const healthComp = player.getComponent("minecraft:health");
  const invComp = player.getComponent("minecraft:inventory");
  const rot = player.getRotation();
  const vel = player.getVelocity();

  return {
    x: player.location.x,
    y: player.location.y,
    z: player.location.z,
    rotX: rot.x,
    rotY: rot.y,
    velY: vel.y,
    health: healthComp?.currentValue ?? 20,
    dimensionId: player.dimension.id,
    inventory: invComp?.container ? snapshotInventory(invComp.container) : [],
    tick: system.currentTick,
  };
}

/** Take a snapshot and push it into the ring buffer. */
function takeSnapshot(player) {
  const state = getPlayerState(player.name);
  state.snapshots.push(createSnapshot(player));

  // Enforce max buffer size (drop oldest)
  while (state.snapshots.length > CONFIG.MAX_SNAPSHOTS) {
    state.snapshots.shift();
  }
  state.lastSnapshotTick = system.currentTick;
}

/*══════════════════════════════════════════════════════════════
  INVENTORY RESTORATION
══════════════════════════════════════════════════════════════*/

/** Recreate an ItemStack from a snapshot, including enchantments. */
function itemFromSnapshot(snap) {
  if (!snap) return undefined;
  const item = new ItemStack(snap.typeId, snap.amount);
  if (snap.nameTag) item.nameTag = snap.nameTag;
  try {
    if (snap.enchantments?.length > 0) {
      const ench = item.getComponent("minecraft:enchantable");
      if (ench) {
        for (const e of snap.enchantments) {
          ench.addEnchantment({
            type: new EnchantmentType(e.id),
            level: e.level,
          });
        }
      }
    }
  } catch (_) { /* enchantment restore not supported on this item */ }
  return item;
}

/** Wipe and fully restore a container from a snapshot array. */
function restoreInventory(container, snapshot) {
  container.clearAll();
  for (let i = 0; i < snapshot.length && i < container.size; i++) {
    container.setItem(i, itemFromSnapshot(snapshot[i]));
  }
}

/** Fisher-Yates shuffle + clear `count` random occupied slots. */
function removeRandomItems(container, count) {
  const occupied = [];
  for (let i = 0; i < container.size; i++) {
    if (container.getItem(i)) occupied.push(i);
  }
  for (let i = occupied.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [occupied[i], occupied[j]] = [occupied[j], occupied[i]];
  }
  const toClear = occupied.slice(0, Math.min(count, occupied.length));
  for (const slot of toClear) {
    container.setItem(slot, undefined);
  }
  return toClear.length;
}

/*══════════════════════════════════════════════════════════════
  SAFE SNAPSHOT SELECTION
══════════════════════════════════════════════════════════════*/

/**
 * Pick the best snapshot to rewind to.
 *   Fall death  → last snapshot where player was NOT falling fast
 *                 (the safe cliff-top position before the plunge).
 *   Other death → most recent snapshot (closest point in time).
 */
function findSafeSnapshot(state, isFallDeath) {
  const snaps = state.snapshots;
  if (snaps.length === 0) return null;

  if (isFallDeath) {
    // Walk through snapshots; keep the latest one where velY was
    // above the fall threshold (= player was still on solid ground).
    let best = snaps[0];
    for (const s of snaps) {
      if (s.velY >= CONFIG.FALL_VELOCITY_Y) {
        best = s;
      }
    }
    return best;
  }

  // Non-fall: use the freshest snapshot available.
  return snaps[snaps.length - 1];
}

/*══════════════════════════════════════════════════════════════
  VISUAL & AUDIO REWIND EFFECT
══════════════════════════════════════════════════════════════*/

function playRewindEffect(player) {
  // Flash of blindness (dramatic blackout)
  try {
    player.addEffect(MinecraftEffectTypes.blindness, CONFIG.BLINDNESS_TICKS, {
      amplifier: 0,
      showParticles: false,
    });
  } catch (_) {}

  // Explosion particles at the rewind location
  try {
    player.dimension.spawnParticle(
      "minecraft:large_explosion",
      player.location
    );
  } catch (_) {}

  // Reverse portal particles for flavour
  try {
    player.dimension.spawnParticle(
      "minecraft:portal_reverse",
      player.location
    );
  } catch (_) {}

  // Enderman teleport sound
  try {
    player.playSound("minecraft:entity.enderman.teleport");
  } catch (_) {}
}

/*══════════════════════════════════════════════════════════════
  OVER-REWIND PENALTY  (rewind #11+)
  ─────────────────────────────────────────────────────────────
  Applies ONE random debuff (level 1–3, 20–30s) plus a "Time
  Strain" damage tick to represent the toll of bending time.
══════════════════════════════════════════════════════════════*/

function applyOverRewindPenalty(player) {
  // Pick a random debuff
  const effectType =
    NEGATIVE_EFFECTS[Math.floor(Math.random() * NEGATIVE_EFFECTS.length)];

  // Amplifier 0 = Level 1, 1 = Level 2, 2 = Level 3
  const amplifier = Math.floor(Math.random() * 3);

  // Random duration between min and max seconds (converted to ticks)
  const seconds =
    CONFIG.DEBUFF_SECONDS_MIN +
    Math.floor(
      Math.random() * (CONFIG.DEBUFF_SECONDS_MAX - CONFIG.DEBUFF_SECONDS_MIN + 1)
    );

  try {
    player.addEffect(effectType, seconds * 20, {
      amplifier,
      showParticles: true,
    });
  } catch (_) {}

  // Time Strain damage — reduce HP but never below 1 to avoid
  // triggering another immediate rewind.
  try {
    const health = player.getComponent("minecraft:health");
    if (health) {
      const newHp = Math.max(1, health.currentValue - CONFIG.TIME_STRAIN_DAMAGE);
      health.setCurrentValue(newHp);
    }
  } catch (_) {}

  // Notify the player
  const effectName = effectType.id.split(":").pop().replace(/_/g, " ");
  player.sendMessage(
    `\u00A75[Return by Death] \u00A7cTime Strain! ` +
    `Debuff: \u00A7e${effectName} ${ampToLevel(amplifier)} ` +
    `for ${seconds}s`
  );
}

/** Convert 0-indexed amplifier to display level (1-indexed). */
function ampToLevel(amp) {
  return `Lv.${amp + 1}`;
}

/*══════════════════════════════════════════════════════════════
  CORE REWIND LOGIC
══════════════════════════════════════════════════════════════*/

function triggerRewind(player, cause) {
  const state = getPlayerState(player.name);

  // Mutex — don't double-rewind if already in progress
  if (state.isRewinding) return;
  state.isRewinding = true;
  state.rewindCount++;

  const isFallDeath = cause === "fall";
  const safeSnap = findSafeSnapshot(state, isFallDeath);

  // ── No snapshot available → fall back to world spawn ──
  if (!safeSnap) {
    try {
      const sp = player.getSpawnPoint();
      if (sp) player.teleport(sp);
      else player.teleport(world.getSpawnLocation());
    } catch (_) {
      player.teleport(world.getSpawnLocation());
    }
    player.sendMessage(
      `\u00A75[Return by Death] \u00A76No memory found… rewinding to spawn.`
    );
    scheduleCooldown(state);
    return;
  }

  // ── Play dramatic rewind effect ──
  playRewindEffect(player);

  // ── Restore health to snapshot value ──
  try {
    const hp = player.getComponent("minecraft:health");
    if (hp) hp.setCurrentValue(safeSnap.health);
  } catch (_) {}

  // ── Teleport to the safe position ──
  try {
    // Attempt cross-dimension teleport if needed
    const targetDim = world.getDimension(safeSnap.dimensionId);
    if (targetDim && targetDim !== player.dimension) {
      player.teleport(
        { x: safeSnap.x, y: safeSnap.y, z: safeSnap.z },
        { dimension: targetDim }
      );
    } else {
      player.teleport({
        x: safeSnap.x,
        y: safeSnap.y,
        z: safeSnap.z,
        xRot: safeSnap.rotX,
        yRot: safeSnap.rotY,
      });
    }
  } catch (_) {
    // Fallback: teleport within current dimension
    player.teleport({
      x: safeSnap.x,
      y: safeSnap.y,
      z: safeSnap.z,
      xRot: safeSnap.rotX,
      yRot: safeSnap.rotY,
    });
  }

  // ── Inventory handling ──
  const inv = player.getComponent("minecraft:inventory");
  if (inv?.container && safeSnap.inventory.length > 0) {
    if (isFallDeath) {
      // PERFECT REWIND — all items restored
      restoreInventory(inv.container, safeSnap.inventory);
      player.sendMessage(
        `\u00A75[Return by Death] \u00A7aPerfect rewind — all items preserved.`
      );
    } else {
      // IMPERFECT REWIND — restore then lose random items
      restoreInventory(inv.container, safeSnap.inventory);
      const lost = removeRandomItems(inv.container, CONFIG.ITEMS_LOST_IMPERFECT);
      player.sendMessage(
        `\u00A75[Return by Death] \u00A7cImperfect rewind — ` +
        `${lost} item(s) lost to the void of time.`
      );
    }
  }

  // ── Over-rewind penalty (rewind #11+) ──
  if (state.rewindCount > CONFIG.REWIND_SAFE_LIMIT) {
    applyOverRewindPenalty(player);
  }

  player.sendMessage(
    `\u00A75[Return by Death] \u00A77Rewind #${state.rewindCount} complete.`
  );

  // ── Wipe snapshots so the next cycle starts fresh ──
  state.snapshots = [];

  // ── Start cooldown ──
  scheduleCooldown(state);
}

/** Release the rewind mutex after a cooldown period. */
function scheduleCooldown(state) {
  system.runTimeout(() => {
    state.isRewinding = false;
  }, CONFIG.REWIND_COOLDOWN);
}

/*══════════════════════════════════════════════════════════════
  DEATH INTERCEPTION — PRIMARY  (beforeEvents.entityHurt)
  ─────────────────────────────────────────────────────────────
  Fires BEFORE damage is applied. If the incoming damage would
  kill the player, we cancel it entirely and schedule a rewind.
══════════════════════════════════════════════════════════════*/

world.beforeEvents.entityHurt.subscribe((event) => {
  if (!(event.entity instanceof Player)) return;

  const player = event.entity;

  // Only apply in survival / adventure
  try {
    const mode = player.getGameMode();
    if (mode === GameMode.creative || mode === GameMode.spectator) return;
  } catch (_) {
    // getGameMode unavailable — assume survival
  }

  const hp = player.getComponent("minecraft:health");
  const currentHealth = hp?.currentValue ?? 20;

  // Would this damage be fatal?
  if (currentHealth <= event.damage) {
    event.cancel();

    const cause = event.damageSource?.cause ?? "unknown";

    // Defer all game-state changes to the next tick
    system.run(() => {
      triggerRewind(player, String(cause));
    });
  }
});

/*══════════════════════════════════════════════════════════════
  DEATH INTERCEPTION — BACKUP  (every-tick health monitor)
  ─────────────────────────────────────────────────────────────
  Catches any deaths that slip past beforeEvents (e.g. /kill,
  void damage edge-cases, or API quirks). Heals immediately
  and triggers rewind.
══════════════════════════════════════════════════════════════*/

function isExcluded(player) {
  try {
    const mode = player.getGameMode();
    return mode === GameMode.creative || mode === GameMode.spectator;
  } catch (_) {
    return false;
  }
}

/*══════════════════════════════════════════════════════════════
  MAIN GAME LOOP  (runs every tick)
  ─────────────────────────────────────────────────────────────
  1. Records snapshots at dynamic intervals.
  2. Monitors health as a death-detection safety net.
══════════════════════════════════════════════════════════════*/

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (isExcluded(player)) continue;

    const state = getPlayerState(player.name);

    // ── Skip snapshot/health logic while a rewind is active ──
    if (state.isRewinding) continue;

    // ── Health monitoring (backup death detection) ──
    const hp = player.getComponent("minecraft:health");
    const currentHealth = hp?.currentValue ?? 20;

    if (currentHealth <= 0) {
      // Emergency heal to prevent the death screen from appearing
      try {
        hp.setCurrentValue(20);
      } catch (_) {}

      // Determine cause from last known velocity (heuristic)
      const vel = player.getVelocity();
      const cause = vel.y < CONFIG.FALL_VELOCITY_Y ? "fall" : "unknown";
      triggerRewind(player, cause);
      continue; // skip snapshot this tick; rewind already wiped buffer
    }

    state.lastHealth = currentHealth;

    // ── Dynamic-interval snapshot recording ──
    const elapsed = system.currentTick - state.lastSnapshotTick;
    const vel = player.getVelocity();
    const falling = vel.y < CONFIG.FALL_VELOCITY_Y;
    const interval = falling ? CONFIG.FAST_INTERVAL : CONFIG.NORMAL_INTERVAL;

    if (elapsed >= interval) {
      takeSnapshot(player);
    }
  }
}, 1); // Runs every single tick

/*══════════════════════════════════════════════════════════════
  CLEANUP — remove state when a player leaves the world
══════════════════════════════════════════════════════════════*/

world.afterEvents.playerLeave.subscribe((event) => {
  // Delay cleanup so a quick relog doesn't lose rewind progress
  const name = event.playerName;
  system.runTimeout(() => {
    let stillOnline = false;
    for (const p of world.getAllPlayers()) {
      if (p.name === name) {
        stillOnline = true;
        break;
      }
    }
    if (!stillOnline) {
      playerStates.delete(name);
    }
  }, 200); // 10 seconds grace period
});

/*══════════════════════════════════════════════════════════════
  STARTUP MESSAGE
══════════════════════════════════════════════════════════════*/

world.afterEvents.worldInitialize?.subscribe?.(() => {
  // Optional: broadcast that the addon loaded
});

system.runTimeout(() => {
  world.sendMessage(
    `\u00A75[Return by Death] \u00A77The system is watching. Death is not the end.`
  );
}, 40); // 2 seconds after world load
