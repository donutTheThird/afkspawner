const mineflayer = require('mineflayer');
const nbt = require('prismarine-nbt');

// Config
const BOT_USERNAME = 'wacai';
const MAX_PLAYER_DISTANCE = 500;
const CHECK_INTERVAL = 7500;
const TARGET_ITEM = 'spawner';
const MC_SERVER_ADDRESS = "donutsmp.net";
const SNEAK_CHECK_INTERVAL = 50;
const MAX_CHEST_ATTEMPTS = 3;
const CHEST_INTERACTION_RANGE = 3;
const MIN_BONES_TO_COLLECT = 1;
const SELL_BONES_COMMAND = "/orders bones";
const RECONNECT_DELAY = 5000;

// Create bot instance
let bot;
let mcData;
let sneakCheckIntervalId = null;
let lastSneakCheck = Date.now();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// State management
const botState = {
  currentActivity: null,
  isBusy: false,
  emergencyMode: false,
  lastActivityChange: Date.now(),
  activityTimeout: null,
  actionQueue: [],
  processingQueue: false
};

// Add interval tracking
const intervals = {
  main: null,
  spawner: null,
  bones: null
};

// Add emergency exit flag
let emergencyExit = false;

// Initialize bot
function createBot() {
  bot = mineflayer.createBot({
    host: MC_SERVER_ADDRESS,
    port: 25565,
    username: BOT_USERNAME,
    auth: 'microsoft',
    version: '1.20',
    profilesFolder: "./auth",
  });

  setupEventHandlers();
}

