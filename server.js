const express = require('express');
const axios = require('axios').create({ http2: true });
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { queue } = require('async');
const rateLimit = require('express-rate-limit');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 10000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 速率限制中間件（每分鐘 15 次）
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    message: { error: 'Too many requests, please try again later', suggestion: '請等待1分鐘後重試' }
});
app.use('/api/query-sim', limiter);

// Configuration
const BASE_URL = 'http://api2021.multibyte.com:57842';
const LOGIN_URL = `${BASE_URL}/crm/index.html`;
const LOGIN_ACTION_URL = `${BASE_URL}/crm/logon.jsp`;
const API_URL = `${BASE_URL}/crm/prepaid_enquiry_action_load.jsp`;
const LOGIN_CREDENTIALS = { username: 'RF001', password: 'R1900F' };

let sessionCookies = [];
let lastLoginTime = 0;
let isLoginInProgress = false;
const errorCounts = new Map();
const queryCache = new Map();

// 限制並發查詢
const puppeteerQueue = queue(async (task, callback) => {
    await task();
    callback();
}, 1);

// 日誌記錄
const logToFile = async (message) => {
    try {
        await Promise.all([
            fs.appendFile('/tmp/server.log', `${new Date().toISOString()} - ${message}\n`),
            fs.appendFile('/app/server.log', `${new Date().toISOString()} - ${message}\n`)
        ]);
        console.log(message);
    } catch (err) {
        console.error('Log error:', err.message);
    }
};

// 驗證 ICCID
const isValidICCID = async (iccid) => {
    const isValid = /^[0-9]{19,20}$/.test(iccid);
    if (!isValid) await logToFile(`Invalid ICCID format: ${iccid}`);
    return isValid;
};

// 清理快取目錄
const cleanPuppeteerCache = async () => {
    const cacheDir = '/tmp/puppeteer_cache';
    try {
        if (fsSync.existsSync(cacheDir)) {
            await fs.rm(cacheDir, { recursive: true, force: true });
            await logToFile(`Cleaned ${cacheDir}`);
        }
        await fs.mkdir(cacheDir, { recursive: true });
        await logToFile(`Created ${cacheDir}`);
    } catch (err) {
        await logToFile(`Cache cleanup error: ${err.message}`);
    }
};

// 創建瀏覽器
const createBrowser = async (retryCount = 0) => {
    await cleanPuppeteerCache();
    await logToFile('Launching Puppeteer browser...');
    try {
        const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
        if (!fsSync.existsSync(chromePath)) {
            throw new Error(`Chrome not found at ${chromePath}`);
        }
        await logToFile(`Using Chrome at ${chromePath}`);

        return await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ],
            timeout: 10000,
            executablePath: chromePath,
            userDataDir: '/tmp/puppeteer_cache'
        });
    } catch (err) {
        await logToFile(`Browser launch failed: ${err.message}`);
        if (retryCount < 1 && err.message.includes('SingletonLock')) {
            await logToFile('Retrying browser launch...');
            return createBrowser(retryCount + 1);
        }
        throw new Error(`Browser launch failed: ${err.message}`);
    }
};

// 登錄並獲取 Cookie
const login = async () => {
    if (isLoginInProgress) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        return;
    }

    isLoginInProgress = true;
    let browser, page;
    try {
        browser = await createBrowser();
        page = await browser.newPage();
        await page.setDefaultNavigationTimeout(10000);

        await logToFile(`Navigating to ${LOGIN_URL}`);
        const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
        if (!response.ok()) throw new Error(`Login page failed, status: ${response.status()}`);

        await page.waitForSelector('input[name="user_id"]', { visible: true, timeout: 10000 });
        await page.waitForSelector('input[name="password"]', { visible: true, timeout: 10000 });

        await logToFile('Typing credentials...');
        await page.type('input[name="user_id"]', LOGIN_CREDENTIALS.username, { delay: 200 });
        await page.type('input[name="password"]', LOGIN_CREDENTIALS.password, { delay: 200 });
        await page.click('input[type="submit"]', { delay: 100 });

        await logToFile('Waiting for navigation...');
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => logToFile('Navigation timeout'));

        const cookies = await page.cookies();
        sessionCookies = cookies
            .filter(c => c.name === 'JSESSIONID' && c.value.length > 10)
            .map(c => `${c.name}=${c.value}`);

        if (!sessionCookies.length) throw new Error('No valid session cookies');
        const content = cheerio.load(await page.content());
        if (content('body').text().includes('無效') || content('body').text().includes('錯誤')) {
            throw new Error('Login failed: Invalid credentials');
        }

        await logToFile(`Login successful, JSESSIONID: ${sessionCookies.join('; ')}`);
        lastLoginTime = Date.now();
        return true;
    } catch (error) {
        await logToFile(`Login failed: ${error.message}`);
        sessionCookies = [];
        throw error;
    } finally {
        try {
            if (page) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.close();
            }
            if (browser) await browser.close();
        } catch (e) {
            await logToFile(`Close error: ${e.message}`);
        }
        isLoginInProgress = false;
    }
};

