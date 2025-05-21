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

// 日誌記錄函數
function logToFile(message) {
    fs.appendFileSync('server.log', `${new Date().toISOString()} - ${message}\n`);
}

// Helper function to validate ICCID
function isValidICCID(iccid) {
    return /^[0-9]{19,20}$/.test(iccid);
}

// Login function with improved error handling
async function login(page, retryCount = 0, maxRetries = 2) {
    if (isLoginInProgress) {
        console.log('Login already in progress, waiting...');
        logToFile('Login already in progress, waiting...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        return;
    }

    isLoginInProgress = true;
    try {
        console.log('Attempting to log in to the target system...');
        logToFile('Attempting to log in to the target system...');
        
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        
        await page.type('input[name="user_id"]', LOGIN_CREDENTIALS.username);
        await page.type('input[name="password"]', LOGIN_CREDENTIALS.password);
        await page.click('input[type="submit"]');
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch((err) => {
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
            return login(page, retryCount + 1, maxRetries);
        }

        throw new Error(`Login failed after ${maxRetries} retries: ${error.message}`);
    } finally {
        isLoginInProgress = false;
    }
}

// Query endpoint with improved error handling
app.post('/api/query-sim', async (req, res) => {
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

    console.log(`[Real API] Querying ICCID: ${iccid}`);
    logToFile(`[Real API] Querying ICCID: ${iccid}`);
    
    let browser;
    let responseData = '';
    let page;

    try {
        console.log('Launching Puppeteer browser...');
        logToFile('Launching Puppeteer browser...');
        browser = await puppeteer.launch({ 
            headless: true, 
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--disable-accelerated-2d-canvas',
                '--no-zygote'
            ],
            timeout: 60000,
            userDataDir: '/opt/render/.cache/puppeteer',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        });
        
        console.log('Opening new page...');
        logToFile('Opening new page...');
        page = await browser.newPage();
        await page.setDefaultNavigationTimeout(60000);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setViewport({ width: 1280, height: 720 });
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
        });

        if (response.status() === 500) {
            console.error('Server returned 500 error, clearing session...');
            logToFile('Server returned 500 error, clearing session...');
            sessionCookies = [];
            lastLoginTime = 0;
            throw new Error('Invalid ICCID: The server cannot process this ICCID format');
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
        }, iccid);

        try {
            console.log('Waiting for displayBill to load...');
            logToFile('Waiting for displayBill to load...');
            await page.waitForFunction(
                'document.querySelector("#displayBill div div table:nth-of-type(3) tbody tr:nth-child(3) td:nth-child(1)")',
                { timeout: 90000 }
            );
        } catch (err) {
            console.error('Timeout waiting for displayBill to load:', err.message);
            logToFile(`Timeout waiting for displayBill to load: ${err.message}`);
            const content = await page.content();
            if (content.includes('HTTP Status 500') || content.includes('StringIndexOutOfBoundsException')) {
                sessionCookies = [];
                lastLoginTime = 0;
                throw new Error('Invalid ICCID: The server cannot process this ICCID format');
            }
            if (content.includes('無效') || content.includes('無此資料')) {
                throw new Error('No data found for this ICCID');
            }
            throw err; // Re-throw unexpected errors
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
            await page.goto(`${API_URL}?dat=${iccid}`, { waitUntil: 'networkidle2' });
            await page.evaluate((iccid) => {
                if (typeof loading === 'function') {
                    loading('prepaid_enquiry_details.jsp', 'displayBill', 'dat', iccid, 'loader');
                }
            }, iccid);
            
            console.log('Waiting for displayBill after re-login...');
            logToFile('Waiting for displayBill after re-login...');
            await page.waitForFunction(
                'document.querySelector("#displayBill div div table:nth-of-type(3) tbody tr:nth-child(3) td:nth-child(1)")',
                { timeout: 90000 }
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
            throw new Error('ICCID輸入錯誤');
        }

        res.json(result);
    } catch (error) {
        console.error('Query failed:', error.message);
        logToFile(`Query failed: ${error.message}, Stack: ${error.stack}`);
        
        if (error.message.includes('Invalid ICCID') || error.message.includes('No data found') || 
            error.message.includes('session') || error.message.includes('login') || 
            error.message.includes('HTTP Status 500') || error.message.includes('ICCID輸入錯誤')) {
            sessionCookies = [];
            lastLoginTime = 0;
        }

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
            suggestion = '請重新輸入';
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
                await page.close();
            }
            if (browser) {
                console.log('Closing browser...');
                logToFile('Closing browser...');
                await browser.close();
            }
        } catch (e) {
            console.error('Error closing browser:', e.message);
            logToFile(`Error closing browser: ${e.message}`);
        }
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
    logToFile(`Server started at http://0.0.0.0:${PORT}`);
});