// Reconnect handler
function handleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[!] Max reconnection attempts reached. Stopping bot.');
    return;
  }

  reconnectAttempts++;
  console.log(`[!] Attempting to reconnect (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  
  setTimeout(() => {
    try {
      createBot();
    } catch (err) {
      console.error('[!] Error during reconnection:', err);
      handleReconnect();
    }
  }, RECONNECT_DELAY);
}

// Setup event handlers
function setupEventHandlers() {
  bot.once('spawn', async () => {
    reconnectAttempts = 0; // Reset on successful connection
    console.log('[+] Bot spawned! Version:', bot.version);
    
    mcData = require('minecraft-data')(bot.version);
    forceSneak();
    startSneakEnforcement();
    
    bot.on('controlState', (state, enabled) => {
      if (state === 'sneak' && !enabled) {
        console.log('[SNEAK] WARNING: Sneak was disabled - forcing back on');
        setTimeout(forceSneak, 10);
      }
    });

    intervals.spawner = setInterval(checkForSpawners, 30000);
    intervals.bones = setInterval(checkInventoryForBones, 45000);
    intervals.main = setInterval(mainActivityLoop, CHECK_INTERVAL);
  });

  bot.on('login', () => {
    console.log('[+] Bot logged in!');
    forceSneak();
  });

  bot.on('error', (err) => {
    console.error('[!] Bot error:', err);
    forceSneak();
  });

  bot.on('kicked', (reason) => {
    if (emergencyExit) {
      console.log('[CRITICAL] Emergency exit completed, not reconnecting');
      return;
    }
    console.log('[!] Kicked:', reason);
    cleanupBeforeReconnect();
    handleReconnect();
  });

  bot.on('end', () => {
    if (emergencyExit) {
      console.log('[CRITICAL] Emergency exit completed, not reconnecting');
      return;
    }
    console.log('[!] Disconnected');
    cleanupBeforeReconnect();
    handleReconnect();
  });
}

function cleanupBeforeReconnect() {
  if (sneakCheckIntervalId) {
    clearInterval(sneakCheckIntervalId);
    sneakCheckIntervalId = null;
  }
  clearActivity();
}

function processQueue() {
  if (botState.emergencyMode || botState.processingQueue || botState.isBusy || botState.actionQueue.length === 0) return;


  botState.processingQueue = true;
  const nextAction = botState.actionQueue.shift();

  console.log(`[QUEUE] Processing ${nextAction.type}`);
  
  const actionPromise = (() => {
    switch(nextAction.type) {
      case 'chest': return emptyInventoryToChest();
      case 'spawner': return emptySpawner(nextAction.spawner);
      case 'sell': return sellBones();
      case 'break': return findAndBreakTargets(nextAction.player);
      default: return Promise.resolve();
    }
  })();

  actionPromise.finally(() => {
    botState.processingQueue = false;
    
    // Clean redundant actions of the same type that are no longer needed
    if (nextAction.type === 'sell') {
      // After selling bones, we don't need other sell tasks
      const removedCount = botState.actionQueue.filter(a => a.type === 'sell').length;
      botState.actionQueue = botState.actionQueue.filter(a => a.type !== 'sell');
      if (removedCount > 0) {
        console.log(`[QUEUE] Removed ${removedCount} redundant sell tasks after completing one`);
      }
    }
    
    processQueue();
  });
}

// --- Queue Management ---
function addToQueue(action) {
  // Check if an action of the same type already exists in the queue
  const isDuplicate = botState.actionQueue.some(queuedAction => 
    queuedAction.type === action.type &&
    (action.type !== 'spawner' || queuedAction.spawner.position.equals(action.spawner.position))
  );
  
  if (isDuplicate) {
    console.log(`[QUEUE] Skipping duplicate ${action.type} action`);
    return;
  }
  
  botState.actionQueue.push(action);
  console.log(`[QUEUE] Added ${action.type} to queue (${botState.actionQueue.length} items in queue)`);
  processQueue();
}

// --- Activity Management ---
function setActivity(activity) {
  if (botState.currentActivity === activity) return;
  
  clearTimeout(botState.activityTimeout);
  
  botState.currentActivity = activity;
  botState.isBusy = activity !== null;
  botState.lastActivityChange = Date.now();
  
  if (activity) {
    console.log(`[STATE] Starting activity: ${activity}`);
    botState.activityTimeout = setTimeout(() => {
      if (botState.currentActivity === activity) {
        console.error(`[STATE] Activity ${activity} timed out after 2 minutes`);
        clearActivity();
      }
    }, 120000);
  }
}

function clearActivity() {
  if (botState.currentActivity) {
    console.log(`[STATE] Clearing activity: ${botState.currentActivity}`);
  }
  clearTimeout(botState.activityTimeout);
  botState.currentActivity = null;
  botState.isBusy = false;
  botState.lastActivityChange = Date.now();
}

// --- Enhanced Sneak Enforcement System ---
function forceSneak() {
  if (!bot.getControlState('sneak')) {
    bot.setControlState('sneak', true);
    console.log('[SNEAK] Forcing sneak ON');
    lastSneakCheck = Date.now();
  }
  return true;
}

function startSneakEnforcement() {
  if (sneakCheckIntervalId) clearInterval(sneakCheckIntervalId);
  sneakCheckIntervalId = setInterval(() => {
    if (Date.now() - lastSneakCheck > 1000) {
      forceSneak();
    }
  }, SNEAK_CHECK_INTERVAL);
}

function criticalSneakOperation(callback) {
  return async (...args) => {
    const criticalInterval = setInterval(forceSneak, 20);
    let result;
    try {
      forceSneak();
      result = await callback(...args);
    } finally {
      clearInterval(criticalInterval);
      forceSneak();
    }
    return result;
  };
}

// --- Chest Handling ---
async function emptyInventoryToChest(emergency = false) {
  if (!emergency && botState.emergencyMode) return;
  if (botState.isBusy && botState.currentActivity !== 'chest') {
    console.log(`[CHEST] Currently busy with ${botState.currentActivity}, adding to queue`);
    addToQueue({ type: 'chest' });
    return;
  }

  setActivity('chest');
  
  try {
    return await criticalSneakOperation(async () => {
      const items = bot.inventory.items().filter(i => i.name === TARGET_ITEM);
      if (items.length === 0) {
        console.log(`[!] No ${TARGET_ITEM} in inventory - skipping chest check`);
        return;
      }

      let chest = bot.findBlock({
        matching: block => block.name === 'ender_chest',
        maxDistance: 30,
      });

      if (!chest) {
        console.log('[!] No chest found within 30 blocks');
        return;
      }

      let attempts = 0;
      let success = false;
      
      while (attempts < MAX_CHEST_ATTEMPTS && !success) {
        try {
          attempts++;
          console.log(`[+] Attempt ${attempts}/${MAX_CHEST_ATTEMPTS} to access chest at ${chest.position}`);
          
          const distance = bot.entity.position.distanceTo(chest.position);
          if (distance > CHEST_INTERACTION_RANGE) {
            console.log(`[+] Moving closer to chest (${distance.toFixed(1)} blocks away)`);
            await criticalSneakOperation(() => bot.lookAt(chest.position))();
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
          await criticalSneakOperation(() => bot.lookAt(chest.position.offset(0.5, 0.5, 0.5)))();
          
          const chestWindow = await criticalSneakOperation(() => bot.openChest(chest))();
          console.log(`[+] Depositing ${items.length} ${TARGET_ITEM}(s)`);
          
          for (const item of items) {
            await criticalSneakOperation(() => chestWindow.deposit(item.type, null, item.count))();
          }
          
          chestWindow.close();
          console.log('[+] Inventory emptied to chest');
          success = true;
        } catch (err) {
          console.error(`[!] Chest attempt ${attempts} failed: ${err.message}`);
          
          if (attempts < MAX_CHEST_ATTEMPTS) {
            console.log('[+] Searching for another chest...');
            chest = bot.findBlock({
              matching: block => block.name === 'chest',
              maxDistance: 30,
            });
            
            if (!chest) {
              console.log('[!] No other chest found');
              break;
            }
          }
        }
      }
    })();
  } finally {
    clearActivity();
  }
}

async function sellBones() {
  if (botState.isBusy && botState.currentActivity !== 'selling') {
    console.log(`[SELL] Currently busy with ${botState.currentActivity}, adding to queue`);
    addToQueue({ type: 'sell' });
    return;
  }

  setActivity('selling');
  
  try {
    // First verify bones exist in inventory
    const bones = bot.inventory.items().filter(item => item.name === 'bone');
    if (bones.length === 0) {
      console.log('[SELL] No bones in inventory to sell');
      return;
    }

    console.log(`[SELL] Found ${bones.length} bone stacks, attempting to sell`);
    
    // Get the bone ID from the first bone in inventory
    const boneItemId = bones[0].type;
    console.log(`[SELL] Using bone item ID: ${boneItemId}`);

    // 1. Open initial sell GUI
    bot.chat(SELL_BONES_COMMAND);
    console.log(`[SELL] Sent command: ${SELL_BONES_COMMAND}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    if (!bot.currentWindow) {
      console.log('[SELL] Failed to open initial sell GUI');
      return;
    }
    console.log('[SELL] Initial sell GUI opened');

    // 2. Set filter to "most money per item"
    for (let i = 0; i < 3; i++) {
      try {
        await bot.clickWindow(47, 0, 0);
        console.log(`[SELL] Clicked filter button (${i+1}/3)`);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        console.error('[SELL] Error clicking filter button:', err);
      }
    }

    // 3. Open delivery GUI by clicking slot 0
    try {
      await bot.clickWindow(0, 0, 0);
      console.log('[SELL] Clicked slot 0 to open delivery GUI');
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      if (!bot.currentWindow) {
        console.log('[SELL] Failed to open delivery GUI');
        return;
      }
      console.log('[SELL] Delivery GUI opened');
      
      // 4. Use window.deposit to transfer all bones at once
      const totalBones = bones.reduce((sum, stack) => sum + stack.count, 0);
      
      try {
        // Deposit all bones at once
        console.log(`[SELL] Depositing ${totalBones} bones using window.deposit()`);
        await bot.currentWindow.deposit(boneItemId, null, totalBones, null);
        console.log('[SELL] Successfully deposited all bones');
      } catch (err) {
        console.error('[SELL] Error depositing bones:', err.message);
      }
      
      // 5. Close delivery GUI to return to confirmation
      bot.closeWindow(bot.currentWindow);
      console.log('[SELL] Closed delivery GUI, waiting for confirmation');
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 6. Confirm the sale by clicking slot 15 if window still exists
      if (bot.currentWindow) {
        try {
          await bot.clickWindow(15, 0, 0);
          console.log('[SELL] Clicked confirm button (slot 15)');
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
          console.error('[SELL] Error confirming sale:', err.message);
        }
        
        // Final cleanup
        if (bot.currentWindow) {
          bot.closeWindow(bot.currentWindow);
          console.log('[SELL] Closed confirmation GUI');
        }
      }
    } catch (err) {
      console.error('[SELL] Error during delivery process:', err.message);
    }
  } catch (err) {
    console.error('[SELL] Error during selling process:', err.message);
  } finally {
    clearActivity();
  }
}

