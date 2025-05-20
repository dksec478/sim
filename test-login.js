const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const https = require('https');
const iconv = require('iconv-lite');

// Configuration
const BASE_URL = 'http://api2021.multibyte.com:57842';
const LOGIN_URL = `${BASE_URL}/crm/index.html`;
const LOGIN_ACTION_URL = `${BASE_URL}/crm/logon.jsp`; // Correct POST URL
const LOGIN_CREDENTIALS = {
    username: 'RF001',
    password: 'R1900F'
};

// Create axios instance, ignoring SSL certificate verification (for testing only)
const axiosInstance = axios.create({
    httpsAgent: new https.Agent({  
        rejectUnauthorized: false
    }),
    timeout: 20000,
    responseType: 'arraybuffer' // Handle binary response for Big5
});

// Method 1: HTTP-based login with axios
async function loginWithAxios() {
    console.log('\n=== Testing login with axios ===');
    try {
        // 1. Get login page to extract cookies and form fields
        console.log('Fetching login page:', LOGIN_URL);
        const loginPageResponse = await axiosInstance.get(LOGIN_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
                'Connection': 'keep-alive'
            },
            maxRedirects: 0
        });

        // Decode Big5 response
        const html = iconv.decode(Buffer.from(loginPageResponse.data), 'big5');
        console.log('Login page status:', loginPageResponse.status);
        console.log('Login page cookies:', loginPageResponse.headers['set-cookie'] || 'None');
        console.log('Login page content (first 500 chars):', html.substring(0, 500));

        // Extract form fields using cheerio
        const $ = cheerio.load(html);
        const formFields = {};
        $('form input').each((i, input) => {
            const name = $(input).attr('name');
            const value = $(input).val();
            if (name && value) formFields[name] = value;
        });
        console.log('Detected form fields:', formFields);
        console.log('Form HTML:', $('form').html());

        // 2. Prepare form data
        const formData = new URLSearchParams();
        formData.append('user_id', LOGIN_CREDENTIALS.username);
        formData.append('password', LOGIN_CREDENTIALS.password);
        formData.append('Submit', '登入');
        
        // Add any hidden fields
        Object.keys(formFields).forEach(key => {
            if (key !== 'user_id' && key !== 'password' && key !== 'Submit' && key !== 'button') {
                formData.append(key, formFields[key]);
            }
        });
        console.log('Form data:', formData.toString());

        // 3. Submit login request to correct URL
        const cookies = loginPageResponse.headers['set-cookie'] || [];
        console.log('Submitting login request to:', LOGIN_ACTION_URL);
        const loginResponse = await axiosInstance.post(LOGIN_ACTION_URL, formData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookies.join('; '),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Origin': BASE_URL,
                'Referer': LOGIN_URL,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
                'Connection': 'keep-alive'
            },
            maxRedirects: 5,
            validateStatus: status => status >= 200 && status < 400
        });

        // Decode response
        const responseHtml = iconv.decode(Buffer.from(loginResponse.data), 'big5');
        console.log('Login response status:', loginResponse.status);
        console.log('Login response cookies:', loginResponse.headers['set-cookie'] || 'None');
        console.log('Login response headers:', loginResponse.headers);
        console.log('Login response content (first 500 chars):', responseHtml.substring(0, 500));

        // Check for error messages
        if (responseHtml.includes('無效') || responseHtml.includes('錯誤') || responseHtml.includes('失敗')) {
            throw new Error('Login failed: Response contains error indicators');
        }

        // 4. Check for cookies
        const sessionCookies = (loginResponse.headers['set-cookie'] || cookies)
            .filter(c => c && c.length > 10 && !c.includes('deleted'))
            .map(c => c.split(';')[0].trim());

        if (sessionCookies.length === 0) {
            throw new Error('Unable to obtain valid session cookies');
        }

        console.log('Success! Obtained cookies:', sessionCookies);
        return sessionCookies;
    } catch (error) {
        console.error('Axios login failed:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', iconv.decode(Buffer.from(error.response.data), 'big5').substring(0, 500));
        }
        return null;
    }
}

// Method 2: Headless browser login with puppeteer
async function loginWithPuppeteer() {
    console.log('\n=== Testing login with puppeteer ===');
    let browser;
    try {
        // Launch headless browser
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        // Navigate to login page
        console.log('Navigating to login page:', LOGIN_URL);
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
        
        // Log page content
        const pageContent = await page.content();
        console.log('Login page content (first 500 chars):', pageContent.substring(0, 500));
        
        // Log form HTML
        const formHtml = await page.evaluate(() => document.querySelector('form')?.outerHTML || 'No form found');
        console.log('Form HTML:', formHtml);

        // Fill login form using id selectors
        console.log('Filling login form...');
        await page.type('#user_id', LOGIN_CREDENTIALS.username);
        await page.type('#password', LOGIN_CREDENTIALS.password);
        
        // Submit form
        console.log('Submitting login form...');
        await page.click('input[name="Submit"]');

        // Wait for navigation or timeout
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {
            console.log('No navigation detected, checking page content...');
        });

        // Check for login success or errors
        const postLoginContent = await page.content();
        console.log('Post-login content (first 500 chars):', postLoginContent.substring(0, 500));
        if (postLoginContent.includes('無效') || postLoginContent.includes('錯誤') || postLoginContent.includes('失敗')) {
            throw new Error('Login failed: Response contains error indicators');
        }

        // Extract cookies
        const cookies = await page.cookies();
        const sessionCookies = cookies.map(c => `${c.name}=${c.value}`);
        
        console.log('Cookies after login:', sessionCookies);
        if (sessionCookies.length === 0) {
            throw new Error('Unable to obtain valid session cookies');
        }

        console.log('Success! Obtained cookies:', sessionCookies);
        return sessionCookies;
    } catch (error) {
        console.error('Puppeteer login failed:', error.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

// Main function to run tests
async function testLogin() {
    console.log('Starting login tests...\n');

    // Test axios login
    let cookies = await loginWithAxios();
    if (cookies) {
        console.log('Axios login succeeded! Cookies:', cookies);
        return;
    }

    // Fallback to puppeteer if axios fails
    console.log('\nAxios login failed, trying puppeteer...');
    cookies = await loginWithPuppeteer();
    if (cookies) {
        console.log('Puppeteer login succeeded! Cookies:', cookies);
    } else {
        console.error('Both login methods failed. Please check the logs and website behavior.');
    }
}

// Run the test
testLogin().catch(err => {
    console.error('Test failed:', err.message);
});