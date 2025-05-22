const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { queue } = require('async');
const rateLimit = require('express-rate-limit');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 速率限制中間件（每分鐘 5 次請求）
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 分鐘
    max: 5, // 每個 IP 最多 5 次
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
const queryCache = new Map(); // 查詢結果緩存

// 限制並發查詢
const puppeteerQueue = queue(async (task, callback) => {
    await task();
    callback();
}, 1);

// 日誌記錄
const logToFile = (message) => {
    try {
        fs.appendFileSync('/tmp/server.log', `${new Date().toISOString()} - ${message}\n`);
        console.log(message);
    } catch (err) {
        console.error('Log error:', err.message);
    }
};

// 驗證 ICCID
const isValidICCID = (iccid) => /^[0-9]{19,20}$/.test(iccid);

// 清理快取目錄
const cleanPuppeteerCache = () => {
    const cacheDir = '/tmp/puppeteer_cache';
    try {
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            logToFile(`Cleaned ${cacheDir}`);
        }
        fs.mkdirSync(cacheDir, { recursive: true });
        logToFile(`Created ${cacheDir}`);
    } catch (err) {
        logToFile(`Cache cleanup error: ${err.message}`);
    }
};

// 創建瀏覽器（僅用於登錄）
const createBrowser = async (retryCount = 0) => {
    cleanPuppeteerCache();
    logToFile('Launching Puppeteer browser for login...');
    try {
        const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
        if (!fs.existsSync(chromePath)) {
            throw new Error(`Chrome not found at ${chromePath}`);
        }
        logToFile(`Using Chrome at ${chromePath}`);

        return await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote',
                '--disable-extensions',
                '--disable-sync',
                '--no-first-run'
            ],
            timeout: 10000,
            executablePath: chromePath,
            userDataDir: '/tmp/puppeteer_cache'
        });
    } catch (err) {
        logToFile(`Browser launch failed: ${err.message}`);
        if (retryCount < 1 && err.message.includes('SingletonLock')) {
            logToFile('Retrying browser launch...');
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

        logToFile(`Navigating to ${LOGIN_URL}`);
        const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
        if (!response.ok()) throw new Error(`Login page failed, status: ${response.status()}`);

        await page.waitForSelector('input[name="user_id"]', { visible: true, timeout: 10000 });
        await page.waitForSelector('input[name="password"]', { visible: true, timeout: 10000 });

        logToFile('Typing credentials...');
        await page.type('input[name="user_id"]', LOGIN_CREDENTIALS.username, { delay: 200 });
        await page.type('input[name="password"]', LOGIN_CREDENTIALS.password, { delay: 200 });
        await page.click('input[type="submit"]', { delay: 100 });

        logToFile('Waiting for navigation...');
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

        logToFile('Login successful');
        lastLoginTime = Date.now();
        return true;
    } catch (error) {
        logToFile(`Login failed: ${error.message}`);
        sessionCookies = [];
        throw error;
    } finally {
        try {
            if (page) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // 延遲關閉
                await page.close();
            }
            if (browser) await browser.close();
        } catch (e) {
            logToFile(`Close error: ${e.message}`);
        }
        isLoginInProgress = false;
    }
};

