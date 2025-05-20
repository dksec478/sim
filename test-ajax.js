const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const https = require('https');

const BASE_URL = 'http://api2021.multibyte.com:57842';
const LOGIN_URL = `${BASE_URL}/crm/index.html`;
const LOGIN_ACTION_URL = `${BASE_URL}/crm/logon.jsp`;
const DETAILS_URL = `${BASE_URL}/crm/prepaid_enquiry_details.jsp`;
const ICCID = '89852243101001988345';

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 20000,
    responseType: 'arraybuffer'
});

async function login() {
    try {
        console.log('Fetching login page:', LOGIN_URL);
        const loginPageResponse = await axiosInstance.get(LOGIN_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'zh-TW,zh-CN;q=0.9,zh;q=0.8',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            maxRedirects: 0
        });

        const html = iconv.decode(Buffer.from(loginPageResponse.data), 'big5');
        const $ = cheerio.load(html);
        const formFields = {};
        $('form input').each((i, input) => {
            const name = $(input).attr('name');
            const value = $(input).val();
            if (name && value) formFields[name] = value;
        });

        const formData = new URLSearchParams();
        formData.append('user_id', 'RF001');
        formData.append('password', 'R1900F');
        formData.append('Submit', '登入');
        Object.keys(formFields).forEach(key => {
            if (key !== 'user_id' && key !== 'password' && key !== 'Submit' && key !== 'button') {
                formData.append(key, formFields[key]);
            }
        });

        const cookies = loginPageResponse.headers['set-cookie'] || [];
        console.log('Submitting login request to:', LOGIN_ACTION_URL);
        const loginResponse = await axiosInstance.post(LOGIN_ACTION_URL, formData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookies.join('; '),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Origin': BASE_URL,
                'Referer': LOGIN_URL,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'zh-TW,zh-CN;q=0.9,zh;q=0.8',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            maxRedirects: 5,
            validateStatus: status => status >= 200 && status < 400
        });

        const sessionCookies = (loginResponse.headers['set-cookie'] || cookies)
            .filter(c => c && c.length > 10 && !c.includes('deleted'))
            .map(c => c.split(';')[0].trim());

        if (sessionCookies.length === 0) {
            throw new Error('Unable to obtain valid session cookies');
        }

        console.log('Login successful. Cookies:', sessionCookies);
        return sessionCookies;
    } catch (error) {
        console.error('Login failed:', error.message);
        throw error;
    }
}

async function queryDetails() {
    try {
        const cookies = await login();
        console.log(`Querying details for ICCID: ${ICCID}`);
        
        // Construct URL, try adding potential extra params
        const queryUrl = `${DETAILS_URL}?dat=${ICCID}`; // Add &sessionId=... if discovered
        const headers = {
            'Cookie': cookies.join('; '),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': `${BASE_URL}/crm/prepaid_enquiry_action_load.jsp?dat=${ICCID}`,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-TW,zh-CN;q=0.9,zh;q=0.8',
            'Connection': 'keep-alive'
        };

        console.log('Sending AJAX request to:', queryUrl, 'Headers:', headers);
        const response = await axiosInstance.get(queryUrl, {
            headers,
            responseType: 'arraybuffer'
        });

        const responseData = iconv.decode(Buffer.from(response.data), 'big5');
        console.log('Details response (first 2000 chars):', responseData.substring(0, 2000));

        const $ = cheerio.load(responseData);
        const extractText = (selector, defaultValue = 'N/A') => {
            try {
                const element = $(selector);
                return element.length ? element.text().trim() : defaultValue;
            } catch (e) {
                return defaultValue;
            }
        };

        const result = {
            iccid: ICCID,
            productName: extractText('div > table > tbody > tr:nth-child(2) > td > span > div > div > table:nth-child(1) > tbody > tr:nth-child(2) > td:first-child > div'),
            location: extractText('div > table > tbody > tr:nth-child(2) > td > span > div > div > table:nth-child(3) > tbody > tr:nth-child(3) > td:first-child > div'),
            status: extractText('div > table > tbody > tr:nth-child(2) > td > span > div > div > table:nth-child(3) > tbody > tr:nth-child(3) > td:nth-child(3) > div'),
            activationTime: extractText('div > table > tbody > tr:nth-child(2) > td > span > div > div > table:nth-child(3) > tbody > tr:nth-child(3) > td:nth-child(4) > div'),
            usageMB: extractText('div > table > tbody > tr:nth-child(2) > td > span > div > div > table:nth-child(3) > tbody > tr:nth-child(3) > td:nth-child(12) > div', '0'),
            rawData: responseData.substring(0, 2000)
        };

        console.log('Result:', result);
        return result;
    } catch (error) {
        console.error('Query details failed:', error.message);
        console.error('Error details:', error.response ? iconv.decode(Buffer.from(error.response.data), 'big5').substring(0, 2000) : 'No response data');
        throw error;
    }
}

queryDetails().catch(err => console.error('Test failed:', err.message));