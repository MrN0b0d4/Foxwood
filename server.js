
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 🎯 SINGLE USER CONFIGURATION
const CONFIG = {
    // User credentials from environment variables
    USER_ID: process.env.USER_ID,
    USER_CLAIM_ACH_ID: process.env.USER_CLAIM_ACH_ID,
    REFRESH_TOKEN: process.env.REFRESH_TOKEN,
    
    // Base URLs from environment
    BASE_URL: process.env.BASE_URL,
    BASE_URL_REF: process.env.BASE_URL_REF,
    BASE_URL_MONEY: process.env.BASE_URL_MONEY,
    BASE_URL_SPRAY: process.env.BASE_URL_SPRAY,
    BASE_URL_ACH: process.env.BASE_URL_ACH,
    BASE_URL_PACKS: process.env.BASE_URL_PACKS || 'https://api.kolex.gg/api/v1/packs',
    BASE_URL_SPINNER: process.env.BASE_URL_SPINNER || 'https://api.kolex.gg/api/v1/spinner',
};

// Global storage for user data
let userData = {
    jwtToken: null,
    lastRefresh: null,
    nextSpinTime: null,
    spinCount: 0,
    achievementsClaimed: 0,
    lastFunds: 0,
    logs: [],
    isActive: false,
    dailyFundsChecks: 0,
    dailyAchievementsDone: false,
    
    // Scheduling parameters (default weekday)
    dayStart: '07:40',    // CET = UTC+1 (06:40 UTC)
    dayEnd: '23:59',      // CET = UTC+1 (22:59 UTC)
    jitter: 22,           // minutes
    baseInterval: 30,     // minutes
    randomScale1: 0,      // minutes
    randomScale2: 21,     // minutes
    
    // Weekend parameters
    weekendDayStart: '08:44',    // CET = UTC+1 (07:44 UTC)
    weekendDayEnd: '23:47',      // CET = UTC+1 (22:47 UTC)
    weekendJitter: 42,           // minutes
    weekendBaseInterval: 30,     // minutes
    weekendRandomScale1: 5,      // minutes
    weekendRandomScale2: 41,     // minutes
};

// Debug logs storage
const debugLogs = [];

// Debug logging function
function debugLog(action, url, method, headers = {}, data = null, response = null, error = null) {
    const debugEntry = {
        timestamp: new Date().toISOString(),
        action,
        request: {
            url,
            method,
            headers: JSON.stringify(headers, null, 2),
            body: data ? JSON.stringify(data, null, 2) : null
        },
        response: response ? {
            status: response.status,
            data: JSON.stringify(response.data, null, 2)
        } : null,
        error: error ? {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data ? JSON.stringify(error.response.data, null, 2) : null
        } : null
    };

    debugLogs.unshift(debugEntry);
    if (debugLogs.length > 200) debugLogs.pop();

    console.log('\n' + '='.repeat(80));
    console.log(`🔍 DEBUG [${debugEntry.timestamp}]`);
    console.log(`📝 ACTION: ${action}`);
    console.log(`📡 REQUEST: ${method} ${url}`);
    
    if (error) {
        console.log(`❌ ERROR: ${error.message}`);
    } else if (response) {
        console.log(`✅ RESPONSE: ${response.status}`);
    }
    console.log('='.repeat(80) + '\n');
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API request function
async function makeAPIRequest(url, method = 'GET', headers = {}, data = null) {
    try {
        debugLog('SENDING_REQUEST', url, method, headers, data);
        
        const response = await axios({
            method: method.toLowerCase(),
            url: url,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            },
            data: data,
            timeout: 10000
        });

        debugLog('REQUEST_SUCCESS', url, method, headers, data, response);
        return { success: true, data: response.data, status: response.status };
        
    } catch (error) {
        debugLog('REQUEST_ERROR', url, method, headers, data, null, error);
        return {
            success: false,
            error: error.message,
            status: error.response?.status,
            responseData: error.response?.data
        };
    }
}

// Activity logging
function logActivity(message) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, message };

    userData.logs.unshift(logEntry);
    userData.logs = userData.logs.slice(0, 1000);
    
    console.log(`[${timestamp}] ${message}`);
}

// Check if it's weekend (Saturday or Sunday)
function isWeekend(date = new Date()) {
    const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
    return day === 0 || day === 6;
}

