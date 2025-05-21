const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const https = require('https');
const iconv = require('iconv-lite');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
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
const LOGIN_ACTION_URL = `${BASE_URL}/crm/logon.jsp`;
const API_URL = `${BASE_URL}/crm/prepaid_enquiry_action_load.jsp`;
const LOGIN_CREDENTIALS = {
    username: 'RF001',
    password: 'R1900F'
};

let sessionCookies = [];
let lastLoginTime = 0;
let isLoginInProgress = false;
const errorCounts = new Map();

// 限制並發 Puppeteer 實例的佇列
const puppeteerQueue = queue(async (task, callback) => {
    await task();
    callback();
}, 1);

// 日誌記錄函數
function logToFile(message) {
    try {
        fs.appendFileSync('/tmp/server.log', `${new Date().toISOString()} - ${message}\n`);
    } catch (err) {
        console.error('Failed to write to log file:', err.message);
    }
}

// Helper function to validate ICCID
function isValidICCID(iccid) {
    return /^[0-9]{19,20}$/.test(iccid);
}

// 清理 SingletonLock 文件
function cleanSingletonLock() {
    const lockFile = '/tmp/puppeteer_cache/SingletonLock';
    try {
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
            console.log('Cleaned SingletonLock file');
            logToFile('Cleaned SingletonLock file');
        }
    } catch (err) {
        console.error('Failed to clean SingletonLock:', err.message);
        logToFile(`Failed to clean SingletonLock: ${err.message}`);
    }
}

// Login function with improved error handling
async function login(page, retryCount = 0, maxRetries = 3) {
    if (isLoginInProgress) {
        console.log('Login already in progress, waiting...');
        logToFile('Login already in progress, waiting...');
        await new Promise(resolve => setTimeout(resolve, 10000)); // 增加等待時間
        return;
    }

    isLoginInProgress = true;
    try {
        console.log(`Navigating to login URL: ${LOGIN_URL}`);
        logToFile(`Navigating to login URL: ${LOGIN_URL}`);
        
        const response = await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 }); // 增加超時
        if (!response.ok()) {
            throw new Error(`Failed to load login page, status: ${response.status()}`);
        }

        // 等待輸入框可見，確保頁面穩定
        await page.waitForSelector('input[name="user_id"]', { visible: true, timeout: 30000 });
        await page.waitForSelector('input[name="password"]', { visible: true, timeout: 30000 });

        console.log('Typing login credentials...');
        logToFile('Typing login credentials...');
        await page.type('input[name="user_id"]', LOGIN_CREDENTIALS.username, { delay: 100 }); // 增加輸入延遲
        await page.type('input[name="password"]', LOGIN_CREDENTIALS.password, { delay: 100 });
        await page.click('input[type="submit"]');
        
        console.log('Waiting for navigation after login...');
        logToFile('Waiting for navigation after login...');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch((err) => {
            console.log('Navigation timeout, checking if login was successful...');
            logToFile(`Navigation timeout: ${err.message}`);
        });

        const cookies = await page.cookies();
        sessionCookies = cookies
            .filter(c => c.name === 'JSESSIONID' && c.value.length > 10)
            .map(c => `${c.name}=${c.value}`);

        if (sessionCookies.length === 0) {
            throw new Error('Unable to obtain valid session cookies');
        }

        const content = await page.content();
        const $ = cheerio.load(content);
        if ($('body').text().includes('無效') || $('body').text().includes('錯誤') || $('body').text().includes('失敗')) {
            throw new Error('Login failed: Response contains error indicators');
        }

        console.log('Login successful. Obtained cookies:', sessionCookies);
        logToFile(`Login successful. Obtained cookies: ${sessionCookies}`);
        lastLoginTime = Date.now();
        return true;
    } catch (error) {
        console.error('Login failed:', error.message);
        logToFile(`Login failed: ${error.message}, Stack: ${error.stack}`);
        sessionCookies = [];

        if (retryCount < maxRetries) {
            console.log(`Retrying login (${retryCount + 1}/${maxRetries})...`);
            logToFile(`Retrying login (${retryCount + 1}/${maxRetries})...`);
            // 在重試前關閉頁面並重新創建
            if (page) {
                await page.close().catch(() => {});
            }
            page = await page.browser().newPage();
            return login(page, retryCount + 1, maxRetries);
        }

        throw new Error(`Login failed after ${maxRetries} retries: ${error.message}`);
    } finally {
        isLoginInProgress = false;
    }
}

