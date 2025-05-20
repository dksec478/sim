const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const https = require('https');
const iconv = require('iconv-lite');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

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

// Create axios instance
const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 20000,
    responseType: 'arraybuffer'
});

let sessionCookies = [];
let lastLoginTime = 0;

// Login function using puppeteer to simulate browser behavior
async function login(page, retryCount = 0, maxRetries = 2) {
    try {
        console.log('Attempting to log in to the target system...');
        
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        
        await page.type('input[name="user_id"]', LOGIN_CREDENTIALS.username);
        await page.type('input[name="password"]', LOGIN_CREDENTIALS.password);
        await page.click('input[type="submit"]');
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
            console.log('No navigation detected, checking page content...');
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
        lastLoginTime = Date.now();
        return true;
    } catch (error) {
        console.error('Login failed:', error.message);
        sessionCookies = [];

        if (retryCount < maxRetries) {
            console.log(`Retrying login (${retryCount + 1}/${maxRetries})...`);
            return login(page, retryCount + 1, maxRetries);
        }

        throw new Error(`Login failed after ${maxRetries} retries: ${error.message}`);
    }
}

// Query endpoint (using puppeteer)
app.post('/api/query-sim', async (req, res) => {
    const { iccid } = req.body;
    
    if (!iccid) {
        return res.status(400).json({ error: 'ICCID cannot be empty' });
    }

    console.log(`[Real API] Querying ICCID: ${iccid}`);
    
    let browser;
    let responseData = '';

    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
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
            console.log('Network request:', request.url(), 'Method:', request.method(), 'Headers:', request.headers());
            request.continue();
        });
        page.on('response', async response => {
            const url = response.url();
            console.log('Network response:', url, 'Status:', response.status());
            if (url.includes('prepaid_enquiry_details.jsp')) {
                console.log('AJAX response received:', url, 'Status:', response.status());
                try {
                    const text = await response.text();
                    console.log('AJAX response content (full):', text);
                    if (response.status() !== 200) {
                        throw new Error(`Server returned ${response.status()}: ${text}`);
                    }
                } catch (err) {
                    console.error('Failed to read AJAX response:', err.message);
                    throw err;
                }
            }
        });
        page.on('console', msg => {
            console.log('Browser console:', msg.text());
        });

        if (sessionCookies.length === 0 || Date.now() - lastLoginTime > 30 * 60 * 1000) {
            await login(page);
        }

        const cookies = sessionCookies.map(c => {
            const [name, value] = c.split('=');
            return { name, value, domain: 'api2021.multibyte.com', path: '/crm' };
        });
        await page.setCookie(...cookies);

        console.log(`Navigating to: ${API_URL}?dat=${iccid}`);
        await page.goto(`${API_URL}?dat=${iccid}`, { waitUntil: 'networkidle2', timeout: 30000 });

        await page.evaluate((iccid) => {
            window.scrollTo(0, document.body.scrollHeight);
            if (typeof loading === 'function') {
                loading('prepaid_enquiry_details.jsp', 'displayBill', 'dat', iccid, 'loader');
            } else {
                console.error('loading function not defined');
            }
        }, iccid);

        await page.waitForFunction(
            'document.querySelector("#displayBill div div table:nth-of-type(3) tbody tr:nth-child(3) td:nth-child(1)")',
            { timeout: 90000 }
        ).catch(err => {
            console.error('Timeout waiting for displayBill to load with data table:', err.message);
        });

        // Add delay to ensure DOM stability
        await new Promise(resolve => setTimeout(resolve, 1000));

        responseData = await page.content();
        console.log('Query response (first 2000 chars):', responseData.substring(0, 2000));

        const displayBillContent = await page.evaluate(() => {
            const element = document.querySelector('#displayBill');
            return element ? element.innerHTML : 'No displayBill found';
        });
        console.log('displayBill HTML:', displayBillContent.substring(0, 2000));

        if (responseData.includes('請登錄') || responseData.includes('login') || responseData.includes('未授權')) {
            console.log('Session invalid, attempting to re-login...');
            await login(page);
            await page.setCookie(...cookies);
            await page.goto(`${API_URL}?dat=${iccid}`, { waitUntil: 'networkidle2' });
            await page.evaluate((iccid) => {
                if (typeof loading === 'function') {
                    loading('prepaid_enquiry_details.jsp', 'displayBill', 'dat', iccid, 'loader');
                }
            }, iccid);
            await page.waitForFunction(
                'document.querySelector("#displayBill div div table:nth-of-type(3) tbody tr:nth-child(3) td:nth-child(1)")',
                { timeout: 90000 }
            ).catch(err => {
                console.error('Timeout waiting for displayBill to load with data table after re-login:', err.message);
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            responseData = await page.content();
            console.log('Retry query response (first 2000 chars):', responseData.substring(0, 2000));
            const retryDisplayBillContent = await page.evaluate(() => {
                const element = document.querySelector('#displayBill');
                return element ? element.innerHTML : 'No displayBill found';
            });
            console.log('Retry displayBill HTML:', retryDisplayBillContent.substring(0, 2000));
        }

        if (responseData.includes('無效') || responseData.includes('錯誤') || responseData.includes('無此資料')) {
            throw new Error('Query failed: Response contains error indicators (e.g., invalid ICCID or no data found)');
        }

        const $ = cheerio.load(responseData);

        const extractText = (selector, defaultValue = '沒有') => {
            try {
                const element = $(selector);
                const text = element.length ? element.text().trim() : defaultValue;
                console.log(`Extracted text for selector "${selector}":`, text);
                return text;
            } catch (e) {
                console.error(`Error extracting text for selector "${selector}":`, e.message);
                return defaultValue;
            }
        };

        const result = {
            iccid: iccid,
            cardType: extractText('#displayBill div div table:nth-of-type(1) > tbody > tr:nth-child(2) > td:nth-child(1) > div'),
            location: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(1) > div'),
            status: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(3) > div'),
            activationTime: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(4) > div'),
            cancellationTime: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(5) > div'),
            usageMB: extractText('#displayBill div div table:nth-of-type(3) > tbody > tr:nth-child(3) > td:nth-child(12) > div', '0'),
            rawData: responseData.substring(0, 2000)
        };

        console.log('Backend response JSON:', result);

        if (result.cardType === '沒有' && result.location === '沒有' && result.status === '沒有' && result.activationTime === '沒有' && result.cancellationTime === '沒有') {
            console.error('Failed to extract data. Available tables:', $('#displayBill div div table').length);
            console.error('Table HTML (first table):', $('#displayBill div div table').first().html()?.substring(0, 500) || 'No tables found');
            throw new Error('Unable to extract valid data from response, page structure may have changed');
        }

        res.json(result);
    } catch (error) {
        console.error('Query failed:', error.message);
        res.status(500).json({ 
            error: 'Query failed',
            details: error.message.includes('String index out of range') 
                ? 'Server error: Invalid or non-existent ICCID. Please verify the ICCID and try again.'
                : error.message,
            suggestion: 'Please check if the ICCID is correct or contact the server administrator',
            rawData: responseData.substring(0, 2000) || 'No response data'
        });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});