// 模擬瀏覽器查詢（若 axios 失敗）
const queryWithPuppeteer = async (iccid) => {
    let browser, page;
    try {
        browser = await createBrowser();
        page = await browser.newPage();
        await page.setDefaultNavigationTimeout(10000);

        await page.setCookie(...sessionCookies.map(c => ({
            name: c.split('=')[0],
            value: c.split('=')[1],
            domain: 'api2021.multibyte.com',
            path: '/crm'
        })));

        await logToFile(`Navigating to ${API_URL}?dat=${iccid} with Puppeteer`);
        await page.goto(`${API_URL}?dat=${iccid}`, { waitUntil: 'networkidle0', timeout: 10000 });

        await logToFile('Waiting for displayBill...');
        await page.waitForSelector('#displayBill div div table', { timeout: 10000 }).catch(async (err) => {
            await logToFile(`Selector not found for ICCID ${iccid}: ${err.message}`);
            throw new Error('Invalid ICCID: No data found for this ICCID');
        });

        const responseData = await page.content();
        await logToFile(`Puppeteer response (first 1000 chars): ${responseData.substring(0, 1000)}`);
        const $ = cheerio.load(responseData);

        const extractText = (selector, defaultValue = 'N/A') => {
            const text = $(selector).text().trim() || defaultValue;
            logToFile(`Extracted "${selector}": ${text}`);
            return text;
        };

        const result = {
            iccid,
            cardType: extractText('#displayBill div div table:nth-of-type(1) > tbody > tr:nth-child(2) > td:nth-child(1) > div'),
            location: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(1) > div'),
            status: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(3) > div'),
            activationTime: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(4) > div'),
            cancellationTime: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(5) > div'),
            usageMB: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(12) > div', '0'),
            rawData: responseData.substring(0, 500)
        };

        // 檢查是否所有關鍵字段均為 N/A
        if (result.cardType === 'N/A' && result.location === 'N/A' && result.status === 'N/A') {
            await logToFile(`No valid data for ICCID ${iccid}`);
            throw new Error('Invalid ICCID: No valid data returned');
        }

        return result;
    } catch (error) {
        await logToFile(`Puppeteer query failed for ICCID ${iccid}: ${error.message}`);
        throw error;
    } finally {
        try {
            if (page) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.close();
            }
            if (browser) await browser.close();
        } catch (e) {
            await logToFile(`Close error: ${e.message}`);
        }
    }
};

// 健康檢查端點
app.get('/health', async (req, res) => {
    await logToFile(`Health check requested from ${req.ip}`);
    res.status(200).json({ 
        status: 'ok', 
        uptime: process.uptime(), 
        memory: process.memoryUsage()
    });
});