// Query endpoint with improved error handling
app.post('/api/query-sim', async (req, res) => {
    puppeteerQueue.push(async () => {
        const { iccid } = req.body;
        
        if (!iccid) {
            console.log('ICCID is empty');
            logToFile('ICCID is empty');
            return res.status(400).json({ 
                error: 'ICCID cannot be empty',
                suggestion: 'Please enter a valid ICCID number'
            });
        }

        if (!isValidICCID(iccid)) {
            console.log(`Invalid ICCID format: ${iccid}`);
            logToFile(`Invalid ICCID format: ${iccid}`);
            return res.status(400).json({ 
                error: 'Invalid ICCID format',
                suggestion: 'ICCID should be 19-20 digits long and contain only numbers'
            });
        }

        // 檢查錯誤查詢次數
        const errorCount = errorCounts.get(iccid) || 0;
        if (errorCount >= 3) {
            console.log(`Too many failed attempts for ICCID: ${iccid}`);
            logToFile(`Too many failed attempts for ICCID: ${iccid}`);
            return res.status(429).json({
                error: 'Too many failed attempts',
                suggestion: 'Please try a different ICCID or wait before retrying'
            });
        }

        console.log(`[Real API] Querying ICCID: ${iccid}`);
        logToFile(`[Real API] Querying ICCID: ${iccid}`);
        
        let browser;
        let responseData = '';
        let page;

        try {
            // 清理 SingletonLock
            cleanSingletonLock();

            // Log environment variables for debugging
            console.log('PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);
            console.log('Checking Chrome path exists:', fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable'));
            logToFile(`PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);

            console.log('Launching Puppeteer browser...');
            logToFile('Launching Puppeteer browser...');
            browser = await puppeteer.launch({ 
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--single-process',
                    '--disable-accelerated-2d-canvas',
                    '--no-zygote',
                    '--disable-background-networking',
                    '--disable-background-timer-throttling',
                    '--disable-renderer-backgrounding',
                    '--disable-extensions', // 禁用擴展
                    '--disable-sync' // 禁用同步
                ],
                timeout: 60000,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
                userDataDir: '/tmp/puppeteer_cache'
            }).catch(err => {
                throw new Error(`Failed to launch Puppeteer browser: ${err.message}`);
            });
            
            console.log('Opening new page...');
            logToFile('Opening new page...');
            page = await browser.newPage();
            await page.setDefaultNavigationTimeout(60000);
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
            await page.setViewport({ width: 640, height: 480 });

            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'zh-TW,zh-CN;q=0.9,zh;q=0.8',
                'Upgrade-Insecure-Requests': '1',
                'X-Requested-With': 'XMLHttpRequest'
            });

            await page.setRequestInterception(true);
            page.on('request', request => {
                console.log('Request:', request.method(), request.url());
                logToFile(`Request: ${request.method()} ${request.url()}`);
                request.continue();
            });
            
            page.on('response', async response => {
                const url = response.url();
                console.log('Response:', response.status(), url);
                logToFile(`Response: ${response.status()} ${url}`);
                
                if (url.includes('prepaid_enquiry_details.jsp')) {
                    try {
                        const text = await response.text();
                        console.log('AJAX response content (first 500 chars):', text.substring(0, 500));
                        logToFile(`AJAX response content (first 500 chars): ${text.substring(0, 500)}`);
                    } catch (err) {
                        console.error('Failed to read AJAX response:', err.message);
                        logToFile(`Failed to read AJAX response: ${err.message}`);
                    }
                }
            });

            page.on('console', msg => {
                console.log('Browser console:', msg.text());
                logToFile(`Browser console: ${msg.text()}`);
            });

            if (sessionCookies.length === 0 || Date.now() - lastLoginTime > 30 * 60 * 1000) {
                console.log('Session expired or not set, initiating login...');
                logToFile('Session expired or not set, initiating login...');
                await login(page);
            }

            console.log('Setting cookies...');
            logToFile('Setting cookies...');
            const cookies = sessionCookies.map(c => {
                const [name, value] = c.split('=');
                return { name, value, domain: 'api2021.multibyte.com', path: '/crm' };
            });
            await page.setCookie(...cookies);

            console.log(`Navigating to: ${API_URL}?dat=${iccid}`);
            logToFile(`Navigating to: ${API_URL}?dat=${iccid}`);
            const response = await page.goto(`${API_URL}?dat=${iccid}`, { 
                waitUntil: 'networkidle2', 
                timeout: 60000 
            }).catch(err => {
                throw new Error(`Failed to navigate to API URL: ${err.message}`);
            });

            // 提前檢查 500 錯誤
            if (response.status() === 500) {
                console.error('Server returned 500 error');
                logToFile('Server returned 500 error');
                const errorContent = await response.text();
                logToFile(`Full 500 error response: ${errorContent.substring(0, 1000)}`);
                let errorMessage = 'Invalid ICCID: The server cannot process this ICCID';
                if (errorContent.includes('StringIndexOutOfBoundsException')) {
                    errorMessage = 'Invalid ICCID: Incorrect format or length';
                } else if (errorContent.includes('No data found')) {
                    errorMessage = 'No data found for this ICCID';
                }
                errorCounts.set(iccid, (errorCounts.get(iccid) || 0) + 1);
                throw new Error(errorMessage);
            }

            console.log('Evaluating page script...');
            logToFile('Evaluating page script...');
            await page.evaluate((iccid) => {
                window.scrollTo(0, document.body.scrollHeight);
                if (typeof loading === 'function') {
                    loading('prepaid_enquiry_details.jsp', 'displayBill', 'dat', iccid, 'loader');
                } else {
                    console.error('loading function not defined');
                }
            }, iccid).catch(err => {
                throw new Error(`Failed to evaluate page script: ${err.message}`);
            });

            // 檢查頁面是否已包含錯誤
            const initialContent = await page.content();
            if (initialContent.includes('HTTP Status 500') || initialContent.includes('StringIndexOutOfBoundsException')) {
                console.error('Page contains 500 error');
                logToFile('Page contains 500 error');
                errorCounts.set(iccid, (errorCounts.get(iccid) || 0) + 1);
                throw new Error('Invalid ICCID: The server cannot process this ICCID');
            }

            try {
                console.log('Waiting for displayBill to load...');
                logToFile('Waiting for displayBill to load...');
                await page.waitForFunction(
                    'document.querySelector("#displayBill div div table:nth-of-type(3) tbody tr:nth-child(3) td:nth-child(1)")',
                    { timeout: 30000 }
                );
            } catch (err) {
                console.error('Timeout waiting for displayBill to load:', err.message);
                logToFile(`Timeout waiting for displayBill to load: ${err.message}`);
                const content = await page.content();
                if (content.includes('HTTP Status 500') || content.includes('StringIndexOutOfBoundsException')) {
                    errorCounts.set(iccid, (errorCounts.get(iccid) || 0) + 1);
                    throw new Error('Invalid ICCID: The server cannot process this ICCID');
                }
                if (content.includes('無效') || content.includes('無此資料')) {
                    errorCounts.set(iccid, (errorCounts.get(iccid) || 0) + 1);
                    throw new Error('No data found for this ICCID');
                }
                throw err;
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

            console.log('Extracting page content...');
            logToFile('Extracting page content...');
            responseData = await page.content();
            console.log('Query response (first 500 chars):', responseData.substring(0, 500));
            logToFile(`Query response (first 500 chars): ${responseData.substring(0, 500)}`);

            if (responseData.includes('請登錄') || responseData.includes('login') || responseData.includes('未授權')) {
                console.log('Session invalid, attempting to re-login...');
                logToFile('Session invalid, attempting to re-login...');
                sessionCookies = [];
                lastLoginTime = 0;
                await login(page);
                
                console.log('Setting new cookies after re-login...');
                logToFile('Setting new cookies after re-login...');
                const newCookies = sessionCookies.map(c => {
                    const [name, value] = c.split('=');
                    return { name, value, domain: 'api2021.multibyte.com', path: '/crm' };
                });
                await page.setCookie(...newCookies);
                
                console.log(`Re-navigating to: ${API_URL}?dat=${iccid}`);
                logToFile(`Re-navigating to: ${API_URL}?dat=${iccid}`);
                const reResponse = await page.goto(`${API_URL}?dat=${iccid}`, { waitUntil: 'networkidle2' }).catch(err => {
                    throw new Error(`Failed to re-navigate to API URL: ${err.message}`);
                });
                
                if (reResponse.status() === 500) {
                    console.error('Server returned 500 error after re-login');
                    logToFile('Server returned 500 error after re-login');
                    const errorContent = await reResponse.text();
                    logToFile(`Full 500 error response after re-login: ${errorContent.substring(0, 1000)}`);
                    errorCounts.set(iccid, (errorCounts.get(iccid) || 0) + 1);
                    throw new Error('Invalid ICCID: The server cannot process this ICCID');
                }

                console.log('Waiting for displayBill after re-login...');
                logToFile('Waiting for displayBill after re-login...');
                await page.waitForFunction(
                    'document.querySelector("#displayBill div div table:nth-of-type(3) tbody tr:nth-child(3) td:nth-child(1)")',
                    { timeout: 30000 }
                );
                
                await new Promise(resolve => setTimeout(resolve, 2000));
                responseData = await page.content();
            }

            const $ = cheerio.load(responseData);

            const extractText = (selector, defaultValue = 'N/A') => {
                try {
                    const element = $(selector);
                    const text = element.length ? element.text().trim() : defaultValue;
                    console.log(`Extracted text for selector "${selector}":`, text);
                    logToFile(`Extracted text for selector "${selector}": ${text}`);
                    return text || defaultValue;
                } catch (e) {
                    console.error(`Error extracting text for selector "${selector}":`, e.message);
                    logToFile(`Error extracting text for selector "${selector}": ${e.message}`);
                    return defaultValue;
                }
            };

            console.log('Extracting query result...');
            logToFile('Extracting query result...');
            const result = {
                iccid: iccid,
                cardType: extractText('#displayBill div div table:nth-of-type(1) > tbody > tr:nth-child(2) > td:nth-child(1) > div'),
                location: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(1) > div'),
                status: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(3) > div'),
                activationTime: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(4) > div'),
                cancellationTime: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(5) > div'),
                usageMB: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(12) > div', '0'),
                rawData: responseData.substring(0, 500)
            };

            console.log('Query result:', result);
            logToFile(`Query result: ${JSON.stringify(result)}`);

            if (result.cardType === 'N/A' && result.location === 'N/A' && result.status === 'N/A') {
                console.log('Invalid ICCID detected, returning error');
                logToFile('Invalid ICCID detected, returning error');
                errorCounts.set(iccid, (errorCounts.get(iccid) || 0) + 1);
                throw new Error('ICCID輸入錯誤');
            }

            // 查詢成功，清空錯誤計數
            errorCounts.delete(iccid);
            res.json(result);
        } catch (error) {
            console.error('Query failed:', error.message);
            logToFile(`Query failed: ${error.message}, Stack: ${error.stack}`);
            
            let statusCode = 500;
            let errorMessage = error.message;
            let suggestion = 'Please try again later or contact support';
            
            if (error.message.includes('Invalid ICCID')) {
                statusCode = 400;
                suggestion = 'Please enter a valid 19-20 digit ICCID number';
            } else if (error.message.includes('No data found')) {
                statusCode = 404;
                suggestion = 'No data found for this ICCID, please verify the number';
            } else if (error.message.includes('timeout') || error.message.includes('Timeout')) {
                errorMessage = 'Request timeout, the server is taking too long to respond';
                suggestion = 'Please try again in a few minutes';
            } else if (error.message.includes('ICCID輸入錯誤')) {
                statusCode = 400;
                suggestion = '請重新輸入正確的 ICCID';
            } else if (error.message.includes('Target closed') || error.message.includes('detached Frame')) {
                errorMessage = 'Login failed due to server error';
                suggestion = 'Please try again or contact support';
            }

            // 僅在登錄相關錯誤時清除會話
            if (error.message.includes('session') || error.message.includes('login') || error.message.includes('未授權') || error.message.includes('Target closed')) {
                sessionCookies = [];
                lastLoginTime = 0;
            }

            res.status(statusCode).json({ 
                error: errorMessage,
                suggestion: suggestion,
                details: error.stack,
                rawData: responseData ? responseData.substring(0, 500) : 'No response data'
            });
        } finally {
            try {
                if (page) {
                    console.log('Closing page...');
                    logToFile('Closing page...');
                    await page.close().catch(() => {});
                }
                if (browser) {
                    console.log('Closing browser...');
                    logToFile('Closing browser...');
                    await browser.close().catch(() => {});
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (e) {
                console.error('Error closing browser:', e.message);
                logToFile(`Error closing browser: ${e.message}`);
            }
            cleanSingletonLock();
        }
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
    logToFile(`Server started at http://0.0.0.0:${PORT}`);
});