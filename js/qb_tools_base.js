// ==UserScript==
// @name         QBTools
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  QB工具集 - 游戏数据同步与资源管理
// @author       You
// @match        http://gold.pfpmc.top:48018/*
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // API地址
    const API_URL = 'http://gold.pfpmc.top:48018/api/gamedata';
    // localStorage键名
    const STORAGE_KEY = 'items';
    const GAMEDATA_STORAGE_KEY = 'gamedata';
    const MONSTER_STORAGE_KEY = 'monsters';
    const COMBAT_AREA_STORAGE_KEY = 'combatAreas';
    const WS_FILTER_KEY = 'qbtools_ws_filter';
    const FAVORITE_ITEMS_KEY = 'qbtools_favorite_items';
    const PLAYER_INVENTORY_KEY = 'qbtools_player_inventory';
    const MARKET_OVERVIEW_STORAGE_KEY = 'qbtools_market_overview';
    const TOOL_DATA_STORAGE_KEY = 'qbtools_tool_data';
    const PRODUCTION_COMBAT_AREA_NAME_KEY = 'qbtools_production_combat_area_name';

    const PAGE_WINDOW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const OriginalWebSocket = PAGE_WINDOW.WebSocket;
    const wsInstances = new Set();
    const wsLogBuffer = [];
    let wsMonitorEnabled = true;
    const ITEM_CONFIG_DB_NAME = 'qbtools_config_db';
    const ITEM_CONFIG_DB_VERSION = 2;
    const ITEM_CONFIG_STORE = 'item_image_configs';
    const MONSTER_CONFIG_STORE = 'monster_image_configs';
    const itemIconReplacementMap = new Map();
    let cachedItemsData = {};
    let cachedMonstersData = {};
    let itemIconObserver = null;
    let battlefieldMonsterAreaObserver = null;
    let marketOverviewRafId = 0;
    let marketItemsCacheRaw = '';
    let marketItemsNameIdMapCache = new Map();
    let marketCategoryFavoriteRefreshBound = false;
    let marketFavoriteTableSortState = { key: '', direction: 'asc' };
    let marketOtherTableSortState = { key: '', direction: 'asc' };
    let autoCombatInProgress = false;
    const itemEditorState = {
        selectedItem: null,
        selectedImageBlob: null,
        selectedImageObjectUrl: '',
    };
    const monsterEditorState = {
        selectedMonster: null,
        selectedImageBlob: null,
        selectedImageObjectUrl: '',
    };
    /** isObjectRecord: function */
    function isObjectRecord(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    /** hasObjectEntries: function */
    function hasObjectEntries(value) {
        return isObjectRecord(value) && Object.keys(value).length > 0;
    }

    /** readStorageJson: function */
    function readStorageJson(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (error) {
            return fallback;
        }
    }

    /** writeStorageJson: function */
    function writeStorageJson(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    /** extractItemsData: function */
    function extractItemsData(data) {
        if (!isObjectRecord(data)) {
            return {};
        }
        if (isObjectRecord(data.items)) {
            return data.items;
        }
        return data;
    }

    /** getToolTypeFromSlot: function */
    function getToolTypeFromSlot(slot) {
        if (typeof slot !== 'string') {
            return '';
        }
        const normalizedSlot = slot.trim();
        if (!normalizedSlot) {
            return '';
        }
        return normalizedSlot.endsWith('_tool')
            ? normalizedSlot.slice(0, -5)
            : normalizedSlot;
    }

    /** buildToolDataCache: function */
    function buildToolDataCache(itemsData) {
        const toolsBySlot = {};
        let totalTools = 0;

        if (!isObjectRecord(itemsData)) {
            return {
                totalTools: 0,
                totalCategories: 0,
                toolsBySlot: {},
                updatedAt: new Date().toISOString(),
            };
        }

        Object.entries(itemsData)
            .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
            .forEach(([itemKey, item]) => {
                if (!isObjectRecord(item) || item.type !== 'tool') {
                    return;
                }

                const itemId = String(item.id || itemKey);
                const slot = typeof item.slot === 'string' ? item.slot.trim() : '';
                if (!slot) {
                    return;
                }

                const toolType = getToolTypeFromSlot(slot);
                if (!toolsBySlot[slot]) {
                    toolsBySlot[slot] = {
                        slot,
                        toolType,
                        tools: {},
                    };
                }

                toolsBySlot[slot].tools[itemId] = {
                    id: itemId,
                    name: String(item.name || itemId),
                    slot,
                    toolType,
                    stats: isObjectRecord(item.stats) ? item.stats : {},
                };
                totalTools += 1;
            });

        return {
            totalTools,
            totalCategories: Object.keys(toolsBySlot).length,
            toolsBySlot,
            updatedAt: new Date().toISOString(),
        };
    }

    /** updateToolDataCache: function */
    function updateToolDataCache() {
        try {
            const itemsData = readStorageJson(STORAGE_KEY, null) || getGameData();
            if (!hasObjectEntries(itemsData)) {
                updateStatus('未找到物品数据，请先更新游戏数据');
                return false;
            }

            const toolDataCache = buildToolDataCache(itemsData);
            writeStorageJson(TOOL_DATA_STORAGE_KEY, toolDataCache);
            updateStatus(`工具数据已更新，共 ${toolDataCache.totalCategories} 类 ${toolDataCache.totalTools} 个工具`);
            return true;
        } catch (error) {
            console.error('Failed to update tool data cache:', error);
            updateStatus('更新工具数据失败');
            return false;
        }
    }

    /**
     * 从API获取游戏数据
     * @returns {Promise<Object|null>} 游戏数据或null
     */
    async function fetchGameData() {
        try {
            console.log('正在获取游戏数据...');
            const response = await fetch(API_URL);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            console.log('游戏数据获取成功');
            return data;
        } catch (error) {
            console.error('获取游戏数据失败:', error);
            return null;
        }
    }

    /**
     * 保存游戏数据到localStorage
     * @param {Object} data - 游戏数据
     */
    /** saveGameData: function */
    function saveGameData(data) {
        try {
            // 仅存储items对象
            const gameData = isObjectRecord(data) ? data : {};
            writeStorageJson(GAMEDATA_STORAGE_KEY, gameData);
            const itemsData = extractItemsData(gameData);
            writeStorageJson(STORAGE_KEY, itemsData);
            const monstersData = gameData.monsters || gameData.monster || {};
            writeStorageJson(MONSTER_STORAGE_KEY, monstersData);
            const combatAreasData = gameData.combatAreas || {};
            writeStorageJson(COMBAT_AREA_STORAGE_KEY, combatAreasData);
            console.log('游戏数据已保存到localStorage');
            updateStatus('数据已更新');

            // 数据更新后重新显示物品列表
            displayItemsList();
            displayMonstersList();
            renderRecipeDataTable();
            renderMonsterWeightDataTable();
            populateProductionCombatAreaOptions();
        } catch (error) {
            console.error('保存游戏数据失败:', error);
            updateStatus('保存失败');
        }
    }

    /**
     * 从localStorage获取游戏数据
     * @returns {Object|null} 游戏数据或null
     */
    /** getGameData: function */
    function getGameData() {
        try {
            const gameData = readStorageJson(GAMEDATA_STORAGE_KEY, null);
            if (isObjectRecord(gameData)) {
                const gameItemsData = extractItemsData(gameData);
                if (hasObjectEntries(gameItemsData)) {
                    return gameItemsData;
                }
            }

            const itemsData = readStorageJson(STORAGE_KEY, null);
            if (isObjectRecord(itemsData)) {
                return itemsData;
            }

            return null;
        } catch (error) {
            console.error('读取游戏数据失败:', error);
            return null;
        }
    }

    /** getStoredGameData: function */
    function getStoredGameData() {
        return readStorageJson(GAMEDATA_STORAGE_KEY, null);
    }

    /** syncMonsterWeightSourceCache: function */
    function syncMonsterWeightSourceCache(gameData) {
        const storedGameData = isObjectRecord(gameData) ? gameData : {};
        const monstersData = isObjectRecord(storedGameData.monsters)
            ? storedGameData.monsters
            : (isObjectRecord(storedGameData.monster) ? storedGameData.monster : null);
        const combatAreasData = isObjectRecord(storedGameData.combatAreas)
            ? storedGameData.combatAreas
            : null;

        if (monstersData) {
            writeStorageJson(MONSTER_STORAGE_KEY, monstersData);
        }
        if (combatAreasData) {
            writeStorageJson(COMBAT_AREA_STORAGE_KEY, combatAreasData);
        }

        return {
            monsters: monstersData || readStorageJson(MONSTER_STORAGE_KEY, {}),
            combatAreas: combatAreasData || readStorageJson(COMBAT_AREA_STORAGE_KEY, {}),
        };
    }

    /** formatConsumableEffect: function */
    function formatConsumableEffect(effect, statusEffects) {
        if (!isObjectRecord(effect)) {
            return '未知效果';
        }

        const resourceType = effect.resourceType || 'hp';
        if (Object.prototype.hasOwnProperty.call(effect, 'value')) {
            return `${effect.value}${resourceType}`;
        }
        if (Object.prototype.hasOwnProperty.call(effect, 'percent')) {
            return `${(Number(effect.percent) * 100).toFixed(1)}%${resourceType}`;
        }
        if (effect.statusEffectId) {
            const statusEffectId = String(effect.statusEffectId);
            const statusEffect = isObjectRecord(statusEffects) ? statusEffects[statusEffectId] : null;
            if (isObjectRecord(statusEffect)) {
                const name = statusEffect.name || '未知状态';
                const durationSeconds = Number(statusEffect.duration || 0) / 1000;
                return `${durationSeconds}s${name}`;
            }
            return statusEffectId;
        }

        return '未知效果';
    }

    /** formatConsumableRecipe: function */
    function formatConsumableRecipe(itemName, recipes, allItems) {
        if (!itemName || !isObjectRecord(recipes)) {
            return '';
        }

        const recipe = Object.values(recipes).find((recipeInfo) => (
            isObjectRecord(recipeInfo) && recipeInfo.name === itemName
        ));
        if (!isObjectRecord(recipe)) {
            return '';
        }

        const inputs = recipe.actionConfig?.inputs;
        if (!Array.isArray(inputs)) {
            return '';
        }

        return inputs
            .map((inputItem) => {
                if (!isObjectRecord(inputItem) || !inputItem.id) {
                    return '';
                }

                const itemId = String(inputItem.id);
                let quantity = inputItem.quantity ?? 1;
                if (Array.isArray(quantity)) {
                    quantity = quantity.length ? quantity[0] : 1;
                }

                const ingredient = isObjectRecord(allItems?.[itemId]) ? allItems[itemId] : null;
                const ingredientName = ingredient?.name || itemId;
                return `${ingredientName}x${quantity}`;
            })
            .filter(Boolean)
            .join('，');
    }

    /** buildConsumableRecipeRows: function */
    function buildConsumableRecipeRows(gameData) {
        const statusEffects = isObjectRecord(gameData?.statusEffects) ? gameData.statusEffects : {};
        const recipes = isObjectRecord(gameData?.recipes) ? gameData.recipes : {};
        const allItems = isObjectRecord(gameData?.items) ? gameData.items : {};
        const groups = {
            tradable: [],
            nonTradable: [],
        };

        Object.values(allItems).forEach((itemInfo) => {
            if (!isObjectRecord(itemInfo) || itemInfo.type !== 'consumable') {
                return;
            }

            const targetRows = itemInfo.isTradable ? groups.tradable : groups.nonTradable;
            const variants = [itemInfo];
            if (isObjectRecord(itemInfo.qualityOverrides)) {
                Object.values(itemInfo.qualityOverrides).forEach((qualityInfo) => {
                    if (!isObjectRecord(qualityInfo)) {
                        return;
                    }
                    variants.push({
                        ...itemInfo,
                        ...(qualityInfo.name ? { name: qualityInfo.name } : {}),
                        ...(Array.isArray(qualityInfo.effects) ? { effects: qualityInfo.effects } : {}),
                        ...(Object.prototype.hasOwnProperty.call(qualityInfo, 'cooldown') ? { cooldown: qualityInfo.cooldown } : {}),
                    });
                });
            }

            variants.forEach((variant) => {
                const name = variant.name || '未知名称';
                const effects = Array.isArray(variant.effects) ? variant.effects : [];
                targetRows.push({
                    name,
                    effectText: effects.map((effect) => formatConsumableEffect(effect, statusEffects)).join('，'),
                    ingredients: formatConsumableRecipe(name, recipes, allItems),
                    cooldownText: `${Number(variant.cooldown || 0) / 1000}秒`,
                });
            });
        });

        return groups;
    }

    /** appendRecipeTableSection: function */
    function appendRecipeTableSection(container, title, rows) {
        const sectionTitle = document.createElement('h4');
        sectionTitle.className = 'qbtools-data-section-title';
        sectionTitle.textContent = title;
        container.appendChild(sectionTitle);

        const tableWrap = document.createElement('div');
        tableWrap.className = 'qbtools-data-table-wrap';

        const table = document.createElement('table');
        table.className = 'qbtools-data-table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        ['食物名称', '效果', '食材', '使用CD'].forEach((label) => {
            const th = document.createElement('th');
            th.textContent = label;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        rows.forEach((row) => {
            const tr = document.createElement('tr');
            [row.name, row.effectText, row.ingredients, row.cooldownText].forEach((value) => {
                const td = document.createElement('td');
                td.textContent = value || '';
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        if (!rows.length) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 4;
            td.className = 'qbtools-empty-cell';
            td.textContent = '暂无数据';
            tr.appendChild(td);
            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        tableWrap.appendChild(table);
        container.appendChild(tableWrap);
    }

    /** buildMonsterWeightSections: function */
    function buildMonsterWeightSections(gameData) {
        const { monsters, combatAreas } = syncMonsterWeightSourceCache(gameData);
        if (!isObjectRecord(monsters) || !isObjectRecord(combatAreas)) {
            return [];
        }

        return Object.entries(combatAreas)
            .filter(([, area]) => isObjectRecord(area))
            .map(([areaId, area]) => {
                const monsterIds = Array.isArray(area.monsters)
                    ? area.monsters.map((monsterId) => String(monsterId)).filter(Boolean)
                    : [];
                if (area.bossId) {
                    monsterIds.push(String(area.bossId));
                }

                const rows = monsterIds.map((monsterId) => {
                    const monsterInfo = isObjectRecord(monsters[monsterId]) ? monsters[monsterId] : {};
                    const spawnWeight = Number(monsterInfo.spawnWeight || 0);
                    return {
                        id: monsterId,
                        name: String(monsterInfo.name || monsterId),
                        spawnWeight: Number.isFinite(spawnWeight) ? spawnWeight : 0,
                    };
                });
                const totalWeight = rows.reduce((sum, row) => sum + Math.max(row.spawnWeight, 0), 0);

                return {
                    id: areaId,
                    name: String(area.name || areaId),
                    rows: rows.map((row) => ({
                        name: row.name,
                        probabilityText: totalWeight > 0
                            ? `${((Math.max(row.spawnWeight, 0) / totalWeight) * 100).toFixed(2)}%`
                            : '0.00%',
                    })),
                };
            });
    }

    /** appendMonsterWeightTableSection: function */
    function appendMonsterWeightTableSection(container, title, rows) {
        const sectionTitle = document.createElement('h4');
        sectionTitle.className = 'qbtools-data-section-title qbtools-monster-weight-title';
        sectionTitle.textContent = title;
        container.appendChild(sectionTitle);

        const tableWrap = document.createElement('div');
        tableWrap.className = 'qbtools-data-table-wrap';

        const table = document.createElement('table');
        table.className = 'qbtools-data-table qbtools-monster-weight-table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        ['怪物名', '生成概率'].forEach((label) => {
            const th = document.createElement('th');
            th.textContent = label;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        rows.forEach((row) => {
            const tr = document.createElement('tr');
            [row.name, row.probabilityText].forEach((value) => {
                const td = document.createElement('td');
                td.textContent = value || '';
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        if (!rows.length) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 2;
            td.className = 'qbtools-empty-cell';
            td.textContent = '暂无数据';
            tr.appendChild(td);
            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        tableWrap.appendChild(table);
        container.appendChild(tableWrap);
    }

    /** appendMonsterWeightSections: function */
    function appendMonsterWeightSections(container, gameData) {
        const sections = buildMonsterWeightSections(gameData);
        if (!sections.length) {
            const empty = document.createElement('div');
            empty.className = 'qbtools-data-empty';
            empty.textContent = '暂无副本怪物权重数据';
            container.appendChild(empty);
            return;
        }

        sections.forEach((section) => {
            appendMonsterWeightTableSection(container, section.name, section.rows);
        });
    }

    /** renderMonsterWeightDataTable: function */
    function renderMonsterWeightDataTable() {
        const container = document.getElementById('qbtools-monster-weight-data');
        if (!container) return;

        container.innerHTML = '';
        const gameData = getStoredGameData();
        if (!isObjectRecord(gameData)) {
            const empty = document.createElement('div');
            empty.className = 'qbtools-data-empty';
            empty.textContent = '暂无游戏数据，请先更新游戏数据';
            container.appendChild(empty);
            return;
        }

        appendMonsterWeightSections(container, gameData);
    }

    /** renderRecipeDataTable: function */
    function renderRecipeDataTable() {
        const container = document.getElementById('qbtools-recipe-data');
        if (!container) return;

        container.innerHTML = '';
        const gameData = getStoredGameData();
        if (!isObjectRecord(gameData)) {
            const empty = document.createElement('div');
            empty.className = 'qbtools-data-empty';
            empty.textContent = '暂无游戏数据，请先更新游戏数据';
            container.appendChild(empty);
            return;
        }

        const rows = buildConsumableRecipeRows(gameData);
        appendRecipeTableSection(container, '可获取', rows.tradable);
        appendRecipeTableSection(container, '不可获取', rows.nonTradable);
    }

    /** getCombatAreaNamesFromCache: function */
    function getCombatAreaNamesFromCache() {
        const gameData = getStoredGameData();
        const combatAreas = gameData && typeof gameData === 'object' && isObjectRecord(gameData.combatAreas)
            ? gameData.combatAreas
            : readStorageJson(COMBAT_AREA_STORAGE_KEY, null);
        if (!combatAreas || typeof combatAreas !== 'object') {
            return [];
        }

        return Object.values(combatAreas)
            .map((area) => (area && typeof area === 'object' ? String(area.name || '').trim() : ''))
            .filter((name) => Boolean(name));
    }

    /** populateProductionCombatAreaOptions: function */
    function populateProductionCombatAreaOptions() {
        const select = document.getElementById('production-combat-area-select');
        if (!select) return;

        const areaNames = getCombatAreaNamesFromCache();
        const savedName = String(localStorage.getItem(PRODUCTION_COMBAT_AREA_NAME_KEY) || '').trim();
        const options = ['<option value="">请选择副本</option>']
            .concat(areaNames.map((name) => `<option value="${name}">${name}</option>`))
            .join('');

        select.innerHTML = options;
        if (savedName && areaNames.includes(savedName)) {
            select.value = savedName;
        }
    }

    /** saveProductionCombatAreaSelection: function */
    function saveProductionCombatAreaSelection() {
        const select = document.getElementById('production-combat-area-select');
        if (!select) return;

        const selectedName = String(select.value || '').trim();
        if (!selectedName) {
            localStorage.removeItem(PRODUCTION_COMBAT_AREA_NAME_KEY);
            updateStatus('已清除生产后战斗副本配置');
            return;
        }

        localStorage.setItem(PRODUCTION_COMBAT_AREA_NAME_KEY, selectedName);
        updateStatus(`生产后战斗副本已保存: ${selectedName}`);
    }

    /** clearProductionCombatAreaSelection: function */
    function clearProductionCombatAreaSelection() {
        const select = document.getElementById('production-combat-area-select');
        if (select) {
            select.value = '';
        }

        localStorage.removeItem(PRODUCTION_COMBAT_AREA_NAME_KEY);
        updateStatus('已清除生产后战斗副本配置');
    }

    /** tryStartConfiguredCombat: function */
    function tryStartConfiguredCombat(targetName, attempt = 0) {
        if (!targetName) {
            autoCombatInProgress = false;
            return;
        }

        if (attempt === 0) {
            const quickEnter = document.querySelector('.combat-group .menu-item.special-item');
            if (quickEnter) {
                quickEnter.click();
            }
        }

        const areaContainer = document.querySelector('.area-list-container');
        const areaCards = areaContainer
            ? Array.from(areaContainer.querySelectorAll('.area-card.completed'))
            : [];

        for (const card of areaCards) {
            const titleNode = card.querySelector('.area-title');
            const title = String(titleNode?.textContent || '').trim();
            if (title !== targetName) {
                continue;
            }

            const startBtn = card.querySelector('.start-btn');
            if (startBtn) {
                startBtn.click();
            }
            autoCombatInProgress = false;
            return;
        }

        if (attempt >= 12) {
            autoCombatInProgress = false;
            return;
        }

        setTimeout(() => {
            tryStartConfiguredCombat(targetName, attempt + 1);
        }, 250);
    }

    /** triggerAutoCombatAfterProduction: function */
    function triggerAutoCombatAfterProduction() {
        if (autoCombatInProgress) return;

        const targetName = String(localStorage.getItem(PRODUCTION_COMBAT_AREA_NAME_KEY) || '').trim();
        if (!targetName) {
            return;
        }

        autoCombatInProgress = true;
        tryStartConfiguredCombat(targetName, 0);
    }

    /** saveMarketOverviewData: function */
    function saveMarketOverviewData(data) {
        if (!data || typeof data !== 'object' || !data.payload || typeof data.payload !== 'object') {
            return false;
        }

        try {
            localStorage.setItem(MARKET_OVERVIEW_STORAGE_KEY, JSON.stringify({
                type: 'market:overview_data',
                payload: data.payload,
                receivedAt: new Date().toISOString(),
            }));
            return true;
        } catch (error) {
            console.error('保存市场数据失败:', error);
            return false;
        }
    }

    /** getMarketOverviewData: function */
    function getMarketOverviewData() {
        try {
            const data = localStorage.getItem(MARKET_OVERVIEW_STORAGE_KEY);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error('读取市场数据失败:', error);
            return null;
        }
    }

    /**
     * 检查是否需要同步数据
     * 如果localStorage中没有数据，则从API获取
     */
    async function checkAndSyncData() {
        const existingData = getGameData();
        if (hasObjectEntries(existingData)) {
            console.log('localStorage中已有游戏数据，跳过同步');
            updateStatus('数据已存在');
            displayItemsList();
            displayMonstersList();
            renderRecipeDataTable();
            renderMonsterWeightDataTable();
            return;
        }

        updateStatus('正在获取数据...');
        const data = await fetchGameData();
        if (data) {
            saveGameData(data);
        } else {
            updateStatus('获取失败');
        }
    }

    /**
     * 强制更新游戏数据
     * 不管缓存中是否有数据，都从API获取并更新
     */
    async function forceUpdateData() {
        updateStatus('正在更新...');
        const data = await fetchGameData();
        if (data) {
            saveGameData(data);
        } else {
            updateStatus('更新失败');
        }
    }

    // 侧边栏样式
    /** getWsFilter: function */
    function getWsFilter() {
        return (localStorage.getItem(WS_FILTER_KEY) || '').trim();
    }

    /** appendWsLog: function */
    function appendWsLog(direction, data, wsUrl) {
        if (!wsMonitorEnabled) return;
        const now = new Date().toLocaleTimeString();
        const singleLineData = String(data).replace(/\r?\n/g, ' ');
        const rowText = `[${now}] [${direction.toUpperCase()}] ${singleLineData}`;
        wsLogBuffer.push({ direction, rowText });
        if (wsLogBuffer.length > 1000) {
            wsLogBuffer.shift();
        }

        const logBox = document.getElementById('qbtools-ws-log');
        if (!logBox) return;
        if (logBox.value) {
            logBox.value += '\n\n';
        }
        logBox.value += rowText;
        logBox.scrollTop = logBox.scrollHeight;
    }

    /** renderWsLogBuffer: function */
    function renderWsLogBuffer() {
        const logBox = document.getElementById('qbtools-ws-log');
        if (!logBox) return;
        logBox.value = wsLogBuffer.map((entry) => entry.rowText).join('\n\n');
        logBox.scrollTop = logBox.scrollHeight;
    }

    /** shouldDisplayWsMessage: function */
    function shouldDisplayWsMessage(text) {
        const filter = getWsFilter();
        if (!filter) return true;
        return String(text).includes(filter);
    }

    /** normalizeWsData: function */
    function normalizeWsData(data) {
        if (typeof data === 'string') return Promise.resolve(data);
        if (data instanceof ArrayBuffer) {
            try {
                return Promise.resolve(new TextDecoder().decode(new Uint8Array(data)));
            } catch (e) {
                return Promise.resolve('[ArrayBuffer]');
            }
        }
        if (data && typeof Blob !== 'undefined' && data instanceof Blob) {
            return data.text().catch(() => '[Blob]');
        }
        try {
            return Promise.resolve(JSON.stringify(data));
        } catch (e) {
            return Promise.resolve(String(data));
        }
    }

    /** getLatestOpenWs: function */
    function getLatestOpenWs() {
        const list = Array.from(wsInstances);
        for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i].readyState === OriginalWebSocket.OPEN) {
                return list[i];
            }
        }
        return null;
    }

    /** sendMessageToLatestWs: function */
    function sendMessageToLatestWs(message) {
        const target = getLatestOpenWs();
        if (!target) {
            throw new Error('未找到可用的WebSocket连接');
        }

        target.send(JSON.stringify(message));
    }

    /** setWsUiState: function */
    function setWsUiState() {
        const sendInput = document.getElementById('qbtools-ws-send-input');
        const sendBtn = document.getElementById('qbtools-ws-send-btn');
        const stopBtn = document.getElementById('qbtools-ws-stop-btn');
        if (!sendInput || !sendBtn || !stopBtn) return;

        const disabled = !wsMonitorEnabled;
        sendInput.disabled = disabled;
        sendBtn.disabled = disabled;
        stopBtn.textContent = disabled ? '开始监听' : '停止监听';
    }

    /** applyWsFilter: function */
    function applyWsFilter() {
        const filterInput = document.getElementById('qbtools-ws-filter-input');
        if (!filterInput) return;
        localStorage.setItem(WS_FILTER_KEY, filterInput.value || '');
        appendWsLog('sys', `已应用监听关键字: ${getWsFilter() || '(空，监听全部)'}`, '');
    }

    /** getFavoriteItems: function */
    function getFavoriteItems() {
        try {
            const raw = localStorage.getItem(FAVORITE_ITEMS_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            return parsed
                .filter((item) => item && item.id && item.name)
                .map((item) => ({ id: String(item.id), name: String(item.name) }));
        } catch (error) {
            console.error('Failed to read favorite items:', error);
            return [];
        }
    }

    /** saveFavoriteItems: function */
    function saveFavoriteItems(items) {
        try {
            localStorage.setItem(FAVORITE_ITEMS_KEY, JSON.stringify(items));
        } catch (error) {
            console.error('Failed to save favorite items:', error);
        }
    }

    /** isFavoriteItem: function */
    function isFavoriteItem(itemId) {
        const list = getFavoriteItems();
        return list.some((item) => item.id === String(itemId));
    }

    /** setFavoriteItem: function */
    function setFavoriteItem(itemData, isFavorite) {
        if (!itemData || !itemData.id) return;
        const itemId = String(itemData.id);
        const itemName = String(itemData.name || itemData.id);
        const list = getFavoriteItems();
        const filtered = list.filter((entry) => entry.id !== itemId);
        if (isFavorite) {
            filtered.push({ id: itemId, name: itemName });
        }
        saveFavoriteItems(filtered);
    }

    /** getMarketCardsSourceContainer: function */
    function getMarketCardsSourceContainer(favoriteList) {
        let sibling = favoriteList ? favoriteList.nextElementSibling : null;
        while (sibling) {
            if (sibling.id !== 'favorite-item-list' && sibling.querySelector('.market-item-card')) {
                return sibling;
            }
            sibling = sibling.nextElementSibling;
        }
        return null;
    }

    /** getItemsNameIdMap: function */
    function getItemsNameIdMap() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY) || '';
            if (raw === marketItemsCacheRaw && marketItemsNameIdMapCache.size) {
                return marketItemsNameIdMapCache;
            }
            const itemsData = raw ? JSON.parse(raw) : {};
            const map = new Map();
            Object.keys(itemsData || {}).forEach((key) => {
                const item = itemsData[key] || {};
                const id = String(item.id || key);
                const name = String(item.name || '').trim();
                if (name) {
                    map.set(name, id);
                }
            });
            marketItemsCacheRaw = raw;
            marketItemsNameIdMapCache = map;
            return map;
        } catch (error) {
            console.error('Failed to read items map:', error);
            return new Map();
        }
    }

    /** getOrCreateMarketLoadingMask: function */
    function getOrCreateMarketLoadingMask() {
        let mask = document.getElementById('qbtools-market-loading');
        if (mask) return mask;
        mask = document.createElement('div');
        mask.id = 'qbtools-market-loading';
        mask.textContent = 'Loading market data...';
        mask.style.position = 'fixed';
        mask.style.right = '16px';
        mask.style.bottom = '16px';
        mask.style.padding = '8px 12px';
        mask.style.background = 'rgba(0,0,0,0.72)';
        mask.style.color = '#fff';
        mask.style.borderRadius = '6px';
        mask.style.fontSize = '12px';
        mask.style.zIndex = '100000';
        mask.style.display = 'none';
        document.body.appendChild(mask);
        return mask;
    }

    /** setMarketLoading: function */
    function setMarketLoading(visible) {
        const mask = getOrCreateMarketLoadingMask();
        mask.style.display = visible ? 'block' : 'none';
    }

    /** assignMarketCardIdByItemName: function */
    function assignMarketCardIdByItemName(sourceContainer, favoriteList) {
        const nameToIdMap = getItemsNameIdMap();
        if (!nameToIdMap.size) return;

        const nameNodes = [];
        if (sourceContainer) {
            sourceContainer.querySelectorAll('.market-item-card .item-name').forEach((node) => nameNodes.push(node));
        }
        if (favoriteList) {
            favoriteList.querySelectorAll('.market-item-card .item-name').forEach((node) => nameNodes.push(node));
        }

        nameNodes.forEach((nameNode) => {
            const itemName = (nameNode.textContent || '').trim();
            if (!itemName) return;
            const itemId = nameToIdMap.get(itemName);
            if (!itemId) return;
            const card = nameNode.closest('.market-item-card');
            if (!card) return;
            card.id = itemId;
        });
    }

    /** getStoredNormalInventory: function */
    function getStoredNormalInventory() {
        try {
            const raw = localStorage.getItem(PLAYER_INVENTORY_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            const normalItems = parsed?.normalItems;
            if (!normalItems || typeof normalItems !== 'object') return {};
            return normalItems;
        } catch (error) {
            console.error('Failed to read player inventory:', error);
            return {};
        }
    }

    /** applyInventoryAmountToMarketCards: function */
    function applyInventoryAmountToMarketCards(sourceContainer, favoriteList) {
        const normalItems = getStoredNormalInventory();
        const cards = [];
        if (sourceContainer) {
            sourceContainer.querySelectorAll('.market-item-card[id]').forEach((card) => cards.push(card));
        }
        if (favoriteList) {
            favoriteList.querySelectorAll('.market-item-card[id]').forEach((card) => cards.push(card));
        }

        cards.forEach((card) => {
            const priceOverview = card.querySelector('.price-overview');
            if (!priceOverview) return;

            priceOverview.querySelectorAll('.qbtools-inventory-line').forEach((line) => {
                line.remove();
            });

            const itemId = card.id;
            const qty = Object.prototype.hasOwnProperty.call(normalItems, itemId)
                ? normalItems[itemId]
                : 0;
            const lineTemplate = priceOverview.querySelector('.price-line:last-child');
            if (!lineTemplate) return;

            const inventoryLine = lineTemplate.cloneNode(true);
            inventoryLine.classList.add('qbtools-inventory-line');

            const label = inventoryLine.querySelector('.lbl');
            if (label) {
                label.textContent = '存:';
            }

            const value = inventoryLine.querySelector('.val');
            if (value) {
                value.querySelectorAll('img').forEach((img) => img.remove());
                value.textContent = String(qty);
            }

            inventoryLine.querySelectorAll('img').forEach((img) => img.remove());
            priceOverview.appendChild(inventoryLine);
        });
    }

    /** applyFavoriteItemListToMarket: function */
    function applyFavoriteItemListToMarket(sourceContainer, favoriteList) {
        const favorites = getFavoriteItems();
        if (!favorites.length) return;
        if (!favoriteList) return;

        if (!sourceContainer) return;

        Array.from(favoriteList.querySelectorAll('.market-item-card')).forEach((card) => {
            sourceContainer.appendChild(card);
        });

        const sourceCards = Array.from(sourceContainer.querySelectorAll('.market-item-card[id]'));
        const sourceCardMap = new Map();
        sourceCards.forEach((card) => {
            sourceCardMap.set(card.id, card);
        });

        favorites.forEach((favoriteItem) => {
            const matchCard = sourceCardMap.get(String(favoriteItem.id));
            if (matchCard) {
                favoriteList.appendChild(matchCard);
            }
        });
    }

    /** createMarketSectionLabel: function */
    function createMarketSectionLabel(id, text) {
        let label = document.getElementById(id);
        if (!label) {
            label = document.createElement('div');
            label.id = id;
        }
        label.textContent = text;
        label.style.fontWeight = '800';
        label.style.margin = '12px 0 8px';
        label.style.textAlign = 'center';
        label.style.fontSize = '30px';
        return label;
    }

    /** ensureMarketFavoriteSectionLabels: function */
    function ensureMarketFavoriteSectionLabels(favoriteList) {
        if (!favoriteList || !favoriteList.isConnected || !favoriteList.parentNode) return;
        const parent = favoriteList.parentNode;

        const favoriteLabel = createMarketSectionLabel('qbtools-favorite-items-label', '喜欢');
        if (favoriteLabel.parentNode !== parent || favoriteLabel.nextElementSibling !== favoriteList) {
            parent.insertBefore(favoriteLabel, favoriteList);
        }

        const otherLabel = createMarketSectionLabel('qbtools-other-items-label', '其他');
        if (!favoriteList.isConnected || favoriteList.parentNode !== parent) return;
        if (otherLabel.parentNode !== parent || favoriteList.nextElementSibling !== otherLabel) {
            parent.insertBefore(otherLabel, favoriteList.nextSibling);
        }
    }

    /** getOriginalMarketItemListGrid: function */
    function getOriginalMarketItemListGrid() {
        const favoriteList = document.getElementById('favorite-item-list');
        if (favoriteList && favoriteList.isConnected) {
            const sourceContainer = getMarketCardsSourceContainer(favoriteList);
            if (sourceContainer) return sourceContainer;
        }

        return Array.from(document.querySelectorAll('.item-list-grid')).find(
            (el) => el.id !== 'favorite-item-list' && el.querySelector('.market-item-card')
        ) || null;
    }

    /** removeMarketFavoriteSeparateList: function */
    function removeMarketFavoriteSeparateList(sourceContainer) {
        const favoriteList = document.getElementById('favorite-item-list');
        if (favoriteList && favoriteList.isConnected && favoriteList !== sourceContainer) {
            Array.from(favoriteList.querySelectorAll('.market-item-card')).forEach((card) => {
                sourceContainer.appendChild(card);
            });
            favoriteList.remove();
        }

        ['qbtools-favorite-items-label', 'qbtools-other-items-label'].forEach((id) => {
            const label = document.getElementById(id);
            if (label) {
                label.remove();
            }
        });
    }

    /** applyFavoriteItemsToOriginalMarketList: function */
    function applyFavoriteItemsToOriginalMarketList(sourceContainer) {
        const favorites = getFavoriteItems();
        if (!favorites.length || !sourceContainer) return;

        const sourceCards = Array.from(sourceContainer.querySelectorAll('.market-item-card[id]'));
        const sourceCardMap = new Map();
        sourceCards.forEach((card) => {
            sourceCardMap.set(card.id, card);
        });

        favorites.slice().reverse().forEach((favoriteItem) => {
            const matchCard = sourceCardMap.get(String(favoriteItem.id));
            if (matchCard) {
                sourceContainer.insertBefore(matchCard, sourceContainer.firstElementChild);
            }
        });
    }

    /** processMarketOverviewDataInOriginalList: function */
    function processMarketOverviewDataInOriginalList() {
        const sourceContainer = getOriginalMarketItemListGrid();
        if (!sourceContainer || !sourceContainer.isConnected) return;

        const favoriteList = document.getElementById('favorite-item-list');
        assignMarketCardIdByItemName(sourceContainer, favoriteList);
        removeMarketFavoriteSeparateList(sourceContainer);
        assignMarketCardIdByItemName(sourceContainer, null);
        applyFavoriteItemsToOriginalMarketList(sourceContainer);
        applyInventoryAmountToMarketCards(sourceContainer, null);
    }

    /** processMarketOverviewData: function */
    function processMarketOverviewData() {
        const storeControls = document.querySelector('.store-controls');
        if (!storeControls || !storeControls.isConnected || !storeControls.parentNode) return;

        let favoriteList = document.getElementById('favorite-item-list');
        if (!favoriteList || !favoriteList.isConnected) {
            favoriteList = document.createElement('div');
            const templateGrid = Array.from(document.querySelectorAll('.item-list-grid')).find(
                (el) => el.id !== 'favorite-item-list'
            );
            if (templateGrid) {
                Array.from(templateGrid.attributes).forEach((attr) => {
                    favoriteList.setAttribute(attr.name, attr.value);
                });
            } else {
                favoriteList.className = 'item-list-grid';
            }
            favoriteList.id = 'favorite-item-list';
            favoriteList.style.marginBottom = '12px';
            storeControls.insertAdjacentElement('afterend', favoriteList);
        } else {
            favoriteList.style.marginBottom = '12px';
        }

        // ensureMarketFavoriteSectionLabels(favoriteList);

        const sourceContainer = getMarketCardsSourceContainer(favoriteList);
        if (!sourceContainer) return;

        assignMarketCardIdByItemName(sourceContainer, favoriteList);
        applyFavoriteItemListToMarket(sourceContainer, favoriteList);
        applyInventoryAmountToMarketCards(sourceContainer, favoriteList);
    }

    /** scheduleMarketOverviewProcessing: function */
    function scheduleMarketOverviewProcessing() {
        setMarketLoading(true);
        if (marketOverviewRafId) {
            cancelAnimationFrame(marketOverviewRafId);
        }
        marketOverviewRafId = requestAnimationFrame(() => {
            marketOverviewRafId = 0;
            try {
                processMarketOverviewDataInOriginalList();
            } finally {
                setMarketLoading(false);
            }
        });
    }

    /** bindMarketCategoryFavoriteRefresh: function */
    function bindMarketCategoryFavoriteRefresh() {

        if (marketCategoryFavoriteRefreshBound) return;
        marketCategoryFavoriteRefreshBound = true;

        const refreshMarketFavorites = () => {
            setTimeout(() => {
                scheduleMarketOverviewProcessing();
            }, 0);
        };

        document.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (!target.closest('.category-btn.primary-btn')) return;

            refreshMarketFavorites();
        });

        document.addEventListener('input', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (!target.classList.contains('market-input')) return;

            refreshMarketFavorites();
        });
    }

    /** onWsMessageReceived: function */
    function onWsMessageReceived(text) {
        let payload = null;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            return;
        }
        if (!payload || !payload.type) return;

        if (payload.type === 'initial_state') {
            const inventory = payload?.payload?.playerState?.inventory || {};
            localStorage.setItem(PLAYER_INVENTORY_KEY, JSON.stringify(inventory));
            return;
        }

        if (payload.type === 'player:state:updated') {
            const productionQueue = payload?.payload?.actionQueue?.production;
            const queue = Array.isArray(productionQueue) ? productionQueue : [];
            const hasActive = queue.some((task) => (String(task?.status || '').toLowerCase() === 'active' || String(task?.status || '').toLowerCase() === 'pending'));
            if (queue.length > 0 && !hasActive) {
                triggerAutoCombatAfterProduction();
            }
            return;
        }

        if (payload.type === 'market:overview_data') {
            if (saveMarketOverviewData(payload)) {
                updateStatus(`市场数据更新完成 ${Object.keys(payload.payload || {}).length} 条`);
            }
            scheduleMarketOverviewProcessing();
            renderMarketOverviewTable();
        }
    }

    /** requestMarketOverviewData: function */
    function requestMarketOverviewData() {
        try {
            sendMessageToLatestWs({
                type: 'market:overview',
                payload: {},
            });
            updateStatus('已发送市场数据更新请求，等待返回 market:overview_data');
            renderMarketOverviewTable();
        } catch (error) {
            console.error('请求市场数据失败:', error);
            updateStatus(`市场数据更新失败：${error.message}`);
            alert(error.message);
        }
    }

    /** getExportTimestamp: function */
    function getExportTimestamp() {
        const now = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    /** formatChineseDateTime: function */
    function formatChineseDateTime(dateInput) {
        const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
        if (Number.isNaN(date.getTime())) {
            return '';
        }
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}时${pad(date.getMinutes())}分${pad(date.getSeconds())}秒`;
    }

    /** buildMarketOverviewDisplayRows: function */
    function buildMarketOverviewDisplayRows() {
        const marketData = getMarketOverviewData();
        const marketPayload = marketData?.payload;
        const gameData = getGameData();
        if (!marketPayload || !gameData) {
            return {
                cutoffText: '',
                rows: [],
            };
        }

        const favoriteOrderMap = new Map();
        getFavoriteItems().forEach((item, index) => {
            favoriteOrderMap.set(String(item.id), index);
        });

        const sortedEntries = sortResourceEntriesByFavoriteItems(
            Object.keys(marketPayload)
                .sort()
                .map((itemId) => [itemId, marketPayload[itemId]])
        );

        const rows = sortedEntries
            .map(([itemId], index) => {
                const marketInfo = marketPayload[itemId] || {};
                const itemInfo = gameData[itemId] || {};
                return {
                    itemId,
                    name: itemInfo.name || itemId,
                    lowestSell: marketInfo.lowestSell ?? '',
                    highestBuy: marketInfo.highestBuy ?? '',
                    rowIndex: index,
                    isFavorite: favoriteOrderMap.has(String(itemId)),
                    favoriteOrder: favoriteOrderMap.has(String(itemId))
                        ? favoriteOrderMap.get(String(itemId))
                        : Number.MAX_SAFE_INTEGER,
                };
            });

        return {
            cutoffText: formatChineseDateTime(marketData?.receivedAt),
            rows,
        };
    }

    /** formatMarketPriceValue: function */
    function formatMarketPriceValue(value) {
        if (value === '' || value === null || value === undefined) {
            return '';
        }
        const num = Number(value);
        if (!Number.isFinite(num)) {
            return String(value);
        }
        return num.toLocaleString('en-US');
    }

    /** toComparableMarketPrice: function */
    function toComparableMarketPrice(value) {
        if (value === '' || value === null || value === undefined) {
            return Number.POSITIVE_INFINITY;
        }
        const num = Number(value);
        return Number.isFinite(num) ? num : Number.POSITIVE_INFINITY;
    }

    /** getSortedMarketRows: function */
    function getSortedMarketRows(rows, sortState) {
        const sortKey = sortState?.key;
        if (sortKey !== 'lowestSell' && sortKey !== 'highestBuy') {
            return rows.slice().sort((left, right) => left.rowIndex - right.rowIndex);
        }

        const direction = sortState?.direction === 'desc' ? -1 : 1;
        return rows.slice().sort((left, right) => {
            const leftPrice = toComparableMarketPrice(left[sortKey]);
            const rightPrice = toComparableMarketPrice(right[sortKey]);
            if (leftPrice !== rightPrice) {
                return (leftPrice - rightPrice) * direction;
            }
            return left.rowIndex - right.rowIndex;
        });
    }

    /** toggleMarketTableSort: function */
    function toggleMarketTableSort(sortKey, group) {
        const isFavoriteGroup = group === 'favorite';
        const currentState = isFavoriteGroup ? marketFavoriteTableSortState : marketOtherTableSortState;
        let nextState = null;

        if (currentState.key !== sortKey) {
            nextState = { key: sortKey, direction: 'asc' };
        } else {
            nextState = {
                key: sortKey,
                direction: currentState.direction === 'asc' ? 'desc' : 'asc',
            };
        }

        if (isFavoriteGroup) {
            marketFavoriteTableSortState = nextState;
        } else {
            marketOtherTableSortState = nextState;
        }
        renderMarketOverviewTable();
    }

    /** renderSingleMarketOverviewTable: function */
    function renderSingleMarketOverviewTable(container, rows, title, sortState, group) {
        const sectionTitle = document.createElement('h4');
        sectionTitle.className = 'qbtools-data-section-title';
        sectionTitle.textContent = title;
        container.appendChild(sectionTitle);

        const tableWrap = document.createElement('div');
        tableWrap.className = 'qbtools-data-table-wrap';
        const table = document.createElement('table');
        table.className = 'qbtools-data-table';
        table.style.tableLayout = 'fixed';
        table.style.minWidth = '550px';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        const isSortOnLowestSell = sortState.key === 'lowestSell';
        const isSortOnHighestBuy = sortState.key === 'highestBuy';
        const sortArrow = sortState.direction === 'desc' ? '↓' : '↑';
        const headerDefs = [
            { label: '物品名称', sortable: false, key: '' },
            { label: `最低出售价${isSortOnLowestSell ? ` ${sortArrow}` : ''}`, sortable: true, key: 'lowestSell' },
            { label: `最高收购价${isSortOnHighestBuy ? ` ${sortArrow}` : ''}`, sortable: true, key: 'highestBuy' },
        ];
        headerDefs.forEach((headerDef) => {
            const th = document.createElement('th');
            th.textContent = headerDef.label;
            if (headerDef.sortable) {
                th.style.cursor = 'pointer';
                th.title = '点击排序';
                th.addEventListener('click', () => {
                    toggleMarketTableSort(headerDef.key, group);
                });
            }
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const headerCells = headerRow.querySelectorAll('th');
        if (headerCells[0]) headerCells[0].style.width = '150px';
        if (headerCells[1]) headerCells[1].style.width = '200px';
        if (headerCells[2]) headerCells[2].style.width = '200px';

        const tbody = document.createElement('tbody');
        const sortedRows = getSortedMarketRows(rows, sortState);
        sortedRows.forEach((row) => {
            const tr = document.createElement('tr');
            [row.name, formatMarketPriceValue(row.lowestSell), formatMarketPriceValue(row.highestBuy)].forEach((value) => {
                const td = document.createElement('td');
                td.textContent = String(value);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        if (!sortedRows.length) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 3;
            td.className = 'qbtools-empty-cell';
            td.textContent = '暂无数据';
            tr.appendChild(td);
            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        tableWrap.appendChild(table);
        container.appendChild(tableWrap);
    }

    /** renderMarketOverviewTable: function */
    function renderMarketOverviewTable() {
        const container = document.getElementById('data-subtab-market');
        if (!container) return;

        container.innerHTML = '';
        const { cutoffText, rows } = buildMarketOverviewDisplayRows();
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'qbtools-data-empty';
            empty.textContent = '暂无市场数据，请先点击“更新市场数据”';
            container.appendChild(empty);
            return;
        }
        const favoriteRows = rows.filter((row) => row.isFavorite);
        const otherRows = rows.filter((row) => !row.isFavorite);

        if (cutoffText) {
            const summary = document.createElement('div');
            summary.className = 'qbtools-data-empty';
            summary.textContent = `数据截止至 ${cutoffText}`;
            container.appendChild(summary);
        }

        renderSingleMarketOverviewTable(container, favoriteRows, '喜欢物品', marketFavoriteTableSortState, 'favorite');
        renderSingleMarketOverviewTable(container, otherRows, '其他物品', marketOtherTableSortState, 'other');
    }

    /** exportMarketOverviewData: function */
    function exportMarketOverviewData() {
        renderMarketOverviewTable();
        if (typeof XLSX === 'undefined') {
            updateStatus('导出失败：XLSX 依赖未加载');
            alert('XLSX 依赖未加载，请刷新页面后重试');
            return;
        }

        const marketData = getMarketOverviewData();
        const marketPayload = marketData?.payload;
        if (!marketPayload) {
            updateStatus('导出失败：未找到市场数据缓存');
            alert('未找到市场数据缓存，请先点击“更新市场数据”或等待 market:overview_data 消息');
            return;
        }

        const gameData = getGameData();
        if (!gameData) {
            updateStatus('导出失败：未找到游戏数据缓存');
            alert('未找到游戏数据缓存，请先点击“更新游戏数据”');
            return;
        }

        const itemIds = Object.keys(marketPayload).sort();
        if (!itemIds.length) {
            updateStatus('导出失败：市场数据为空');
            alert('市场数据缓存为空');
            return;
        }

        const header = ['物品ID', '物品名称', '市场最低出售价', '市场最高求购价', '系统商店出售价'];
        const cutoffText = formatChineseDateTime(marketData?.receivedAt) || formatChineseDateTime(new Date());
        const rows = [[`数据截止至 ${cutoffText}`], header];

        itemIds.forEach((itemId) => {
            const marketInfo = marketPayload[itemId] || {};
            const itemInfo = gameData[itemId] || {};
            rows.push([
                itemId,
                itemInfo.name || itemId,
                marketInfo.lowestSell ?? '',
                marketInfo.highestBuy ?? '',
                itemInfo.sellPrice ?? '',
            ]);
        });

        const worksheet = XLSX.utils.aoa_to_sheet(rows);
        worksheet['!merges'] = [
            {
                s: { r: 0, c: 0 },
                e: { r: 0, c: header.length - 1 },
            },
        ];
        worksheet['!cols'] = [
            { wch: 18 },
            { wch: 28 },
            { wch: 18 },
            { wch: 18 },
            { wch: 18 },
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, '市场数据');
        XLSX.writeFile(workbook, `market_overview_${getExportTimestamp()}.xlsx`);
        updateStatus(`市场数据导出完成，共 ${itemIds.length} 条`);
    }

    /** initWebSocketMonitor: function */
    function initWebSocketMonitor() {
        if (!OriginalWebSocket || OriginalWebSocket.__qbtools_patched__) {
            return;
        }

        /** WrappedWebSocket: function */
        function WrappedWebSocket(...args) {
            const ws = new OriginalWebSocket(...args);
            ws.__qbtools_url = args[0] || '';
            wsInstances.add(ws);

            const originalSend = ws.send;
            /** patchedSend: function expression */
            ws.send = function patchedSend(data) {
                normalizeWsData(data).then((text) => {
                    if (shouldDisplayWsMessage(text)) {
                        appendWsLog('send', text, ws.__qbtools_url);
                    }
                });
                return originalSend.call(this, data);
            };

            ws.addEventListener('message', (event) => {
                normalizeWsData(event.data).then((text) => {
                    onWsMessageReceived(text);
                    if (shouldDisplayWsMessage(text)) {
                        appendWsLog('recv', text, ws.__qbtools_url);
                    }
                });
            });

            ws.addEventListener('close', () => {
                wsInstances.delete(ws);
            });

            return ws;
        }

        WrappedWebSocket.prototype = OriginalWebSocket.prototype;
        WrappedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
        WrappedWebSocket.OPEN = OriginalWebSocket.OPEN;
        WrappedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
        WrappedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
        WrappedWebSocket.__qbtools_patched__ = true;
        PAGE_WINDOW.WebSocket = WrappedWebSocket;
        window.WebSocket = WrappedWebSocket;
    }

    /** getMonsterData: function */
    function getMonsterData() {
        try {
            return readStorageJson(MONSTER_STORAGE_KEY, null);
        } catch (error) {
            console.error('读取怪物数据失败:', error);
            return null;
        }
    }

    /** openItemConfigDB: function */
    function openItemConfigDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(ITEM_CONFIG_DB_NAME, ITEM_CONFIG_DB_VERSION);
            /** request.onupgradeneeded: assigned anonymous function */
            request.onupgradeneeded = function (event) {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(ITEM_CONFIG_STORE)) {
                    const store = db.createObjectStore(ITEM_CONFIG_STORE, { keyPath: 'pk', autoIncrement: true });
                    store.createIndex('itemId', 'itemId', { unique: true });
                }
                if (!db.objectStoreNames.contains(MONSTER_CONFIG_STORE)) {
                    const store = db.createObjectStore(MONSTER_CONFIG_STORE, { keyPath: 'pk', autoIncrement: true });
                    store.createIndex('monsterId', 'monsterId', { unique: true });
                }
            };
            /** request.onsuccess: assigned anonymous function */
            request.onsuccess = function () {
                resolve(request.result);
            };
            /** request.onerror: assigned anonymous function */
            request.onerror = function () {
                reject(request.error);
            };
        });
    }

    async function getItemImageConfigByItemId(itemId) {
        const db = await openItemConfigDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(ITEM_CONFIG_STORE, 'readonly');
            const store = tx.objectStore(ITEM_CONFIG_STORE);
            const idx = store.index('itemId');
            const req = idx.get(itemId);
            /** req.onsuccess: assigned anonymous function */
            req.onsuccess = function () {
                resolve(req.result || null);
            };
            /** req.onerror: assigned anonymous function */
            req.onerror = function () {
                reject(req.error);
            };
        });
    }

    async function getAllItemImageConfigs() {
        const db = await openItemConfigDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(ITEM_CONFIG_STORE, 'readonly');
            const store = tx.objectStore(ITEM_CONFIG_STORE);
            const req = store.getAll();
            /** req.onsuccess: assigned anonymous function */
            req.onsuccess = function () {
                resolve(req.result || []);
            };
            /** req.onerror: assigned anonymous function */
            req.onerror = function () {
                reject(req.error);
            };
        });
    }

    async function saveItemImageConfig(config) {
        const db = await openItemConfigDB();
        const existing = await getItemImageConfigByItemId(config.itemId);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(ITEM_CONFIG_STORE, 'readwrite');
            const store = tx.objectStore(ITEM_CONFIG_STORE);
            const payload = {
                ...(existing || {}),
                ...config,
                updatedAt: Date.now(),
            };
            const req = store.put(payload);
            /** req.onsuccess: assigned anonymous function */
            req.onsuccess = function () {
                resolve(req.result);
            };
            /** req.onerror: assigned anonymous function */
            req.onerror = function () {
                reject(req.error);
            };
        });
    }

    async function getMonsterImageConfigByMonsterId(monsterId) {
        const db = await openItemConfigDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(MONSTER_CONFIG_STORE, 'readonly');
            const store = tx.objectStore(MONSTER_CONFIG_STORE);
            const idx = store.index('monsterId');
            const req = idx.get(monsterId);
            /** req.onsuccess: assigned anonymous function */
            req.onsuccess = function () {
                resolve(req.result || null);
            };
            /** req.onerror: assigned anonymous function */
            req.onerror = function () {
                reject(req.error);
            };
        });
    }

    async function getAllMonsterImageConfigs() {
        const db = await openItemConfigDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(MONSTER_CONFIG_STORE, 'readonly');
            const store = tx.objectStore(MONSTER_CONFIG_STORE);
            const req = store.getAll();
            /** req.onsuccess: assigned anonymous function */
            req.onsuccess = function () {
                resolve(req.result || []);
            };
            /** req.onerror: assigned anonymous function */
            req.onerror = function () {
                reject(req.error);
            };
        });
    }

    async function saveMonsterImageConfig(config) {
        const db = await openItemConfigDB();
        const existing = await getMonsterImageConfigByMonsterId(config.monsterId);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(MONSTER_CONFIG_STORE, 'readwrite');
            const store = tx.objectStore(MONSTER_CONFIG_STORE);
            const payload = {
                ...(existing || {}),
                ...config,
                updatedAt: Date.now(),
            };
            const req = store.put(payload);
            /** req.onsuccess: assigned anonymous function */
            req.onsuccess = function () {
                resolve(req.result);
            };
            /** req.onerror: assigned anonymous function */
            req.onerror = function () {
                reject(req.error);
            };
        });
    }

    /** clearPreviewObjectUrl: function */
    function clearPreviewObjectUrl() {
        if (itemEditorState.selectedImageObjectUrl) {
            URL.revokeObjectURL(itemEditorState.selectedImageObjectUrl);
            itemEditorState.selectedImageObjectUrl = '';
        }
    }

    /** setItemImagePreview: function */
    function setItemImagePreview(blob) {
        const preview = document.getElementById('item-image-preview');
        if (!preview) return;

        clearPreviewObjectUrl();
        if (!blob) {
            preview.src = '';
            preview.style.display = 'none';
            return;
        }
        itemEditorState.selectedImageObjectUrl = URL.createObjectURL(blob);
        preview.src = itemEditorState.selectedImageObjectUrl;
        preview.style.display = 'block';
    }

    /** setItemEditorVisible: function */
    function setItemEditorVisible(visible) {
        const listView = document.getElementById('items-list-view');
        const editorView = document.getElementById('item-config-view');
        if (!listView || !editorView) return;
        listView.style.display = visible ? 'none' : 'block';
        editorView.style.display = visible ? 'block' : 'none';
    }

    async function openItemConfigView(itemData) {
        itemEditorState.selectedItem = itemData;
        const title = document.getElementById('item-config-title');
        if (title) {
            title.textContent = `${itemData.id}-${itemData.name || itemData.id}`;
        }

        const config = await getItemImageConfigByItemId(itemData.id);
        if (config && config.imageBlob) {
            itemEditorState.selectedImageBlob = config.imageBlob;
            setItemImagePreview(config.imageBlob);
        } else {
            itemEditorState.selectedImageBlob = null;
            setItemImagePreview(null);
        }

        const enabledYes = document.getElementById('item-config-enabled-yes');
        const enabledNo = document.getElementById('item-config-enabled-no');
        const enabled = config ? !!config.enabled : true;
        if (enabledYes && enabledNo) {
            enabledYes.checked = enabled;
            enabledNo.checked = !enabled;
        }

        const favoriteYes = document.getElementById('item-config-favorite-yes');
        const favoriteNo = document.getElementById('item-config-favorite-no');
        const favorite = isFavoriteItem(itemData.id);
        if (favoriteYes && favoriteNo) {
            favoriteYes.checked = favorite;
            favoriteNo.checked = !favorite;
        }

        const fileInput = document.getElementById('item-image-file-input');
        if (fileInput) {
            fileInput.value = '';
        }

        setItemEditorVisible(true);
    }

    /** getItemConfigEnabled: function */
    function getItemConfigEnabled() {
        const enabledYes = document.getElementById('item-config-enabled-yes');
        return enabledYes ? enabledYes.checked : true;
    }

    async function saveCurrentItemConfig() {
        if (!itemEditorState.selectedItem) {
            alert('No item selected');
            return;
        }
        if (!itemEditorState.selectedImageBlob) {
            alert('Please choose a PNG image');
            return;
        }

        await saveItemImageConfig({
            itemId: itemEditorState.selectedItem.id,
            itemName: itemEditorState.selectedItem.name || itemEditorState.selectedItem.id,
            itemType: itemEditorState.selectedItem.type || '',
            enabled: getItemConfigEnabled(),
            imageBlob: itemEditorState.selectedImageBlob,
        });

        await refreshItemIconReplacementMap();
        applyItemIconReplacements();
        alert('Item image config saved');
    }

    /** clearMonsterPreviewObjectUrl: function */
    function clearMonsterPreviewObjectUrl() {
        if (monsterEditorState.selectedImageObjectUrl) {
            URL.revokeObjectURL(monsterEditorState.selectedImageObjectUrl);
            monsterEditorState.selectedImageObjectUrl = '';
        }
    }

    /** setMonsterImagePreview: function */
    function setMonsterImagePreview(blob) {
        const preview = document.getElementById('monster-image-preview');
        if (!preview) return;

        clearMonsterPreviewObjectUrl();
        if (!blob) {
            preview.src = '';
            preview.style.display = 'none';
            return;
        }
        monsterEditorState.selectedImageObjectUrl = URL.createObjectURL(blob);
        preview.src = monsterEditorState.selectedImageObjectUrl;
        preview.style.display = 'block';
    }

    /** setMonsterEditorVisible: function */
    function setMonsterEditorVisible(visible) {
        const listView = document.getElementById('monsters-list-view');
        const editorView = document.getElementById('monster-config-view');
        if (!listView || !editorView) return;
        listView.style.display = visible ? 'none' : 'block';
        editorView.style.display = visible ? 'block' : 'none';
    }

    async function openMonsterConfigView(monsterData) {
        monsterEditorState.selectedMonster = monsterData;
        const title = document.getElementById('monster-config-title');
        if (title) {
            title.textContent = `${monsterData.id}-${monsterData.name || monsterData.id}`;
        }

        const config = await getMonsterImageConfigByMonsterId(monsterData.id);
        if (config && config.imageBlob) {
            monsterEditorState.selectedImageBlob = config.imageBlob;
            setMonsterImagePreview(config.imageBlob);
        } else {
            monsterEditorState.selectedImageBlob = null;
            setMonsterImagePreview(null);
        }

        const enabledYes = document.getElementById('monster-config-enabled-yes');
        const enabledNo = document.getElementById('monster-config-enabled-no');
        const enabled = config ? !!config.enabled : true;
        if (enabledYes && enabledNo) {
            enabledYes.checked = enabled;
            enabledNo.checked = !enabled;
        }

        const fileInput = document.getElementById('monster-image-file-input');
        if (fileInput) {
            fileInput.value = '';
        }

        setMonsterEditorVisible(true);
    }

    /** getMonsterConfigEnabled: function */
    function getMonsterConfigEnabled() {
        const enabledYes = document.getElementById('monster-config-enabled-yes');
        return enabledYes ? enabledYes.checked : true;
    }

    /** isAllowedImageFile: function */
    function isAllowedImageFile(file) {
        if (!file) return false;
        const allowedMimeTypes = new Set([
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
            'image/bmp',
        ]);
        if (allowedMimeTypes.has((file.type || '').toLowerCase())) {
            return true;
        }
        const fileName = (file.name || '').toLowerCase();
        return /\.(png|jpg|jpeg|gif|webp|bmp)$/.test(fileName);
    }

    async function saveCurrentMonsterConfig() {
        if (!monsterEditorState.selectedMonster) {
            alert('No monster selected');
            return;
        }
        if (!monsterEditorState.selectedImageBlob) {
            alert('Please choose a PNG image');
            return;
        }

        await saveMonsterImageConfig({
            monsterId: monsterEditorState.selectedMonster.id,
            monsterName: monsterEditorState.selectedMonster.name || monsterEditorState.selectedMonster.id,
            icon: monsterEditorState.selectedMonster.icon || '',
            enabled: getMonsterConfigEnabled(),
            imageBlob: monsterEditorState.selectedImageBlob,
        });

        await refreshItemIconReplacementMap();
        applyItemIconReplacements();
        alert('Monster image config saved');
    }

    async function refreshItemIconReplacementMap() {
        const uniqueOldUrls = new Set(itemIconReplacementMap.values());
        uniqueOldUrls.forEach((url) => {
            URL.revokeObjectURL(url);
        });
        itemIconReplacementMap.clear();

        const configs = await getAllItemImageConfigs();
        configs.forEach((cfg) => {
            if (!cfg || !cfg.enabled || !cfg.imageBlob || !cfg.itemId || !cfg.itemType) return;
            const objectUrl = URL.createObjectURL(cfg.imageBlob);
            itemIconReplacementMap.set(`/icons/${cfg.itemType}/${cfg.itemId}`, objectUrl);
            itemIconReplacementMap.set(`/icons/${cfg.itemType}/${cfg.itemId}.png`, objectUrl);
        });

        const monsterConfigs = await getAllMonsterImageConfigs();
        monsterConfigs.forEach((cfg) => {
            if (!cfg || !cfg.enabled || !cfg.imageBlob || !cfg.icon) return;
            const objectUrl = URL.createObjectURL(cfg.imageBlob);
            itemIconReplacementMap.set(`/icons/monster/${cfg.icon}`, objectUrl);
        });
    }

    /** replaceItemIconForImageElement: function */
    function replaceItemIconForImageElement(img) {
        if (!img || !img.src) return;
        let pathname = '';
        const originalSrc = img.dataset.qbtoolsOriginalSrc || img.src;
        try {
            pathname = new URL(originalSrc, window.location.origin).pathname;
        } catch (e) {
            return;
        }
        const replacement = itemIconReplacementMap.get(pathname);
        if (!replacement) {
            if (img.dataset.qbtoolsOriginalSrc && img.dataset.qbtoolsReplacedSrc) {
                img.src = img.dataset.qbtoolsOriginalSrc;
                delete img.dataset.qbtoolsReplacedSrc;
            }
            return;
        }
        if (!img.dataset.qbtoolsOriginalSrc) {
            img.dataset.qbtoolsOriginalSrc = originalSrc;
        }
        if (img.dataset.qbtoolsReplacedSrc === replacement) return;
        img.src = replacement;
        img.dataset.qbtoolsReplacedSrc = replacement;
    }

    /** applyItemIconReplacements: function */
    function applyItemIconReplacements() {
        document.querySelectorAll('img').forEach((img) => {
            replaceItemIconForImageElement(img);
        });
    }

    async function initItemIconReplacement() {
        try {
            await refreshItemIconReplacementMap();
            applyItemIconReplacements();

            if (itemIconObserver) {
                itemIconObserver.disconnect();
            }
            itemIconObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes' && mutation.target.tagName === 'IMG') {
                        replaceItemIconForImageElement(mutation.target);
                    }
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType !== 1) return;
                        if (node.tagName === 'IMG') {
                            replaceItemIconForImageElement(node);
                        }
                        node.querySelectorAll?.('img').forEach((img) => replaceItemIconForImageElement(img));
                    });
                });
            });
            itemIconObserver.observe(document.body, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['src'],
            });
        } catch (error) {
            console.error('Failed to initialize item icon replacement:', error);
        }
    }

    /** initBattlefieldMonsterAreaObserver: function */
    function initBattlefieldMonsterAreaObserver() {
        let currentTarget = null;
        let rafId = 0;

        const scheduleApply = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                console.log('[QBTools] monster-area changed, re-apply icon replacements');
                applyItemIconReplacements();
            });
        };

        const bindTargetObserver = () => {
            const target = document.querySelector('.battlefield .monster-area');
            if (!target) return;
            if (currentTarget === target && battlefieldMonsterAreaObserver) return;

            if (battlefieldMonsterAreaObserver) {
                battlefieldMonsterAreaObserver.disconnect();
            }

            currentTarget = target;
            battlefieldMonsterAreaObserver = new MutationObserver(() => {
                scheduleApply();
            });
            battlefieldMonsterAreaObserver.observe(target, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
            });

            scheduleApply();
        };

        bindTargetObserver();

        const rootObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && (mutation.addedNodes.length || mutation.removedNodes.length)) {
                    bindTargetObserver();
                    break;
                }
            }
        });
        rootObserver.observe(document.body, { subtree: true, childList: true });
    }

    GM_addStyle(`
        .qbtools-sidebar {
            position: fixed;
            right: 0;
            top: 0;
            width: 500px;
            height: 100vh;
            background: #f8f9fa;
            border-left: 1px solid #dee2e6;
            z-index: 9999;
            font-family: Arial, sans-serif;
            box-shadow: -2px 0 10px rgba(0,0,0,0.1);
            transition: transform 0.3s ease;
            display: flex;
            flex-direction: column;
        }
        .qbtools-sidebar.hidden {
            transform: translateX(100%);
        }
        .qbtools-header {
            padding: 20px;
            background: #28a745;
            color: #000;
            text-align: center;
            position: relative;
        }
        .qbtools-header h1 {
            margin: 0;
            font-size: 24px;
            font-weight: bold;
            color: white;
        }
        .qbtools-hide-btn {
            position: absolute;
            top: 10px;
            right: 10px;
            padding: 5px 10px;
            background: rgba(255,255,255,0.2);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.2s;
        }
        .qbtools-hide-btn:hover {
            background: rgba(255,255,255,0.3);
        }
        .qbtools-divider {
            height: 2px;
            background: linear-gradient(to right, transparent, #dee2e6, transparent);
            margin: 0;
        }
        .qbtools-tabs {
            display: flex;
            background: #e9ecef;
            border-bottom: 1px solid #dee2e6;
        }
        .qbtools-tab {
            flex: 1;
            padding: 12px;
            background: none;
            border: none;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            color: #495057;
            transition: background 0.2s, color 0.2s;
        }
        .qbtools-tab:hover {
            background: #dee2e6;
        }
        .qbtools-tab.active {
            background: #f8f9fa;
            color: #28a745;
            border-bottom: 2px solid #28a745;
        }
        .qbtools-content {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
        }
        .qbtools-tab-panel {
            display: none;
        }
        .qbtools-tab-panel.active {
            display: block;
        }
        .qbtools-button {
            width: 100%;
            padding: 12px;
            background: #28a745;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            transition: background 0.2s;
        }
        .qbtools-button:hover {
            background: #218838;
        }
        .qbtools-status {
            margin-top: 15px;
            padding: 10px;
            background: #e7f3ff;
            border-radius: 4px;
            font-size: 12px;
            color: #004085;
            text-align: center;
            min-height: 20px;
        }
        .show-sidebar-btn {
            position: fixed;
            right: 0;
            top: 50%;
            transform: translateY(-50%);
            padding: 15px 8px;
            background: #28a745;
            color: white;
            border: none;
            border-radius: 4px 0 0 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            z-index: 9998;
            box-shadow: -2px 0 5px rgba(0,0,0,0.1);
            display: none;
            writing-mode: vertical-rl;
            text-orientation: mixed;
        }
        .show-sidebar-btn:hover {
            background: #218838;
        }
        /* 资源子tab样式 */
        .resource-subtabs {
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
        }
        .resource-subtabs-header {
            display: flex;
            background: #e9ecef;
            border-bottom: 1px solid #dee2e6;
        }
        .resource-subtab {
            flex: 1;
            padding: 10px;
            background: none;
            border: none;
            cursor: pointer;
            font-size: 13px;
            font-weight: bold;
            color: #495057;
            transition: background 0.2s, color 0.2s;
        }
        .resource-subtab:hover {
            background: #dee2e6;
        }
        .resource-subtab.active {
            background: #f8f9fa;
            color: #28a745;
            border-bottom: 2px solid #28a745;
        }
        .resource-subtabs-content {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
        }
        .resource-subtab-panel {
            display: none;
            height: 100%;
        }
        .resource-subtab-panel.active {
            display: block;
        }
        /* 物品列表样式 */
        .items-list {
            height: 100%;
            overflow-y: auto;
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
        }
        .item-item {
            padding: 8px 12px;
            cursor: pointer;
            transition: background 0.2s;
            flex: 0 0 48%;
            margin: 1%;
            border: 1px solid #dee2e6;
            border-radius: 4px;
            background: white;
            color:black;
        }
        .item-item:hover {
            background: #f8f9fa;
        }
        .item-config-view {
            display: none;
        }
        .item-config-header {
            display: grid;
            grid-template-columns: auto 1fr auto;
            align-items: center;
            margin-bottom: 12px;
            gap: 8px;
        }
        .item-config-title {
            text-align: center;
            font-weight: 700;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color:black;
        }
        .item-config-card {
            border: 1px solid #dee2e6;
            border-radius: 8px;
            padding: 12px;
            background: #fff;
            color:black;
        }
        .item-config-preview {
            width: 120px;
            height: 120px;
            object-fit: contain;
            border: 1px solid #ced4da;
            border-radius: 6px;
            background: #f8f9fa;
            display: none;
            margin: 8px 0;
        }
        .item-config-radio-group {
            display: flex;
            gap: 16px;
            margin: 8px 0 12px 0;
        }
        .item-config-actions {
            display: flex;
            gap: 8px;
        }
        .item-config-actions .qbtools-button {
            margin-top: 0;
        }
        .qbtools-input {
            width: 100%;
            box-sizing: border-box;
            padding: 8px;
            border: 1px solid #ced4da;
            border-radius: 4px;
            margin-bottom: 8px;
            font-size: 13px;
        }
        .qbtools-input:disabled {
            background: #f1f3f5;
            color: #868e96;
        }
        .qbtools-ws-actions {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        }
        .qbtools-ws-actions .qbtools-button {
            width: auto;
            flex: 1;
            margin: 0;
            padding: 8px;
        }
        .qbtools-ws-log {
            height: 360px;
            border: 1px solid #dee2e6;
            border-radius: 4px;
            background: #fff;
            padding: 8px;
            font-family: Consolas, Monaco, monospace;
            font-size: 12px;
            white-space: pre;
            overflow-y: auto;
            resize: vertical;
            width: 100%;
            box-sizing: border-box;
        }
        .data-subtabs {
            margin-top: 12px;
            border: 1px solid #dee2e6;
            border-radius: 6px;
            background: #fff;
            overflow: hidden;
        }
        .data-subtabs-header {
            display: flex;
            background: #e9ecef;
            border-bottom: 1px solid #dee2e6;
        }
        .data-subtab {
            flex: 1;
            padding: 9px 10px;
            background: none;
            border: none;
            cursor: pointer;
            font-size: 13px;
            font-weight: 700;
            color: #495057;
            transition: background 0.2s, color 0.2s;
        }
        .data-subtab:hover {
            background: #dee2e6;
        }
        .data-subtab.active {
            background: #fff;
            color: #28a745;
            border-bottom: 2px solid #28a745;
        }
        .data-subtabs-content {
            padding: 12px;
            max-height: 520px;
            overflow: auto;
        }
        .data-subtab-panel {
            display: none;
        }
        .data-subtab-panel.active {
            display: block;
        }
        .qbtools-data-empty {
            color: #6c757d;
            font-size: 13px;
            line-height: 1.5;
            text-align: center;
            padding: 24px 8px;
        }
        .qbtools-data-section-title {
            margin: 10px 0 8px;
            font-size: 14px;
            color: #212529;
        }
        .qbtools-data-section-title:first-child {
            margin-top: 0;
        }
        .qbtools-data-table-wrap {
            width: 100%;
            overflow-x: auto;
            margin-bottom: 14px;
            border: 1px solid #dee2e6;
            border-radius: 4px;
        }
        .qbtools-data-table {
            width: 100%;
            border-collapse: collapse;
            table-layout: auto;
            font-size: 12px;
            background: #fff;
        }
        .qbtools-data-table th,
        .qbtools-data-table td {
            border-bottom: 1px solid #e9ecef;
            border-right: 1px solid #e9ecef;
            padding: 7px 8px;
            text-align: left;
            vertical-align: top;
            color: #212529;
            word-break: break-word;
        }
        .qbtools-data-table th:last-child,
        .qbtools-data-table td:last-child {
            border-right: none;
        }
        .qbtools-data-table tbody tr:last-child td {
            border-bottom: none;
        }
        .qbtools-data-table th {
            position: sticky;
            top: 0;
            background: #f1f3f5;
            z-index: 1;
            font-weight: 700;
        }
        .qbtools-monster-weight-table {
            min-width:300px;
        }
        #data-subtab-recipes th,
        #data-subtab-recipes td {
            width: 20%;
        }
        .qbtools-monster-weight-table th,
        .qbtools-monster-weight-table td {
            width: 50%;
        }
        .qbtools-empty-cell {
            color: #6c757d;
            text-align: center !important;
        }
    `);

    // 状态更新函数
    /** updateStatus: function */
    function updateStatus(message) {
        const statusElement = document.getElementById('qbtools-status');
        if (statusElement) {
            const now = new Date().toLocaleTimeString();
            statusElement.textContent = `[${now}] ${message}`;
        }
    }

    // 切换tab
    /** switchTab: function */
    function switchTab(tabName) {
        // 更新tab按钮状态
        document.querySelectorAll('.qbtools-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

        // 更新tab面板显示
        document.querySelectorAll('.qbtools-tab-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        document.getElementById(`tab-${tabName}`).classList.add('active');
    }

    // 切换资源子tab
    /** switchResourceSubTab: function */
    function switchResourceSubTab(subtabName) {
        // 更新子tab按钮状态
        document.querySelectorAll('.resource-subtab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelector(`[data-subtab="${subtabName}"]`).classList.add('active');

        // 更新子tab面板显示
        document.querySelectorAll('.resource-subtab-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        document.getElementById(`subtab-${subtabName}`).classList.add('active');

        // 如果切换到物品tab，显示物品列表
        if (subtabName === 'items') {
            displayItemsList();
        } else if (subtabName === 'monsters') {
            displayMonstersList();
        }
    }

    /** switchDataSubTab: function */
    function switchDataSubTab(subtabName) {
        document.querySelectorAll('.data-subtab').forEach(tab => {
            tab.classList.remove('active');
        });
        const targetTab = document.querySelector(`.data-subtab[data-data-subtab="${subtabName}"]`);
        if (targetTab) {
            targetTab.classList.add('active');
        }

        document.querySelectorAll('.data-subtab-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        const targetPanel = document.getElementById(`data-subtab-${subtabName}`);
        if (targetPanel) {
            targetPanel.classList.add('active');
        }

        if (subtabName === 'recipes') {
            renderRecipeDataTable();
        } else if (subtabName === 'monster-weights') {
            renderMonsterWeightDataTable();
        } else if (subtabName === 'market') {
            renderMarketOverviewTable();
        }
    }

    // 显示物品列表
    /** displayItemsList: function */
    function displayItemsList() {
        const itemsListElement = document.getElementById('items-list');
        if (!itemsListElement) return;
        const searchInput = document.getElementById('items-search-input');
        const keyword = (searchInput?.value || '').trim().toLowerCase();

        try {
            // 从localStorage获取items数据
            const itemsData = getGameData();
            cachedItemsData = itemsData || {};

            if (!itemsData || Object.keys(itemsData).length === 0) {
                itemsListElement.innerHTML = '<p style="color: #6c757d; text-align: center; margin-top: 20px;">暂无物品数据</p>';
                return;
            }

            // 构建物品列表
            let itemsHtml = '';
            for (const itemId in itemsData) {
                const item = itemsData[itemId];
                const itemName = item.name || itemId;
                const matchText = `${itemId} ${itemName}`.toLowerCase();
                if (keyword && !matchText.includes(keyword)) {
                    continue;
                }
                itemsHtml += `<div class="item-item" data-item-id="${itemId}">${itemName}</div>`;
            }

            itemsListElement.innerHTML = itemsHtml || '<p style="color: #6c757d; text-align: center; margin-top: 20px;">无匹配结果</p>';
        } catch (error) {
            console.error('显示物品列表失败:', error);
            itemsListElement.innerHTML = '<p style="color: #dc3545; text-align: center; margin-top: 20px;">加载失败</p>';
        }
    }

    /** displayMonstersList: function */
    function displayMonstersList() {
        const monstersListElement = document.getElementById('monsters-list');
        if (!monstersListElement) return;
        const searchInput = document.getElementById('monsters-search-input');
        const keyword = (searchInput?.value || '').trim().toLowerCase();

        try {
            const monstersData = getMonsterData();
            cachedMonstersData = monstersData || {};

            if (!monstersData || Object.keys(monstersData).length === 0) {
                monstersListElement.innerHTML = '<p style="color: #6c757d; text-align: center; margin-top: 20px;">暂无怪物数据</p>';
                return;
            }

            let monstersHtml = '';
            for (const monsterId in monstersData) {
                const monster = monstersData[monsterId];
                const monsterName = monster.name || monsterId;
                const matchText = `${monsterId} ${monsterName}`.toLowerCase();
                if (keyword && !matchText.includes(keyword)) {
                    continue;
                }
                monstersHtml += `<div class="item-item" data-monster-id="${monsterId}">${monsterName}</div>`;
            }
            monstersListElement.innerHTML = monstersHtml || '<p style="color: #6c757d; text-align: center; margin-top: 20px;">无匹配结果</p>';
        } catch (error) {
            console.error('显示怪物列表失败:', error);
            monstersListElement.innerHTML = '<p style="color: #dc3545; text-align: center; margin-top: 20px;">加载失败</p>';
        }
    }

    /** buildListStateMessage: function */
    function buildListStateMessage(message, color) {
        return `<p style="color: ${color}; text-align: center; margin-top: 20px;">${message}</p>`;
    }

    /** sortResourceEntriesByFavoriteItems: function */
    function sortResourceEntriesByFavoriteItems(entries) {
        const favoriteOrderMap = new Map();
        getFavoriteItems().forEach((item, index) => {
            favoriteOrderMap.set(String(item.id), index);
        });
        if (!favoriteOrderMap.size) return entries;

        return entries
            .map((entry, index) => ({ entry, index }))
            .sort((left, right) => {
                const leftFavoriteOrder = favoriteOrderMap.has(String(left.entry[0]))
                    ? favoriteOrderMap.get(String(left.entry[0]))
                    : Number.MAX_SAFE_INTEGER;
                const rightFavoriteOrder = favoriteOrderMap.has(String(right.entry[0]))
                    ? favoriteOrderMap.get(String(right.entry[0]))
                    : Number.MAX_SAFE_INTEGER;

                if (leftFavoriteOrder !== rightFavoriteOrder) {
                    return leftFavoriteOrder - rightFavoriteOrder;
                }
                return left.index - right.index;
            })
            .map((item) => item.entry);
    }

    /** renderNamedResourceList: function */
    function renderNamedResourceList({
        listElementId,
        searchInputId,
        getData,
        setCache,
        itemDataAttribute,
        emptyText,
        noMatchText,
        errorLogMessage,
        sortEntries,
    }) {
        const listElement = document.getElementById(listElementId);
        if (!listElement) return;

        const searchInput = document.getElementById(searchInputId);
        const keyword = (searchInput?.value || '').trim().toLowerCase();

        try {
            const resourceData = getData();
            const normalizedData = isObjectRecord(resourceData) ? resourceData : {};
            setCache(normalizedData);

            if (!hasObjectEntries(normalizedData)) {
                listElement.innerHTML = buildListStateMessage(emptyText, '#6c757d');
                return;
            }

            let resourceEntries = Object.entries(normalizedData)
                .filter(([resourceId, resource]) => {
                    const resourceName = resource?.name || resourceId;
                    const matchText = `${resourceId} ${resourceName}`.toLowerCase();
                    return !keyword || matchText.includes(keyword);
                });
            if (typeof sortEntries === 'function') {
                resourceEntries = sortEntries(resourceEntries);
            }

            const itemsHtml = resourceEntries
                .map(([resourceId, resource]) => {
                    const resourceName = resource?.name || resourceId;
                    return `<div class="item-item" data-${itemDataAttribute}="${resourceId}">${resourceName}</div>`;
                })
                .join('');

            listElement.innerHTML = itemsHtml || buildListStateMessage(noMatchText, '#6c757d');
        } catch (error) {
            console.error(errorLogMessage, error);
            listElement.innerHTML = buildListStateMessage('\u52a0\u8f7d\u5931\u8d25', '#dc3545');
        }
    }

    /** displayItemsListRefactored: function expression */
    displayItemsList = function displayItemsListRefactored() {
        renderNamedResourceList({
            listElementId: 'items-list',
            searchInputId: 'items-search-input',
            getData: getGameData,
            setCache: (data) => {
                cachedItemsData = data;
            },
            itemDataAttribute: 'item-id',
            emptyText: '\u6682\u65e0\u7269\u54c1\u6570\u636e',
            noMatchText: '\u65e0\u5339\u914d\u7ed3\u679c',
            errorLogMessage: 'Failed to display items list:',
            sortEntries: sortResourceEntriesByFavoriteItems,
        });
    };

    /** displayMonstersListRefactored: function expression */
    displayMonstersList = function displayMonstersListRefactored() {
        renderNamedResourceList({
            listElementId: 'monsters-list',
            searchInputId: 'monsters-search-input',
            getData: getMonsterData,
            setCache: (data) => {
                cachedMonstersData = data;
            },
            itemDataAttribute: 'monster-id',
            emptyText: '\u6682\u65e0\u602a\u7269\u6570\u636e',
            noMatchText: '\u65e0\u5339\u914d\u7ed3\u679c',
            errorLogMessage: 'Failed to display monsters list:',
        });
    };

    /** createSidebar: function */
    function createSidebar() {
        // 创建侧边栏容器
        const sidebar = document.createElement('div');
        sidebar.className = 'qbtools-sidebar';
        sidebar.id = 'qbtools-sidebar';

        sidebar.innerHTML = `
            <div class="qbtools-header">
                <button class="qbtools-hide-btn" id="hide-sidebar-btn">×</button>
                <h1>QBTools</h1>
            </div>
            <div class="qbtools-divider"></div>
            <div class="qbtools-tabs">
                <button class="qbtools-tab active" data-tab="resource">资源</button>
                <button class="qbtools-tab" data-tab="data">数据</button>
                <button class="qbtools-tab" data-tab="automation">自动化</button>
            </div>
            <div class="qbtools-content">
                <div class="qbtools-tab-panel active" id="tab-resource">
                    <div class="resource-subtabs">
                        <div class="resource-subtabs-header">
                            <button class="resource-subtab active" data-subtab="items">物品</button>
                            <button class="resource-subtab" data-subtab="monsters">怪物</button>
                        </div>
                        <div class="resource-subtabs-content">
                            <div class="resource-subtab-panel active" id="subtab-items">
                                <div id="items-list-view">
                                    <input class="qbtools-input" id="items-search-input" placeholder="Search items by id or name" />
                                    <div class="items-list" id="items-list">
                                        <p style="color: #6c757d; text-align: center; margin-top: 20px;">加载中...</p>
                                    </div>
                                </div>
                                <div class="item-config-view" id="item-config-view">
                                    <div class="item-config-header">
                                        <button class="qbtools-button" id="item-config-back-btn">Back to List</button>
                                        <div class="item-config-title" id="item-config-title">-</div>
                                        <div></div>
                                    </div>
                                    <div class="item-config-card">
                                        <h4>Favorite</h4>
                                        <div class="item-config-radio-group">
                                            <label><input type="radio" name="item-config-favorite" id="item-config-favorite-yes" /> Yes</label>
                                            <label><input type="radio" name="item-config-favorite" id="item-config-favorite-no" checked /> No</label>
                                        </div>
                                    </div>
                                    <div class="item-config-card">
                                        <h4>Image Resource</h4>
                                        <input type="file" id="item-image-file-input" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,image/png,image/jpeg,image/gif,image/webp,image/bmp" style="display:none;" />
                                        <div class="item-config-actions">
                                            <button class="qbtools-button" id="item-select-image-btn">Choose Image</button>
                                            <button class="qbtools-button" id="item-save-config-btn">Save</button>
                                        </div>
                                        <img id="item-image-preview" class="item-config-preview" alt="preview" />
                                        <div class="item-config-radio-group">
                                            <label><input type="radio" name="item-config-enabled" id="item-config-enabled-yes" checked /> Enabled</label>
                                            <label><input type="radio" name="item-config-enabled" id="item-config-enabled-no" /> Disabled</label>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div class="resource-subtab-panel" id="subtab-monsters">
                                <div id="monsters-list-view">
                                    <input class="qbtools-input" id="monsters-search-input" placeholder="Search monsters by id or name" />
                                    <div class="items-list" id="monsters-list">
                                        <p style="color: #6c757d; text-align: center; margin-top: 20px;">加载中...</p>
                                    </div>
                                </div>
                                <div class="item-config-view" id="monster-config-view">
                                    <div class="item-config-header">
                                        <button class="qbtools-button" id="monster-config-back-btn">Back to List</button>
                                        <div class="item-config-title" id="monster-config-title">-</div>
                                        <div></div>
                                    </div>
                                    <div class="item-config-card">
                                        <h4>Image Resource</h4>
                                        <input type="file" id="monster-image-file-input" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,image/png,image/jpeg,image/gif,image/webp,image/bmp" style="display:none;" />
                                        <div class="item-config-actions">
                                            <button class="qbtools-button" id="monster-select-image-btn">Choose Image</button>
                                            <button class="qbtools-button" id="monster-save-config-btn">Save</button>
                                        </div>
                                        <img id="monster-image-preview" class="item-config-preview" alt="preview" />
                                        <div class="item-config-radio-group">
                                            <label><input type="radio" name="monster-config-enabled" id="monster-config-enabled-yes" checked /> Enabled</label>
                                            <label><input type="radio" name="monster-config-enabled" id="monster-config-enabled-no" /> Disabled</label>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="qbtools-tab-panel" id="tab-data">
                    <div class="qbtools-ws-actions">
                        <button class="qbtools-button" id="update-gamedata-btn">更新游戏数据</button>
                        <button class="qbtools-button" id="update-tool-data-btn">更新工具数据</button>
                    </div>
                    <div class="qbtools-ws-actions">
                        <button class="qbtools-button" id="update-market-data-btn">更新市场数据</button>
                        <button class="qbtools-button" id="export-market-data-btn">导出市场数据</button>
                    </div>
                    <div class="qbtools-status" id="qbtools-status">等待操作...</div>
                    <div class="data-subtabs">
                        <div class="data-subtabs-header">
                            <button class="data-subtab active" data-data-subtab="market">市场</button>
                            <button class="data-subtab" data-data-subtab="recipes">食谱</button>
                            <button class="data-subtab" data-data-subtab="monster-weights">怪物权重</button>
                        </div>
                        <div class="data-subtabs-content">
                            <div class="data-subtab-panel active" id="data-subtab-market">
                                <div class="qbtools-data-empty">暂无内容</div>
                            </div>
                            <div class="data-subtab-panel" id="data-subtab-recipes">
                                <div id="qbtools-recipe-data">
                                    <div class="qbtools-data-empty">暂无游戏数据，请先更新游戏数据</div>
                                </div>
                            </div>
                            <div class="data-subtab-panel" id="data-subtab-monster-weights">
                                <div id="qbtools-monster-weight-data">
                                    <div class="qbtools-data-empty">暂无游戏数据，请先更新游戏数据</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="qbtools-tab-panel" id="tab-automation">
                    <div class="item-config-card">
                        <h4>生产后战斗</h4>
                        <div class="item-config-actions">
                            <select class="qbtools-input" id="production-combat-area-select"></select>
                            <button class="qbtools-button" id="save-production-combat-area-btn">确定</button>
                            <button class="qbtools-button" id="clear-production-combat-area-btn">清除</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(sidebar);

        // 创建显示侧边栏按钮
        const showBtn = document.createElement('button');
        showBtn.className = 'show-sidebar-btn';
        showBtn.id = 'show-sidebar-btn';
        showBtn.textContent = 'QBTools';
        document.body.appendChild(showBtn);

        // 绑定tab切换事件
        document.querySelectorAll('.qbtools-tab').forEach(tab => {
            tab.addEventListener('click', function () {
                const tabName = this.getAttribute('data-tab');
                switchTab(tabName);
            });
        });

        // 绑定资源子tab切换事件
        document.querySelectorAll('.resource-subtab').forEach(tab => {
            tab.addEventListener('click', function () {
                const subtabName = this.getAttribute('data-subtab');
                switchResourceSubTab(subtabName);
            });
        });

        document.querySelectorAll('.data-subtab').forEach(tab => {
            tab.addEventListener('click', function () {
                const subtabName = this.getAttribute('data-data-subtab');
                switchDataSubTab(subtabName);
            });
        });

        // 绑定更新按钮事件
        document.getElementById('update-gamedata-btn').addEventListener('click', function () {
            forceUpdateData().then(() => {
                renderRecipeDataTable();
                renderMonsterWeightDataTable();
            });
        });
        document.getElementById('update-tool-data-btn').addEventListener('click', function () {
            updateToolDataCache();
        });
        document.getElementById('update-market-data-btn').addEventListener('click', function () {
            requestMarketOverviewData();
        });
        document.getElementById('export-market-data-btn').addEventListener('click', function () {
            exportMarketOverviewData();
        });
        const saveProductionCombatAreaBtn = document.getElementById('save-production-combat-area-btn');
        if (saveProductionCombatAreaBtn) {
            saveProductionCombatAreaBtn.addEventListener('click', function () {
                saveProductionCombatAreaSelection();
            });
        }
        const clearProductionCombatAreaBtn = document.getElementById('clear-production-combat-area-btn');
        if (clearProductionCombatAreaBtn) {
            clearProductionCombatAreaBtn.addEventListener('click', function () {
                clearProductionCombatAreaSelection();
            });
        }

        const itemsList = document.getElementById('items-list');
        const itemsSearchInput = document.getElementById('items-search-input');
        const itemConfigBackBtn = document.getElementById('item-config-back-btn');
        const itemSelectImageBtn = document.getElementById('item-select-image-btn');
        const itemSaveConfigBtn = document.getElementById('item-save-config-btn');
        const itemImageFileInput = document.getElementById('item-image-file-input');
        const itemFavoriteYes = document.getElementById('item-config-favorite-yes');
        const itemFavoriteNo = document.getElementById('item-config-favorite-no');

        if (itemsList) {
            itemsList.addEventListener('click', function (event) {
                const itemNode = event.target.closest('.item-item');
                if (!itemNode) return;
                const itemId = itemNode.getAttribute('data-item-id');
                if (!itemId || !cachedItemsData[itemId]) return;

                const itemData = {
                    id: itemId,
                    ...cachedItemsData[itemId],
                };
                openItemConfigView(itemData).catch((error) => {
                    console.error('Failed to open item config view:', error);
                });
            });
        }
        if (itemsSearchInput) {
            itemsSearchInput.addEventListener('input', function () {
                displayItemsList();
            });
        }

        if (itemConfigBackBtn) {
            itemConfigBackBtn.addEventListener('click', function () {
                setItemEditorVisible(false);
                displayItemsList();
            });
        }

        if (itemFavoriteYes && itemFavoriteNo) {
            /** onFavoriteChanged: local function expression */
            const onFavoriteChanged = function () {
                if (!itemEditorState.selectedItem) return;
                setFavoriteItem(itemEditorState.selectedItem, itemFavoriteYes.checked);
            };
            itemFavoriteYes.addEventListener('change', onFavoriteChanged);
            itemFavoriteNo.addEventListener('change', onFavoriteChanged);
        }

        if (itemSelectImageBtn && itemImageFileInput) {
            itemSelectImageBtn.addEventListener('click', function () {
                itemImageFileInput.click();
            });
            itemImageFileInput.addEventListener('change', function () {
                const file = itemImageFileInput.files && itemImageFileInput.files[0];
                if (!file) return;
                if (!isAllowedImageFile(file)) {
                    alert('Only common image formats are allowed: PNG/JPG/JPEG/GIF/WebP/BMP');
                    itemImageFileInput.value = '';
                    return;
                }
                itemEditorState.selectedImageBlob = file;
                setItemImagePreview(file);
            });
        }

        if (itemSaveConfigBtn) {
            itemSaveConfigBtn.addEventListener('click', function () {
                saveCurrentItemConfig().catch((error) => {
                    console.error('Failed to save item config:', error);
                    alert('Failed to save item config');
                });
            });
        }

        const monstersList = document.getElementById('monsters-list');
        const monstersSearchInput = document.getElementById('monsters-search-input');
        const monsterConfigBackBtn = document.getElementById('monster-config-back-btn');
        const monsterSelectImageBtn = document.getElementById('monster-select-image-btn');
        const monsterSaveConfigBtn = document.getElementById('monster-save-config-btn');
        const monsterImageFileInput = document.getElementById('monster-image-file-input');

        if (monstersList) {
            monstersList.addEventListener('click', function (event) {
                const monsterNode = event.target.closest('.item-item');
                if (!monsterNode) return;
                const monsterId = monsterNode.getAttribute('data-monster-id');
                if (!monsterId || !cachedMonstersData[monsterId]) return;

                const monsterData = {
                    id: monsterId,
                    ...cachedMonstersData[monsterId],
                };
                openMonsterConfigView(monsterData).catch((error) => {
                    console.error('Failed to open monster config view:', error);
                });
            });
        }
        if (monstersSearchInput) {
            monstersSearchInput.addEventListener('input', function () {
                displayMonstersList();
            });
        }

        if (monsterConfigBackBtn) {
            monsterConfigBackBtn.addEventListener('click', function () {
                setMonsterEditorVisible(false);
            });
        }

        if (monsterSelectImageBtn && monsterImageFileInput) {
            monsterSelectImageBtn.addEventListener('click', function () {
                monsterImageFileInput.click();
            });
            monsterImageFileInput.addEventListener('change', function () {
                const file = monsterImageFileInput.files && monsterImageFileInput.files[0];
                if (!file) return;
                if (!isAllowedImageFile(file)) {
                    alert('Only common image formats are allowed: PNG/JPG/JPEG/GIF/WebP/BMP');
                    monsterImageFileInput.value = '';
                    return;
                }
                monsterEditorState.selectedImageBlob = file;
                setMonsterImagePreview(file);
            });
        }

        if (monsterSaveConfigBtn) {
            monsterSaveConfigBtn.addEventListener('click', function () {
                saveCurrentMonsterConfig().catch((error) => {
                    console.error('Failed to save monster config:', error);
                    alert('Failed to save monster config');
                });
            });
        }

        document.getElementById('hide-sidebar-btn').addEventListener('click', function () {
            sidebar.classList.add('hidden');
            showBtn.style.display = 'block';
        });

        // 绑定显示按钮事件
        showBtn.addEventListener('click', function () {
            sidebar.classList.remove('hidden');
            showBtn.style.display = 'none';
        });

        setWsUiState();
        displayItemsList();
        displayMonstersList();
        renderMarketOverviewTable();
        renderRecipeDataTable();
        renderMonsterWeightDataTable();
        populateProductionCombatAreaOptions();
        renderWsLogBuffer();
    }

    // 初始化
    /** init: function */
    function init() {
        console.log('QBTools脚本已加载');
        createSidebar();
        bindMarketCategoryFavoriteRefresh();
        // 页面加载时检查并同步数据
        checkAndSyncData();
        initItemIconReplacement();
        initBattlefieldMonsterAreaObserver();
    }

    initWebSocketMonitor();

    // 等待页面加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