async function emptySpawner(spawnerBlock) {
  if (!spawnerBlock || spawnerBlock.name !== TARGET_ITEM) {
    console.log('[SPAWNER] Invalid spawner block');
    return;
  }

  if (botState.isBusy && botState.currentActivity !== 'emptying') {
    console.log(`[SPAWNER] Currently busy with ${botState.currentActivity}, adding to queue`);
    addToQueue({ type: 'spawner', spawner: spawnerBlock });
    return;
  }

  setActivity('emptying');

  console.log(`[SPAWNER] Starting to empty spawner at ${spawnerBlock.position}`);
  
  try {
    await criticalSneakOperation(async () => {
      forceSneak();
      const lookPos = spawnerBlock.position.offset(0.5, 0.5, 0.5);
      console.log(`[SPAWNER] Looking at ${lookPos}`);
      await bot.lookAt(lookPos);
      await new Promise(resolve => setTimeout(resolve, 500));

      const viewedBlock = bot.blockAtCursor(5);
      if (!viewedBlock || !viewedBlock.position.equals(spawnerBlock.position)) {
        console.log(`[WARN] Not looking at spawner! Looking at ${viewedBlock?.position} instead`);
        return;
      }

      console.log('[SPAWNER] Right-clicking spawner');
      
      // Try multiple right-click attempts if needed
      let clickSuccess = false;
      const MAX_CLICK_ATTEMPTS = 3;
      
      for (let attempt = 0; attempt < MAX_CLICK_ATTEMPTS && !clickSuccess; attempt++) {
        try {
          // Ensure we're looking directly at the spawner center
          await bot.lookAt(spawnerBlock.position.offset(0.5, 0.5, 0.5));
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Activate the block
          await bot.activateBlock(spawnerBlock);
          clickSuccess = true;
        } catch (clickErr) {
          console.log(`[SPAWNER] Click attempt ${attempt+1} failed: ${clickErr.message}`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      if (!clickSuccess) {
        console.log('[SPAWNER] All click attempts failed, giving up on this spawner');
        return;
      }
      
      const guiPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          bot.removeListener('windowOpen', onWindowOpen);
          console.log('[SPAWNER] Timed out waiting for GUI');
          resolve(null);
        }, 3000);

        async function onWindowOpen(initialWindow) {
          clearTimeout(timeout);
          console.log('[SPAWNER] GUI opened:', initialWindow.title);
          
          let bonesCollected = 0;
          let attempts = 0;
          const MAX_ATTEMPTS = 5;
          let currentWindow = initialWindow;
          
          // Click chest in slot 11 to reveal bones
          const slot11 = currentWindow.slots[11];
          if (slot11 && slot11.type !== -1) {
            console.log(`[SPAWNER] Clicking slot 11 (${slot11.name} x${slot11.count})`);
            try {
              await bot.clickWindow(11, 0, 0);
              await new Promise(resolve => setTimeout(resolve, 1000));
              currentWindow = bot.currentWindow;
            } catch (clickErr) {
              console.error('[SPAWNER] Error clicking slot 11:', clickErr);
            }
          }

          // Collect bones using window.withdraw
          while (attempts < MAX_ATTEMPTS && currentWindow) {
            attempts++;
            
            if (!currentWindow.slots) break;
            
            // Find all bone slots
            const boneSlots = currentWindow.slots
              .slice(0, 54)
              .filter((slot) => 
                slot && 
                slot.type !== -1 && 
                slot.name === 'bone'
              );
            
            if (boneSlots.length === 0) {
              console.log('[SPAWNER] No bones found in spawner');
              break;
            }
            
            const emptySlots = bot.inventory.emptySlotCount();
            if (emptySlots === 0) {
              console.log('[SPAWNER] Bot inventory full, cannot collect more bones');
              break;
            }
            
            // Get bone ID from first bone
            const boneItemId = boneSlots[0].type;
            
            // Calculate total bones we can collect
            const totalBones = Math.min(
              boneSlots.reduce((sum, slot) => sum + slot.count, 0),
              emptySlots * 64 // Max bones we can fit in empty slots
            );
            
            if (totalBones > 0) {
              try {
                console.log(`[SPAWNER] Withdrawing ${totalBones} bones using window.withdraw()`);
                await currentWindow.withdraw(boneItemId, null, totalBones, null);
                bonesCollected += totalBones;
                console.log(`[SPAWNER] Successfully collected ${totalBones} bones`);
                await new Promise(resolve => setTimeout(resolve, 500));
              } catch (withdrawErr) {
                console.error(`[SPAWNER] Error withdrawing bones:`, withdrawErr.message);
                
                // Fallback to clicking individual slots if withdraw fails
                console.log(`[SPAWNER] Falling back to manual slot clicking`);
                for (let i = 0; i < boneSlots.length; i++) {
                  const slot = boneSlots[i];
                  const slotIndex = currentWindow.slots.indexOf(slot);
                  if (slotIndex !== -1) {
                    try {
                      console.log(`[SPAWNER] Clicking bone slot ${slotIndex} (${slot.count}x)`);
                      await bot.clickWindow(slotIndex, 0, 0);
                      bonesCollected += slot.count;
                      await new Promise(resolve => setTimeout(resolve, 200));
                      
                      if (bot.inventory.emptySlotCount() <= 0) {
                        console.log('[SPAWNER] Inventory full, stopping collection');
                        break;
                      }
                    } catch (clickErr) {
                      console.error(`[SPAWNER] Error clicking slot ${slotIndex}:`, clickErr.message);
                    }
                  }
                }
              }
            }
            
            // After collecting bones, click slot 53 to open the arrows GUI
            console.log('[SPAWNER] Collected bones, now clicking slot 53 to open arrows GUI');
            try {
              await bot.clickWindow(53, 0, 0);
              await new Promise(resolve => setTimeout(resolve, 1500));
              
              // Check if we have a window open (arrows GUI)
              if (bot.currentWindow) {
                console.log('[SPAWNER] Arrows GUI opened, clicking slot 15 to confirm selling');
                try {
                  // Click slot 15 to confirm selling arrows
                  await bot.clickWindow(15, 0, 0);
                  console.log('[SPAWNER] Confirmed selling of arrows');
                  await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (confirmErr) {
                  console.error('[SPAWNER] Error confirming arrows sale:', confirmErr.message);
                }
              } else {
                console.log('[SPAWNER] Failed to open arrows GUI after clicking slot 53');
              }
            } catch (arrowsErr) {
              console.error('[SPAWNER] Error handling arrows GUI:', arrowsErr.message);
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
            currentWindow = bot.currentWindow;
          }
          
          console.log(`[SPAWNER] Collected total ${bonesCollected} bones`);
          
          if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow);
            console.log('[SPAWNER] Closed GUI');
          }
          
          resolve(bonesCollected);
        }

        bot.once('windowOpen', onWindowOpen);
      });

      const bonesCollected = await guiPromise;
      
      // Only check if we need to sell bones if we actually collected some
      // or if the GUI interaction failed (we'll check inventory in that case)
      if (bonesCollected === 0) {
        console.log('[SPAWNER] No bones collected from this spawner, skipping sale check');
      } else {
        // After emptying is complete, check for bones and sell only if we have enough
        const bones = bot.inventory.items().filter(item => item.name === 'bone');
        const totalBones = bones.reduce((sum, stack) => sum + stack.count, 0);
        
        if (bones.length > 0 && totalBones >= MIN_BONES_TO_COLLECT) {
          console.log(`[SPAWNER] Found ${totalBones} bones in inventory, initiating sale`);
          await sellBones();
        } else if (bones.length > 0) {
          console.log(`[SPAWNER] Found ${totalBones} bones in inventory, but below threshold of ${MIN_BONES_TO_COLLECT}`);
        } else {
          console.log('[SPAWNER] No bones found in inventory after emptying');
        }
      }
    })();
  } catch (err) {
    console.error('[SPAWNER] Error:', err);
  } finally {
    clearActivity();
    forceSneak();
  }
}