// Get scheduling parameters for specific date
function getSchedulingParams(date = new Date()) {
    if (isWeekend(date)) {
        return {
            dayStart: userData.weekendDayStart,
            dayEnd: userData.weekendDayEnd,
            jitter: userData.weekendJitter,
            baseInterval: userData.weekendBaseInterval,
            randomScale1: userData.weekendRandomScale1,
            randomScale2: userData.weekendRandomScale2
        };
    } else {
        return {
            dayStart: userData.dayStart,
            dayEnd: userData.dayEnd,
            jitter: userData.jitter,
            baseInterval: userData.baseInterval,
            randomScale1: userData.randomScale1,
            randomScale2: userData.randomScale2
        };
    }
}

// Convert CET to UTC (CET = UTC+1)
function cetToUTC(cetTime) {
    const [hours, minutes] = cetTime.split(':').map(Number);
    let utcHours = hours - 1; // CET to UTC
    if (utcHours < 0) utcHours += 24;
    return { hours: utcHours, minutes };
}

// Parse time string to minutes
function timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

// Create date at specific UTC time
function utcDateAt(hour, minute, second = 0, ms = 0, date = new Date()) {
    const d = new Date(date);
    d.setUTCHours(hour, minute, second, ms);
    return d;
}

// Add minutes to date
function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
}

// Add milliseconds to date
function addMs(date, ms) {
    return new Date(date.getTime() + ms);
}

// Token refresh
async function refreshToken() {
    if (!CONFIG.REFRESH_TOKEN) {
        logActivity('ERROR: No refresh token configured');
        return false;
    }

    const headers = { 'Content-Type': 'application/json' };
    const requestData = { refreshToken: CONFIG.REFRESH_TOKEN };

    logActivity('Starting token refresh...');
    const result = await makeAPIRequest(CONFIG.BASE_URL_REF, 'POST', headers, requestData);

    if (result.success && result.data.data?.jwt) {
        userData.jwtToken = result.data.data.jwt;
        userData.lastRefresh = new Date().toISOString();
        userData.isActive = true;

        // Update refresh token if provided
        if (result.data.data?.refreshToken && result.data.data.refreshToken !== 'Not provided') {
            // Note: In production, you might want to update the environment variable
            logActivity('New refresh token received (not stored in this setup)');
        }

        logActivity('✅ Token refresh successful');
        
        // Schedule next token refresh
        scheduleNextTokenRefresh();
        
        return true;
    } else {
        logActivity(`❌ Token refresh failed: ${result.error}`);
        userData.isActive = false;
        return false;
    }
}

// Schedule next token refresh
function scheduleNextTokenRefresh() {
    // Always refresh at 06:40 UTC (07:40 CET)
    const now = new Date();
    let nextRefresh = utcDateAt(6, 40, 0, 0); // 06:40 UTC = 07:40 CET
    
    // If already past today's refresh time, schedule for tomorrow
    if (now >= nextRefresh) {
        nextRefresh = addMinutes(nextRefresh, 24 * 60);
    }
    
    // Add jitter (±22 minutes in milliseconds)
    const jitterMs = (userData.jitter * 60000);
    const randomJitter = Math.floor(Math.random() * (2 * jitterMs + 1)) - jitterMs;
    nextRefresh = addMs(nextRefresh, randomJitter);
    
    const delay = Math.max(nextRefresh.getTime() - Date.now(), 1000);
    
    setTimeout(async () => {
        logActivity(`🔄 Scheduled token refresh (jitter: ${Math.round(randomJitter/60000)}m)`);
        await refreshToken();
    }, delay);
    
    logActivity(`⏰ Next token refresh scheduled for: ${nextRefresh.toUTCString()}`);
}

// Check funds
async function checkFunds() {
    if (!userData.jwtToken) {
        logActivity('ERROR: No JWT token available for funds check');
        return null;
    }

    const headers = { 'x-user-jwt': userData.jwtToken };
    const result = await makeAPIRequest(CONFIG.BASE_URL_MONEY, 'GET', headers);
    
    if (result.success && result.data.data) {
        const silvercoins = result.data.data.silvercoins || 0;
        userData.lastFunds = silvercoins;
        userData.dailyFundsChecks++;
        logActivity(`💰 Funds: ${silvercoins.toLocaleString()} silvercoins`);
        return silvercoins;
    } else {
        if (result.status === 401) {
            logActivity('JWT expired during funds check, attempting refresh...');
            const refreshSuccess = await refreshToken();
            if (refreshSuccess) {
                return await checkFunds();
            }
        }
        logActivity(`❌ Funds check failed: ${result.error}`);
        return null;
    }
}

