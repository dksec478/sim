const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { queue } = require('async');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const BASE_URL = 'http://api2021.multibyte.com:57842';
const LOGIN_URL = `${BASE_URL}/crm/index.html`;
const API_URL = `${BASE_URL}/crm/prepaid_enquiry_action_load.jsp`;
const LOGIN_CREDENTIALS = { username: 'RF001', password: 'R1900F' };

let sessionCookies = [];
let lastLoginTime = 0;
let isLoginInProgress = false;
const errorCounts = new Map();

// 限制並發查詢
const puppeteerQueue = queue(async (task, callback) => {
    await task();
    callback();
}, 1);

// 日誌記錄
const logToFile = (message) => {
    try {
        fs.appendFileSync('/tmp/server.log', `${new Date().toISOString()} - ${message}\n`);
    } catch (err) {
        console.error('Log error:', err.message);
    }
};

// 驗證 ICCID
const isValidICCID = (iccid) => /^[0-9]{19,20}$/.test(iccid);

// 清理快取目錄並限制大小
const cleanPuppeteerCache = () => {
    const cacheDir = '/tmp/puppeteer_cache';
    try {
        if (fs.existsSync(cacheDir)) {
            const stats = fs.statSync(cacheDir);
            if (stats.size > 50 * 1024 * 1024) { // 限制 50MB
                logToFile('Cache dir too large, cleaning...');
                fs.rmSync(cacheDir, { recursive: true, force: true });
            } else {
                fs.rmSync(cacheDir, { recursive: true, force: true });
            }
        }
        fs.mkdirSync(cacheDir, { recursive: true });
        logToFile(`Created ${cacheDir}`);
    } catch (err) {
        console.error('Cache cleanup error:', err.message);
        logToFile(`Cache cleanup error: ${err.message}`);
    }
};

// 創建瀏覽器
const createBrowser = async (retryCount = 0) => {
    cleanPuppeteerCache();
    try {
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
            timeout: 30000,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
            userDataDir: '/tmp/puppeteer_cache'
        });
    } catch (err) {
        if (retryCount < 1 && err.message.includes('SingletonLock')) {
            logToFile('Retrying browser launch...');
            return createBrowser(retryCount + 1);
        }
        throw new Error(`Browser launch failed: ${err.message}`);
    }
};

// 登錄
const login = async (page, retryCount = 0) => {
    if (isLoginInProgress) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        return;
    }

    isLoginInProgress = true;
    try {
        logToFile(`Navigating to ${LOGIN_URL}`);
        const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (!response.ok()) throw new Error(`Login page failed, status: ${response.status()}`);

        await page.waitForSelector('input[name="user_id"]', { visible: true, timeout: 60000 });
        await page.waitForSelector('input[name="password"]', { visible: true, timeout: 60000 });
        await page.waitForFunction('document.activeElement !== null', { timeout: 60000 }); // 確保可交互

        logToFile('Typing credentials...');
        await page.type('input[name="user_id"]', LOGIN_CREDENTIALS.username, { delay: 300 });
        await page.type('input[name="password"]', LOGIN_CREDENTIALS.password, { delay: 300 });
        await page.click('input[type="submit"]', { delay: 100 });

        logToFile('Waiting for navigation...');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => logToFile('Navigation timeout'));

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

        if (retryCount < 2) {
            logToFile(`Retrying login (${retryCount + 1}/2)...`);
            const browser = await createBrowser();
            await page.close().catch(() => {});
            page = await browser.newPage();
            return login(page, retryCount + 1);
        }
        throw error;
    } finally {
        isLoginInProgress = false;
    }
};

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

        logToFile(`Querying ICCID: ${iccid}`);
        let browser, page, responseData = '';

        try {
            browser = await createBrowser();
            page = await browser.newPage();
            await page.setDefaultNavigationTimeout(30000);
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124');
            await page.setViewport({ width: 320, height: 240 });

            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,*/*;q=0.8',
                'Accept-Language': 'zh-TW,zh-CN;q=0.9',
                'Upgrade-Insecure-Requests': '1'
            });

            page.on('close', () => logToFile('Page closed unexpectedly'));
            page.on('pageerror', err => logToFile(`Page error: ${err.message}`));

            if (!sessionCookies.length || Date.now() - lastLoginTime > 25 * 60 * 1000) { // 25 分鐘重置會話
                await login(page);
            }

            logToFile('Setting cookies...');
            await page.setCookie(...sessionCookies.map(c => {
                const [name, value] = c.split('=');
                return { name, value, domain: 'api2021.multibyte.com', path: '/crm' };
            }));

            logToFile(`Navigating to: ${API_URL}?dat=${iccid}`);
            const response = await page.goto(`${API_URL}?dat=${iccid}`, { waitUntil: 'networkidle2', timeout: 30000 });

            if (response.status() === 500) {
                errorCounts.set(iccid, errorCount + 1);
                throw new Error('Invalid ICCID: Server cannot process this ICCID');
            }

            logToFile('Evaluating page script...');
            await page.evaluate(iccid => {
                window.scrollTo(0, document.body.scrollHeight);
                if (typeof loading === 'function') loading('prepaid_enquiry_details.jsp', 'displayBill', 'dat', iccid, 'loader');
            }, iccid);

            const initialContent = await page.content();
            if (initialContent.includes('HTTP Status 500') || initialContent.includes('StringIndexOutOfBoundsException')) {
                errorCounts.set(iccid, errorCount + 1);
                throw new Error('Invalid ICCID: Server cannot process this ICCID');
            }

            logToFile('Waiting for displayBill...');
            await page.waitForFunction(
                'document.querySelector("#displayBill div div table:nth-of-type(3) tbody tr:nth-child(3) td:nth-child(1)")',
                { timeout: 30000 }
            );

            await new Promise(resolve => setTimeout(resolve, 2000));
            responseData = await page.content();
            const $ = cheerio.load(responseData);

            if (responseData.includes('請登錄') || responseData.includes('未授權')) {
                sessionCookies = [];
                lastLoginTime = 0;
                await login(page);
                await page.setCookie(...sessionCookies.map(c => {
                    const [name, value] = c.split('=');
                    return { name, value, domain: 'api2021.multibyte.com', path: '/crm' };
                }));

                const reResponse = await page.goto(`${API_URL}?dat=${iccid}`, { waitUntil: 'networkidle2', timeout: 30000 });
                if (reResponse.status() === 500) {
                    errorCounts.set(iccid, errorCount + 1);
                    throw new Error('Invalid ICCID: Server cannot process this ICCID');
                }

                await page.waitForFunction(
                    'document.querySelector("#displayBill div div table:nth-of-type(3) tbody tr:nth-child(3) td:nth-child(1)")',
                    { timeout: 30000 }
                );
                responseData = await page.content();
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
                      'Server connection failed' : error.message,
                suggestion,
                details: error.stack
            });
        } finally {
            try {
                if (page) await page.close();
                if (browser) {
                    await browser.close();
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (e) {
                logToFile(`Close error: ${e.message}`);
            }
            cleanPuppeteerCache();
        }
    });
});

app.listen(PORT, '0.0.0.0', () => logToFile(`Server started at http://0.0.0.0:${PORT}`));