// 查詢端點
app.post('/api/query-sim', async (req, res) => {
    puppeteerQueue.push(async () => {
        const { iccid } = req.body;
        await logToFile(`Received query request for ICCID: ${iccid}`);

        if (!iccid) {
            await logToFile('ICCID is empty');
            return res.status(400).json({ error: 'ICCID cannot be empty', suggestion: 'Please enter a valid ICCID number' });
        }

        if (!await isValidICCID(iccid)) {
            return res.status(400).json({ error: 'Invalid ICCID format', suggestion: 'ICCID must be 19-20 digits' });
        }

        const errorCount = errorCounts.get(iccid) || 0;
        if (errorCount >= 3) {
            await logToFile(`Too many failed attempts for ICCID: ${iccid}`);
            return res.status(429).json({ error: 'Too many failed attempts', suggestion: 'Try a different ICCID or wait' });
        }

        // 檢查緩存
        if (queryCache.has(iccid)) {
            await logToFile(`Returning cached result for ICCID: ${iccid}`);
            return res.json(queryCache.get(iccid));
        }

        await logToFile(`Querying ICCID: ${iccid}`);
        let responseData = '';

        try {
            if (!sessionCookies.length || Date.now() - lastLoginTime > 25 * 60 * 1000) {
                await login();
            }

            await logToFile(`Sending API request for ICCID: ${iccid}`);
            let response;
            for (let retry = 0; retry < 3; retry++) {
                try {
                    response = await axios.get(`${API_URL}?dat=${iccid}`, {
                        headers: {
                            'Cookie': sessionCookies.join('; '),
                            'Accept': 'text/html,*/*;q=0.8',
                            'Accept-Language': 'zh-TW,zh-CN;q=0.9',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124'
                        },
                        timeout: 3000
                    });
                    break;
                } catch (err) {
                    if (err.response && err.response.status === 429) {
                        const retryAfter = err.response.headers['retry-after'];
                        const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, retry) * 2000;
                        await logToFile(`Rate limit hit, waiting ${waitTime}ms`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else if (retry === 2) {
                        throw err;
                    }
                }
            }

            if (!response || response.status !== 200) {
                errorCounts.set(iccid, errorCount + 1);
                await logToFile(`API request failed, status: ${response ? response.status : 'unknown'}`);
                throw new Error('Invalid ICCID: Server cannot process this ICCID');
            }

            responseData = response.data;
            await logToFile(`API response (first 1000 chars): ${responseData.substring(0, 1000)}`);
            const $ = cheerio.load(responseData);

            if (responseData.includes('請登錄') || responseData.includes('未授權')) {
                await logToFile('Session invalid, re-logging in...');
                sessionCookies = [];
                lastLoginTime = 0;
                await login();
                response = await axios.get(`${API_URL}?dat=${iccid}`, {
                    headers: {
                        'Cookie': sessionCookies.join('; '),
                        'Accept': 'text/html,*/*;q=0.8',
                        'Accept-Language': 'zh-TW,zh-CN;q=0.9',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124'
                    },
                    timeout: 3000
                });
                if (response.status !== 200) {
                    errorCounts.set(iccid, errorCount + 1);
                    await logToFile(`Retry API request failed, status: ${response.status}`);
                    throw new Error('Invalid ICCID: Server cannot process this ICCID');
                }
                responseData = response.data;
                await logToFile(`Retry API response (first 1000 chars): ${responseData.substring(0, 1000)}`);
                $ = cheerio.load(responseData);
            }

            // 檢查 #displayBill 是否有數據
            if (!$('#displayBill div div table').length) {
                await logToFile('No data in #displayBill, falling back to Puppeteer...');
                const result = await queryWithPuppeteer(iccid);

                // 緩存結果（有效期 8 小時）
                queryCache.set(iccid, result);
                setTimeout(() => queryCache.delete(iccid), 8 * 60 * 60 * 1000);
                if (queryCache.size > 2000) queryCache.clear();

                errorCounts.delete(iccid);
                return res.json(result);
            }

            const extractText = (selector, defaultValue = 'N/A') => {
                const text = $(selector).text().trim() || defaultValue;
                logToFile(`Extracted "${selector}": ${text}`);
                return text;
            };

            const result = {
                iccid,
                cardType: extractText('#displayBill div div table:nth-of-type(1) > tbody > tr:nth-child(2) > td:nth-child(1) > div'),
                location: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(1) > div'),
                status: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(3) > div'),
                activationTime: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(4) > div'),
                cancellationTime: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(5) > div'),
                usageMB: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(12) > div', '0'),
                rawData: responseData.substring(0, 500)
            };

            if (result.cardType === 'N/A' && result.location === 'N/A' && result.status === 'N/A') {
                await logToFile('No valid data in axios response, falling back to Puppeteer...');
                const puppeteerResult = await queryWithPuppeteer(iccid);
                result = puppeteerResult;
            }

            // 緩存結果（有效期 8 小時）
            queryCache.set(iccid, result);
            setTimeout(() => queryCache.delete(iccid), 8 * 60 * 60 * 1000);
            if (queryCache.size > 2000) queryCache.clear();

            errorCounts.delete(iccid);
            res.json(result);
        } catch (error) {
            await logToFile(`Query failed for ICCID ${iccid}: ${error.message}`);
            const statusCode = error.message.includes('Invalid ICCID') || error.message.includes('ICCID輸入錯誤') ? 400 :
                              error.message.includes('No data found') ? 404 : 500;

            const suggestion = error.message.includes('Invalid ICCID') ? '請輸入正確的19-20位ICCID號碼' :
                              error.message.includes('No data found') ? '此ICCID無數據，請驗證號碼' :
                              error.message.includes('timeout') ? '請在幾分鐘後重試' :
                              error.message.includes('ICCID輸入錯誤') ? '請重新輸入正確的 ICCID' :
                              error.message.includes('SingletonLock') ? '請在幾秒後重試' :
                              '請等待10秒後重試或聯繫支持';

            if (error.message.includes('session') || error.message.includes('login') || error.message.includes('未授權') || 
                error.message.includes('Target closed') || error.message.includes('Connection closed') || error.message.includes('SingletonLock')) {
                sessionCookies = [];
                lastLoginTime = 0;
            }

            res.status(statusCode).json({ 
                error: error.message.includes('Invalid ICCID') ? 'Invalid ICCID' : 
                       error.message.includes('Target closed') || error.message.includes('Connection closed') ? 
                       'Server unavailable' : error.message,
                suggestion,
                details: error.stack
            });
        }
    });
});

// 啟動前檢查
(async () => {
    try {
        await logToFile('Checking /tmp permissions...');
        await fs.access('/tmp', fsSync.constants.W_OK);
        await logToFile('/tmp is writable');
    } catch (err) {
        await logToFile(`Error: /tmp not writable: ${err.message}`);
    }

    // 預加載登錄
    try {
        await login();
        await logToFile('Preloaded login successful');
    } catch (err) {
        await logToFile(`Preload login failed: ${err.message}`);
    }
})();

app.listen(PORT, '0.0.0.0', async () => {
    await logToFile(`Server started at http://0.0.0.0:${PORT}`);
    await logToFile(`Memory usage: ${JSON.stringify(process.memoryUsage())}`);
});