// Claim achievements
async function claimAchievements() {
    if (!userData.jwtToken) {
        logActivity('ERROR: No JWT token available for achievements');
        return 0;
    }

    const headers = { 'x-user-jwt': userData.jwtToken };
    const userAchievementsUrl = `${CONFIG.BASE_URL_ACH}/${CONFIG.USER_CLAIM_ACH_ID}/user`;
    
    logActivity('🎯 Starting achievements claim process...');

    try {
        // Get available achievements
        const achievementsResult = await makeAPIRequest(userAchievementsUrl, 'GET', headers);
        
        if (!achievementsResult.success) {
            if (achievementsResult.status === 401) {
                logActivity('JWT expired during achievements check, attempting refresh...');
                const refreshSuccess = await refreshToken();
                if (refreshSuccess) {
                    return await claimAchievements();
                }
            }
            logActivity(`❌ Achievements check failed: ${achievementsResult.error}`);
            return 0;
        }

        const validIDs = [];
        const categories = ['achievements', 'daily', 'weekly', 'monthly'];

        // Collect claimable achievement IDs
        categories.forEach((category) => {
            if (achievementsResult.data.data[category]) {
                achievementsResult.data.data[category].forEach((item) => {
                    if (item.progress?.claimAvailable) {
                        validIDs.push(item.id);
                    }
                });
            }
        });

        if (validIDs.length === 0) {
            logActivity('ℹ️ No achievements available to claim');
            return 0;
        }

        // Claim achievements
        let totalClaimed = 0;
        for (const achievementId of validIDs) {
            const claimUrl = `${CONFIG.BASE_URL_ACH}/${achievementId}/claim/`;
            const claimResult = await makeAPIRequest(claimUrl, 'POST', headers);
            
            if (claimResult.success) {
                totalClaimed++;
            }
            
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        userData.achievementsClaimed += totalClaimed;
        logActivity(`🎉 Successfully claimed ${totalClaimed} achievements`);
        return totalClaimed;

    } catch (error) {
        logActivity(`❌ Error in achievements process: ${error.message}`);
        return 0;
    }
}

// Execute spin (for automated schedule - doesn't buy spins)
async function executeSpin() {
    if (!userData.jwtToken) {
        logActivity('ERROR: No JWT token available for spin');
        calculateNextSpinTime();
        return null;
    }

    if (!isWithinActiveWindow()) {
        logActivity('⏰ Outside active window, skipping spin');
        return null;
    }

    logActivity('🎰 Executing free spin...');

    try {
        const headers = {
            'x-user-jwt': userData.jwtToken,
            'Content-Type': 'application/json'
        };

        const spinResult = await makeAPIRequest(CONFIG.BASE_URL_SPRAY, 'POST', headers, { spinnerId: 6799 });

        if (!spinResult.success) {
            if (spinResult.status === 401) {
                logActivity('JWT expired during spin, attempting refresh...');
                await refreshToken();
            }
            logActivity(`⚠️ Spin failed: ${spinResult.error}`);
        } else {
            const spinData = spinResult.data.data;
            const resultId = spinData.id;

            const prizeMap = {
                11755: '5,000 Spraycoins',
                11750: 'Standard Box 2025',
                11749: '500 Spraycoins',
                11754: '1,000,000 Spraycoins',
                11753: '100,000 Spraycoins',
                11752: '2,500 Spraycoins',
                11751: '1,000 Spraycoins',
            };

            const prizeName = prizeMap[resultId] || `ID = ${resultId}`;
            userData.spinCount++;
            logActivity(`🎉 Spin successful! Received: ${prizeName}`);
            return prizeName;
        }
    } catch (error) {
        logActivity(`❌ Spin error: ${error.message}`);
    } finally {
        calculateNextSpinTime();
    }

    return null;
}

// MANUAL SPIN FUNCTION - with buy spin logic (for tools)
async function executeManualSpin() {
    if (!userData.jwtToken) {
        logActivity('ERROR: No JWT token available for manual spin');
        throw new Error('No JWT token available');
    }

    logActivity('🎰 Starting manual spin process...');

    try {
        const headers = {
            'x-user-jwt': userData.jwtToken,
            'Content-Type': 'application/json'
        };

        // 1. First, check spinner user data
        const spinnerUserUrl = `${CONFIG.BASE_URL_SPINNER}/user`;
        const spinnerUserResult = await makeAPIRequest(spinnerUserUrl, 'GET', headers);

        if (!spinnerUserResult.success) {
            if (spinnerUserResult.status === 401) {
                logActivity('JWT expired during spinner check, attempting refresh...');
                const refreshSuccess = await refreshToken();
                if (refreshSuccess) {
                    return await executeManualSpin();
                }
            }
            throw new Error(`Spinner check failed: ${spinnerUserResult.error}`);
        }

        // 2. Check if we need to buy a spin
        const totalLeft = spinnerUserResult.data.data?.totalLeft || 0;
        
        if (totalLeft === 0) {
            logActivity('🛒 No free spins left, buying a spin...');
            
            // Buy a spin
            const buySpinUrl = `${CONFIG.BASE_URL_SPINNER}/buy-spin?categoryId=1`;
            const buySpinResult = await makeAPIRequest(buySpinUrl, 'POST', headers, {
                categoryId: 1,
                amount: 1
            });

            if (!buySpinResult.success) {
                throw new Error(`Buy spin failed: ${buySpinResult.error}`);
            }
            
            logActivity('✅ Spin purchased successfully');
        } else if (totalLeft === 1) {
            logActivity('🎉 Free spin available, skipping purchase');
        }

        // 3. Now execute the spin
        const spinUrl = `${CONFIG.BASE_URL_SPINNER}/spin?categoryId=1`;
        const spinResult = await makeAPIRequest(spinUrl, 'POST', headers, {
            spinnerId: 6799
        });

        if (!spinResult.success) {
            throw new Error(`Spin failed: ${spinResult.error}`);
        }

        // 4. Process the result
        const spinData = spinResult.data.data;
        const resultId = spinData.id;

        const prizeMap = {
            11755: '5,000 Silvercoins',
            11750: 'Core Standard Pack',
            11749: '500 Silvercoins',
            11754: '1,000,000 Silvercoins',
            11753: '100,000 Silvercoins',
            11752: '2,500 Silvercoins',
            11782: 'Core Refresh Pack',
            11881: 'IEM Krakow: Players Pack',
            11751: '1,000 Silvercoins'
        };

        const prizeName = prizeMap[resultId] || `ID = ${resultId}`;
        userData.spinCount++;
        
        logActivity(`🎉 Manual spin successful! Received: ${prizeName}`);
        return { success: true, prize: prizeName, prizeId: resultId };
        
    } catch (error) {
        logActivity(`❌ Manual spin error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Check if within active window
function isWithinActiveWindow() {
    if (!userData._effectiveStartUTC || !userData._effectiveEndUTC) {
        computeEffectiveWindow();
    }

    const now = new Date();
    return now >= userData._effectiveStartUTC && now <= userData._effectiveEndUTC;
}

// Compute effective window for today
function computeEffectiveWindow(date = new Date()) {
    const params = getSchedulingParams(date);
    const cetStart = cetToUTC(params.dayStart);
    const cetEnd = cetToUTC(params.dayEnd);
    
    let effectiveStart = utcDateAt(cetStart.hours, cetStart.minutes, 0, 0, date);
    let effectiveEnd = utcDateAt(cetEnd.hours, cetEnd.minutes, 0, 0, date);
    
    // Handle midnight crossing
    if (effectiveEnd <= effectiveStart) {
        effectiveEnd = addMinutes(effectiveEnd, 24 * 60);
    }
    
    // Add jitter (±jitter minutes)
    const jitterMs = (params.jitter * 60000);
    const randomJitter = Math.floor(Math.random() * (2 * jitterMs + 1)) - jitterMs;
    effectiveStart = addMs(effectiveStart, randomJitter);
    
    userData._effectiveStartUTC = effectiveStart;
    userData._effectiveEndUTC = effectiveEnd;
    userData._startJitterMin = Math.round(randomJitter / 60000);
    
    logActivity(`📅 Effective window: ${effectiveStart.toUTCString()} to ${effectiveEnd.toUTCString()} (jitter: ${userData._startJitterMin}m)`);
    
    return { effectiveStart, effectiveEnd };
}

// Calculate next spin time
function calculateNextSpinTime() {
    const params = getSchedulingParams();
    
    // Convert to milliseconds
    const baseIntervalMs = params.baseInterval * 60000;
    const randomScale1Ms = params.randomScale1 * 60000;
    const randomScale2Ms = params.randomScale2 * 60000;
    
    const randomAddMs = Math.floor(
        Math.random() * (randomScale2Ms - randomScale1Ms) + randomScale1Ms
    );

    const totalDelayMs = baseIntervalMs + randomAddMs;
    const nextSpinTime = new Date(Date.now() + totalDelayMs);
    userData.nextSpinTime = nextSpinTime.toISOString();

    logActivity(`⏰ Next spin in ${Math.round(totalDelayMs / 60000)} minutes (at ${nextSpinTime.toUTCString()})`);
    
    return nextSpinTime;
}

// Schedule daily plan
function scheduleDailyPlan() {
    // Clear existing timers
    if (userData._achTimers) {
        userData._achTimers.forEach(timer => clearTimeout(timer));
    }
    if (userData._dailyRolloverTimer) {
        clearTimeout(userData._dailyRolloverTimer);
    }
    
    userData._achTimers = [];
    
    // Compute today's window
    const now = new Date();
    const { effectiveStart, effectiveEnd } = computeEffectiveWindow(now);
    
    // Schedule achievements
    const claim1 = addMinutes(effectiveStart, 5);
    const claim2 = addMinutes(claim1, 5 * 60);
    const claim3 = addMinutes(effectiveEnd, -5);
    
    // Schedule claim timers
    const scheduleClaim = (when, label) => {
        const delay = when.getTime() - Date.now();
        if (delay <= 0) {
            logActivity(`⏭️ ${label} skipped (time passed)`);
            return;
        }
        
        const timer = setTimeout(async () => {
            try {
                if (userData.isActive) {
                    logActivity(`🏁 ${label} firing`);
                    await claimAchievements();
                }
            } catch (error) {
                logActivity(`⚠️ ${label} error: ${error.message}`);
            }
        }, delay);
        
        userData._achTimers.push(timer);
        logActivity(`⏰ ${label} scheduled for ${when.toUTCString()}`);
    };
    
    scheduleClaim(claim1, 'Achievements #1 (Start+5m)');
    scheduleClaim(claim2, 'Achievements #2 (+5h)');
    scheduleClaim(claim3, 'Achievements #3 (End-5m)');
    
    // Schedule rollover for next day
    const rolloverTime = addMinutes(effectiveEnd, 2);
    const rolloverDelay = Math.max(rolloverTime.getTime() - Date.now(), 1000);
    
    userData._dailyRolloverTimer = setTimeout(() => {
        logActivity('🔁 Daily rollover - scheduling next day');
        scheduleDailyPlan();
    }, rolloverDelay);
}

// Initialize application
async function initializeApp() {
    try {
        console.log('🚀 INITIALIZING SINGLE USER APPLICATION...');
        
        // Refresh token
        await refreshToken();
        
        // Wait a bit then start operations
        setTimeout(() => {
            logActivity('🚀 Starting operations after token refresh');
            
            // Schedule daily plan
            scheduleDailyPlan();
            
            // Check funds
            checkFunds();
            
            // Start continuous operations
            startContinuousOperations();
        }, 60000);
        
        console.log('✅ Application initialized successfully');
        
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
    }
}

// Continuous operations
function startContinuousOperations() {
    console.log('🚀 Starting continuous operations...');
    
    // Spin operations - check every 30 seconds
    setInterval(async () => {
        if (userData.isActive && isWithinActiveWindow()) {
            if (!userData.nextSpinTime || new Date() >= new Date(userData.nextSpinTime)) {
                await executeSpin();
            }
        }
    }, 30000);
    
    // Funds check during active windows - every 2 hours
    setInterval(async () => {
        if (isWithinActiveWindow() && userData.isActive) {
            await checkFunds();
        }
    }, 2 * 60 * 60 * 1000);
}

// ============================================
// API ROUTES
// ============================================

// Get user data for dashboard
app.get('/api/user', (req, res) => {
    // Create safe copy without timer objects
    const safeData = { ...userData };
    delete safeData._achTimers;
    delete safeData._dailyRolloverTimer;
    
    // Convert dates to ISO strings for UI
    if (safeData._effectiveStartUTC instanceof Date) {
        safeData._effectiveStartUTC = safeData._effectiveStartUTC.toISOString();
    }
    if (safeData._effectiveEndUTC instanceof Date) {
        safeData._effectiveEndUTC = safeData._effectiveEndUTC.toISOString();
    }
    
    res.json(safeData);
});

// Get activity logs
app.get('/api/activity', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(userData.logs.slice(0, limit));
});

// Get debug logs
app.get('/api/debug-logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(debugLogs.slice(0, limit));
});

// Manual triggers
app.post('/api/refresh', async (req, res) => {
    const success = await refreshToken();
    res.json({ success, message: success ? 'Token refreshed' : 'Refresh failed' });
});

app.post('/api/spin', async (req, res) => {
    const result = await executeSpin();
    res.json({ success: !!result, result });
});

app.post('/api/claim-achievements', async (req, res) => {
    const claimed = await claimAchievements();
    res.json({ success: claimed > 0, claimed });
});

app.post('/api/check-funds', async (req, res) => {
    const funds = await checkFunds();
    res.json({ success: funds !== null, funds });
});

// ============================================
// PROXY ENDPOINTS FOR MANUAL TOOLS
// ============================================

// Manual spin endpoint with buy spin logic
app.post('/api/proxy/manual-spin', async (req, res) => {
    try {
        if (!userData.jwtToken) {
            return res.status(401).json({ error: 'No JWT token available' });
        }
        
        const result = await executeManualSpin();
        res.json(result);
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Multiple manual spins
app.post('/api/proxy/multiple-spins', async (req, res) => {
    try {
        const { count = 1 } = req.body;
        
        if (!userData.jwtToken) {
            return res.status(401).json({ error: 'No JWT token available' });
        }
        
        const results = [];
        let successful = 0;
        let failed = 0;
        
        // First, check initial funds
        const initialFunds = await checkFunds();
        
        for (let i = 0; i < count; i++) {
            try {
                logActivity(`🔄 Manual spin ${i + 1}/${count} starting...`);
                const result = await executeManualSpin();
                results.push({
                    spin: i + 1,
                    success: result.success,
                    prize: result.prize,
                    prizeId: result.prizeId,
                    timestamp: new Date().toISOString()
                });
                
                if (result.success) {
                    successful++;
                } else {
                    failed++;
                }
                
                // Add delay between spins (2.7 seconds as in original)
                if (i < count - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2700));
                }
                
            } catch (error) {
                results.push({
                    spin: i + 1,
                    success: false,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                failed++;
            }
        }
        
        // Check final funds
        const finalFunds = await checkFunds();
        
        // Calculate statistics
        const fundsSpent = initialFunds - finalFunds;
        const silverPerSpin = successful > 0 ? fundsSpent / successful : 0;
        const totalSilverValue = count * 1000; // Assuming each spin costs 1000 silver worth
        const returnPercentage = totalSilverValue > 0 ? ((totalSilverValue - fundsSpent) / totalSilverValue) * 100 : 0;
        
        res.json({
            success: true,
            summary: {
                totalRequested: count,
                successful,
                failed,
                initialFunds,
                finalFunds,
                fundsSpent,
                silverPerSpin,
                returnPercentage: returnPercentage.toFixed(2)
            },
            results
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Proxy for pack operations
app.get('/api/proxy/packs', async (req, res) => {
    try {
        if (!userData.jwtToken) {
            return res.status(401).json({ error: 'No JWT token available' });
        }
        
        const headers = { 'x-user-jwt': userData.jwtToken };
        const url = `${CONFIG.BASE_URL_PACKS}/user?page=1&categoryIds=1`;
        
        const result = await makeAPIRequest(url, 'GET', headers);
        
        if (result.success) {
            res.json(result.data);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/proxy/open-pack', async (req, res) => {
    try {
        const { packId } = req.body;
        
        if (!userData.jwtToken) {
            return res.status(401).json({ error: 'No JWT token available' });
        }
        
        const headers = {
            'x-user-jwt': userData.jwtToken,
            'Content-Type': 'application/json'
        };
        
        const url = 'https://api.kolex.gg/api/v1/packs/open2';
        const data = { categoryId: 1, packId };
        
        const result = await makeAPIRequest(url, 'POST', headers, data);
        
        if (result.success) {
            res.json(result.data);
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}`);
    console.log(`🛠️  Manual tools available at http://localhost:${PORT}/tools.html`);
    initializeApp();
});