// --- Player Detection and Breaking ---
async function findAndBreakTargets(player) {
  if (botState.emergencyMode) return;
  // Player detection is CRITICAL and should bypass queue
  setActivity('breaking');
  
  try {
    await criticalSneakOperation(async () => {
      console.log(`[PLAYER] ${player.username} detected nearby, breaking spawners`);
      
      const searchArea = {
        point: player.entity.position,
        maxDistance: 20,
        matching: block => block.name === TARGET_ITEM,
        count: 20
      };
      
      const targets = bot.findBlocks(searchArea);
      console.log(`[BREAK] Found ${targets.length} spawners near player`);

      if (targets.length === 0) {
        console.log('[BREAK] No spawners found near player');
        return;
      }

      try {
        const tool = bot.inventory.items()
          .filter(i => i.name.includes('_pickaxe'))
          .sort((a, b) => {
            const toolRank = {wooden: 0, stone: 1, iron: 2, golden: 3, diamond: 4, netherite: 5};
            return toolRank[b.name.split('_')[0]] - toolRank[a.name.split('_')[0]];
          })[0];
        
        if (tool) {
          await criticalSneakOperation(() => bot.equip(tool, 'hand'))();
        }

        for (const targetPos of targets) {
          const target = bot.blockAt(targetPos);
          if (!target || target.name !== TARGET_ITEM) continue;
          
          try {
            const lookPos = target.position.offset(0.5, 0.5, 0.5);
            await criticalSneakOperation(() => bot.lookAt(lookPos))();
            
            console.log(`[BREAK] Breaking spawner at ${target.position}`);
            
            const digSneakEnforcer = setInterval(forceSneak, 10);
            const digOperation = bot.dig(target, { forceLook: true, digTimeout: 15000 });
            
            try {
              await digOperation;
              console.log(`[BREAK] Successfully broke spawner at ${target.position}`);
            } finally {
              clearInterval(digSneakEnforcer);
            }
          } catch (err) {
            console.error(`[BREAK] Failed to break spawner: ${err.message}`);
          }
        }
      } catch (err) {
        console.error('[BREAK] Error during breaking:', err);
      }
    })();
  } finally {
    clearActivity();
    
    // Immediately check if we have spawners to store in ender chest
    const spawnersInInventory = bot.inventory.items().filter(i => i.name === TARGET_ITEM).length;
    if (spawnersInInventory > 0) {
      console.log('[BREAK] Spawners collected, immediately queuing chest storage');
      addToQueue({ type: 'chest' });
    }
  }
}