// 健康檢查端點
app.get('/health', (req, res) => {
    logToFile('Health check requested');
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

        if (!iccid) {
            return res.status(400).json({ error: 'ICCID cannot be empty', suggestion: 'Please enter a valid ICCID number' });
        }

        if (!isValidICCID(iccid)) {
            return res.status(400).json({ error: 'Invalid ICCID format', suggestion: 'ICCID must be 19-20 digits' });
        }

        const errorCount = errorCounts.get(iccid) || 0;
        if (errorCount >= 3) {
            return res.status(429).json({ error: 'Too many failed attempts', suggestion: 'Try a different ICCID or wait' });
        }

        // 檢查緩存
        if (queryCache.has(iccid)) {
            logToFile(`Returning cached result for ICCID: ${iccid}`);
            return res.json(queryCache.get(iccid));
        }

        logToFile(`Querying ICCID: ${iccid}`);
        let responseData = '';

        try {
            if (!sessionCookies.length || Date.now() - lastLoginTime > 25 * 60 * 1000) {
                await login();
            }

            logToFile(`Sending API request for ICCID: ${iccid}`);
            let response;
            for (let retry = 0; retry < 2; retry++) {
                try {
                    response = await axios.get(`${API_URL}?dat=${iccid}`, {
                        headers: {
                            'Cookie': sessionCookies.join('; '),
                            'Accept': 'text/html,*/*;q=0.8',
                            'Accept-Language': 'zh-TW,zh-CN;q=0.9',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124'
                        },
                        timeout: 10000
                    });
                    break;
                } catch (err) {
                    if (err.response && err.response.status === 429) {
                        const retryAfter = err.response.headers['retry-after'];
                        const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000; // 默認 60 秒
                        logToFile(`Rate limit hit, waiting ${waitTime}ms`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else if (retry === 1) {
                        throw err;
                    }
                }
            }

            if (!response || response.status !== 200) {
                errorCounts.set(iccid, errorCount + 1);
                throw new Error('Invalid ICCID: Server cannot process this ICCID');
            }

            responseData = response.data;
            const $ = cheerio.load(responseData);

            if (responseData.includes('請登錄') || responseData.includes('未授權')) {
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
                    timeout: 10000
                });
                if (response.status !== 200) {
                    errorCounts.set(iccid, errorCount + 1);
                    throw new Error('Invalid ICCID: Server cannot process this ICCID');
                }
                responseData = response.data;
                $ = cheerio.load(responseData);
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
                errorCounts.set(iccid, errorCount + 1);
                throw new Error('ICCID輸入錯誤');
            }

            // 緩存結果（有效期 1 小時）
            queryCache.set(iccid, result);
            setTimeout(() => queryCache.delete(iccid), 60 * 60 * 1000);

            errorCounts.delete(iccid);
            res.json(result);
        } catch (error) {
            logToFile(`Query failed: ${error.message}`);
            const statusCode = error.message.includes('Invalid ICCID') || error.message.includes('ICCID輸入錯誤') ? 400 :
                              error.message.includes('No data found') ? 404 : 500;

            const suggestion = error.message.includes('Invalid ICCID') ? 'Please enter a valid 19-20 digit ICCID number' :
                              error.message.includes('No data found') ? 'No data found for this ICCID, please verify the number' :
                              error.message.includes('timeout') ? 'Please try again in a few minutes' :
                              error.message.includes('ICCID輸入錯誤') ? '請重新輸入正確的 ICCID' :
                              error.message.includes('SingletonLock') ? 'Please try again in a few seconds' :
                              'Please wait 10 seconds and try again or contact support';

            if (error.message.includes('session') || error.message.includes('login') || error.message.includes('未授權') || 
                error.message.includes('Target closed') || error.message.includes('Connection closed') || error.message.includes('SingletonLock')) {
                sessionCookies = [];
                lastLoginTime = 0;
            }

            res.status(statusCode).json({ 
                error: error.message.includes('Target closed') || error.message.includes('Connection closed') ? 
                      'Server unavailable' : error.message,
                suggestion,
                details: error.stack
            });
        }
    });
});

// 啟動前檢查
try {
    logToFile('Checking /tmp permissions...');
    fs.accessSync('/tmp', fs.constants.W_OK);
    logToFile('/tmp is writable');
} catch (err) {
    logToFile(`Error: /tmp not writable: ${err.message}`);
}

// 預加載登錄
(async () => {
    try {
        await login();
        logToFile('Preloaded login successful');
    } catch (err) {
        logToFile(`Preload login failed: ${err.message}`);
    }
})();

app.listen(PORT, '0.0.0.0', () => {
    logToFile(`Server started at http://0.0.0.0:${PORT}`);
    logToFile(`Memory usage: ${JSON.stringify(process.memoryUsage())}`);
});