// --- Periodic Checks ---
function checkForSpawners() {
  if (botState.isBusy) {
    console.log(`[CHECK] Skipping spawner check - currently ${botState.currentActivity}`);
    return;
  }

  const spawner = bot.findBlock({
    maxDistance: 5,
    matching: block => block.name === TARGET_ITEM
  });
  
  if (spawner) {
    console.log('[CHECK] Found nearby spawner, emptying');
    emptySpawner(spawner);
  }
}

function checkInventoryForBones() {
  if (botState.emergencyMode) return;
  const bones = bot.inventory.items().filter(item => item.name === 'bone');
  if (bones.length > 0) {
    console.log('[CHECK] Bones found in inventory, selling');
    sellBones();
  }
}

async function emergencyShutdownProcedure(player) {
  console.log('[CRITICAL] Starting emergency shutdown sequence');
  emergencyExit = true;
  
  // Clear all intervals and queues
  Object.values(intervals).forEach(clearInterval);
  botState.actionQueue = [];
  
  // Phase 1: Persistent spawner breaking
  await criticalSneakOperation(async () => {
    // Equip best tool first
    const tool = bot.inventory.items()
      .filter(i => i.name.includes('_pickaxe'))
      .sort((a, b) => {
        const toolRank = {wooden: 0, stone: 1, iron: 2, golden: 3, diamond: 4, netherite: 5};
        return toolRank[b.name.split('_')[0]] - toolRank[a.name.split('_')[0]];
      })[0];
    
    if (tool) await bot.equip(tool, 'hand');

    // Persistent breaking loop
    const searchArea = {
      point: player.entity.position,
      maxDistance: 20,
      matching: block => block.name === TARGET_ITEM
    };

    let attempts = 0;
    const MAX_ATTEMPTS = 30; // Prevent infinite loops
    
    while (attempts++ < MAX_ATTEMPTS) {
      const targets = bot.findBlocks(searchArea);
      if (targets.length === 0) break;

      console.log(`[CRITICAL] Found ${targets.length} spawners, breaking sequence`);
      
      for (const targetPos of targets) {
        const target = bot.blockAt(targetPos);
        if (!target || target.name !== TARGET_ITEM) continue;

        let broken = false;
        do {
          try {
            await bot.lookAt(target.position.offset(0.5, 0.5, 0.5));
            await bot.dig(target, { forceLook: true, digTimeout: 15000 });
            console.log(`[CRITICAL] Broken spawner at ${target.position}`);
            broken = true;
            
            // Wait for server state update
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Double-check if block still exists
            const updatedBlock = bot.blockAt(target.position);
            if (updatedBlock.name !== TARGET_ITEM) break;
          } catch (err) {
            console.error(`[CRITICAL] Break error: ${err.message}`);
            break;
          }
        } while (!broken);
      }
      
      // Wait before rescanning
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  })();

  // Phase 2: Immediate chest storage
  await emptyInventoryToChest(true);

  // Phase 3: Force disconnect
  console.log('[CRITICAL] Emergency procedures complete');
  emergencyExit = true;
  bot.quit();
}



function mainActivityLoop() {
  if (botState.emergencyMode || emergencyExit) return; // Add emergencyExit check

  // Check for nearby players (CRITICAL, bypasses queue)
  const nearbyPlayer = Object.values(bot.players).find(p => 
    p.entity && 
    p.username !== bot.username && 
    bot.entity.position.distanceTo(p.entity.position) <= MAX_PLAYER_DISTANCE
  );

  if (nearbyPlayer) {
    botState.emergencyMode = true;
    console.log('[CRITICAL] Player detected, initiating emergency protocol');
    
    // Clear all non-critical actions
    botState.actionQueue = [];
    clearActivity();

    emergencyShutdownProcedure(nearbyPlayer)
      .then(() => {
        console.log('[CRITICAL] Emergency procedure completed, disconnecting');
        bot.quit();
      })
      .catch(err => {
        console.error('[CRITICAL] Emergency procedure failed:', err);
        bot.quit();
      });
    return;
  }
  
}

// Initialize the bot
createBot();